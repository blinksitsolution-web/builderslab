const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getActiveYear, getYearById } = require("../utils/academicTerm");
const { syncCourseCurriculumForClass } = require("../utils/learningInstances");
const promotionEngine = require("../utils/promotionEngine");
const { instructorHasClassAccess } = require("../utils/instructorScope");

const router = express.Router();

// ============================================================
// Promotion Engine.
// Every action here only ever touches users.class_id / users.campus /
// users.current_academic_year_id / users.status — it never writes to any
// term-scoped academic table (grades, projects, payments, attendance,
// examinations, etc.), so "preserve all previous academic history" is true
// by construction: nothing about a learner's past terms is reachable from
// these routes. Each action is also logged to promotion_log for audit.
// ============================================================

function logPromotion({ learnerId, action, fromYearId, toYearId, details, performedBy }) {
  db.prepare(
    `INSERT INTO promotion_log (id, learner_id, action, from_year_id, to_year_id, details, performed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), learnerId, action, fromYearId || null, toYearId || null, details ? JSON.stringify(details) : null, performedBy);
}

function learnerById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ? AND role = 'learner'").get(id);
}

// Both of these used to look across the *entire* classes table by
// sort_order alone, with no programme_id filter. Since sort_order is only
// meaningful as a promotion path *within one programme* (Foundation=1 ->
// Framework=2 -> Skyline=3 for Kids STEM; Bootcamp's Weekday/Weekend
// cohorts both happen to be seeded at sort_order 0), an unscoped lookup
// could promote a learner straight into a completely different programme's
// (or even a different Learning Offering Type's) class the moment two
// programmes' Learning Groups shared a sort_order value — exactly the kind
// of cross-offering-type bleed the architecture must prevent. Both now stay
// strictly within `current.programme_id`.
function nextClass(currentClassId) {
  const current = db.prepare("SELECT * FROM classes WHERE id = ?").get(currentClassId);
  if (!current) return null;
  return (
    db
      .prepare("SELECT * FROM classes WHERE sort_order = ? AND programme_id IS ? ORDER BY name ASC")
      .get(current.sort_order + 1, current.programme_id) || null
  );
}

function finalClass(programmeId) {
  return db
    .prepare("SELECT * FROM classes WHERE programme_id IS ? ORDER BY sort_order DESC, name ASC LIMIT 1")
    .get(programmeId);
}

// ------------------------------------------------------------------------
// NOTE (Promotion Subsystem checkpoint, ABRS v2.1 §12): the routes below
// this line (/candidates through /graduate) are the pre-existing, blind
// (non-eligibility-evaluated) bulk actions. /transfer-campus and /graduate
// mutate fields Promotion is constitutionally forbidden from touching as a
// side effect (campus, enrollment status) and /promote-class,
// /promote-learners, /repeat also move current_academic_year_id alongside
// class_id in one action. Per this checkpoint's explicit instruction, none
// of these routes are modified here — they are flagged for a future,
// separately-scoped refactor into their own services. The new,
// constitutionally-scoped Promotion core (policy-driven eligibility,
// level-only mutation, recommendation capture, reversal) is implemented
// further down this file and in utils/promotionEngine.js, and is now the
// intended primary path for evaluating and applying a Programme Level
// change; the legacy routes remain available unchanged for compatibility.
// ------------------------------------------------------------------------

// Admin: learners in a class, for reviewing before promoting/repeating/graduating.
router.get("/candidates", requireAuth, requireRole("admin"), (req, res) => {
  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "classId is required." });
  const learners = db
    .prepare("SELECT id, name, student_code, campus, class_id, status FROM users WHERE role = 'learner' AND class_id = ? ORDER BY name ASC")
    .all(classId);
  res.json({ learners });
});

// Admin: a learner's full promotion history, for audit review.
router.get("/log/:learnerId", requireAuth, requireRole("admin"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, fy.name as from_year_name, ty.name as to_year_name
       FROM promotion_log p
       LEFT JOIN academic_years fy ON fy.id = p.from_year_id
       LEFT JOIN academic_years ty ON ty.id = p.to_year_id
       WHERE p.learner_id = ? ORDER BY p.created_at DESC`
    )
    .all(req.params.learnerId);
  res.json({ history: rows });
});

// Promote an entire class to the next class in the Foundation -> Framework
// -> Skyline sequence. Learners already in the final class can't be
// promoted this way — use /graduate instead.
router.post("/promote-class", requireAuth, requireRole("admin"), (req, res) => {
  const { classId, toYearId } = req.body;
  if (!classId) return res.status(400).json({ error: "classId is required." });
  const target = nextClass(classId);
  if (!target) return res.status(400).json({ error: "This is already the final class — use /graduate for final-year learners." });
  const year = toYearId ? getYearById(toYearId) : getActiveYear();
  if (!year) return res.status(409).json({ error: "No target Academic Year found. Create/activate one first." });

  const learners = db.prepare("SELECT * FROM users WHERE role = 'learner' AND class_id = ?").all(classId);
  const run = db.transaction(() => {
    learners.forEach((learner) => {
      // Capture the learner's active Learning Instance from their primary
      // programme_enrollments row before mutating class_id — mirrors the
      // same audit-context capture in /promote-learners and the constitutional
      // applyPromotion path in utils/promotionEngine.js (§12/§13).
      const primaryEnrollment = db.prepare(
        "SELECT learning_instance_id FROM programme_enrollments WHERE user_id = ? AND is_primary = 1 LIMIT 1"
      ).get(learner.id);
      const learningInstanceId = primaryEnrollment ? primaryEnrollment.learning_instance_id : null;
      db.prepare("UPDATE users SET class_id = ?, current_academic_year_id = ? WHERE id = ?").run(target.id, year.id, learner.id);
      const addedModuleIds = syncCourseCurriculumForClass(learner.id, target.id);
      logPromotion({
        learnerId: learner.id,
        action: "promote",
        fromYearId: learner.current_academic_year_id,
        toYearId: year.id,
        details: { fromClassId: classId, toClassId: target.id, curriculumModulesAdded: addedModuleIds, learningInstanceId },
        performedBy: req.user.id,
      });
    });
  });
  run();
  res.json({ ok: true, promoted: learners.length, toClass: target.name, toYear: year.name });
});

// Promote a specific set of learners, each to the class after their own
// current class (mixed-class selections are fine — each learner's next
// class is resolved individually).
router.post("/promote-learners", requireAuth, requireRole("admin"), (req, res) => {
  const { learnerIds, toYearId } = req.body;
  if (!Array.isArray(learnerIds) || !learnerIds.length) return res.status(400).json({ error: "learnerIds is required." });
  const year = toYearId ? getYearById(toYearId) : getActiveYear();
  if (!year) return res.status(409).json({ error: "No target Academic Year found. Create/activate one first." });

  const results = [];
  const run = db.transaction(() => {
    learnerIds.forEach((learnerId) => {
      const learner = learnerById(learnerId);
      if (!learner) return results.push({ learnerId, ok: false, error: "Learner not found." });
      const target = nextClass(learner.class_id);
      if (!target) return results.push({ learnerId, ok: false, error: "Already in the final class — use /graduate." });
      // Capture the learner's active Learning Instance from their primary
      // programme_enrollments row before mutating class_id — this is the
      // canonical Learning Instance the learner was enrolled in at promotion
      // time, needed for audit/transcript context (§12/§13).
      const primaryEnrollment = db.prepare(
        "SELECT learning_instance_id FROM programme_enrollments WHERE user_id = ? AND is_primary = 1 LIMIT 1"
      ).get(learnerId);
      const learningInstanceId = primaryEnrollment ? primaryEnrollment.learning_instance_id : null;
      db.prepare("UPDATE users SET class_id = ?, current_academic_year_id = ? WHERE id = ?").run(target.id, year.id, learnerId);
      const addedModuleIds = syncCourseCurriculumForClass(learnerId, target.id);
      logPromotion({
        learnerId,
        action: "promote",
        fromYearId: learner.current_academic_year_id,
        toYearId: year.id,
        details: { fromClassId: learner.class_id, toClassId: target.id, curriculumModulesAdded: addedModuleIds, learningInstanceId },
        performedBy: req.user.id,
      });
      results.push({ learnerId, ok: true, toClass: target.name });
    });
  });
  run();
  res.json({ results });
});

// Repeat: learner stays in the same class, but moves into the new Academic
// Year (a fresh set of term-scoped records will accrue under it as the year
// progresses — this route itself creates none).
router.post("/repeat", requireAuth, requireRole("admin"), (req, res) => {
  const { learnerIds, toYearId } = req.body;
  if (!Array.isArray(learnerIds) || !learnerIds.length) return res.status(400).json({ error: "learnerIds is required." });
  const year = toYearId ? getYearById(toYearId) : getActiveYear();
  if (!year) return res.status(409).json({ error: "No target Academic Year found. Create/activate one first." });

  const run = db.transaction(() => {
    learnerIds.forEach((learnerId) => {
      const learner = learnerById(learnerId);
      if (!learner) return;
      db.prepare("UPDATE users SET current_academic_year_id = ? WHERE id = ?").run(year.id, learnerId);
      logPromotion({
        learnerId,
        action: "repeat",
        fromYearId: learner.current_academic_year_id,
        toYearId: year.id,
        details: { classId: learner.class_id },
        performedBy: req.user.id,
      });
    });
  });
  run();
  res.json({ ok: true, count: learnerIds.length });
});

// Transfer learners to a specific class (lateral move — not necessarily the
// "next" class in sequence, e.g. correcting a misplacement).
router.post("/transfer-class", requireAuth, requireRole("admin"), (req, res) => {
  const { learnerIds, toClassId } = req.body;
  if (!Array.isArray(learnerIds) || !learnerIds.length || !toClassId) {
    return res.status(400).json({ error: "learnerIds and toClassId are required." });
  }
  const target = db.prepare("SELECT * FROM classes WHERE id = ?").get(toClassId);
  if (!target) return res.status(404).json({ error: "Target class not found." });

  const run = db.transaction(() => {
    learnerIds.forEach((learnerId) => {
      const learner = learnerById(learnerId);
      if (!learner) return;
      db.prepare("UPDATE users SET class_id = ? WHERE id = ?").run(toClassId, learnerId);
      const addedModuleIds = syncCourseCurriculumForClass(learnerId, toClassId);
      logPromotion({
        learnerId,
        action: "transfer_class",
        details: { fromClassId: learner.class_id, toClassId, curriculumModulesAdded: addedModuleIds },
        performedBy: req.user.id,
      });
    });
  });
  run();
  res.json({ ok: true, count: learnerIds.length, toClass: target.name });
});

// Transfer learners to another campus. Campus determines certificate
// branding (see the Certificate Engine), so this also changes which
// branding profile future-issued certificates for this learner will use.
router.post("/transfer-campus", requireAuth, requireRole("admin"), (req, res) => {
  const { learnerIds, toCampus } = req.body;
  if (!Array.isArray(learnerIds) || !learnerIds.length || !toCampus) {
    return res.status(400).json({ error: "learnerIds and toCampus are required." });
  }
  const campus = db.prepare("SELECT * FROM campuses WHERE name = ? AND active = 1").get(toCampus);
  if (!campus) return res.status(404).json({ error: "Target campus not found or inactive." });

  const run = db.transaction(() => {
    learnerIds.forEach((learnerId) => {
      const learner = learnerById(learnerId);
      if (!learner) return;
      db.prepare("UPDATE users SET campus = ? WHERE id = ?").run(toCampus, learnerId);
      logPromotion({
        learnerId,
        action: "transfer_campus",
        details: { fromCampus: learner.campus, toCampus },
        performedBy: req.user.id,
      });
    });
  });
  run();
  res.json({ ok: true, count: learnerIds.length, toCampus });
});

// Graduate final-year learners. Status is extended (additively — the
// `status` column has never had a DB-level CHECK constraint, see
// schema.sql) with a new 'graduated' value alongside the existing
// active/pending_payment/suspended ones, so nothing that already switches
// on status breaks.
router.post("/graduate", requireAuth, requireRole("admin"), (req, res) => {
  const { learnerIds } = req.body;
  if (!Array.isArray(learnerIds) || !learnerIds.length) return res.status(400).json({ error: "learnerIds is required." });

  const run = db.transaction(() => {
    learnerIds.forEach((learnerId) => {
      const learner = learnerById(learnerId);
      if (!learner) return;
      db.prepare("UPDATE users SET status = 'graduated' WHERE id = ?").run(learnerId);
      logPromotion({
        learnerId,
        action: "graduate",
        fromYearId: learner.current_academic_year_id,
        details: { classId: learner.class_id },
        performedBy: req.user.id,
      });
    });
  });
  run();
  res.json({ ok: true, count: learnerIds.length });
});

// ============================================================
// Promotion Subsystem — constitutional core (ABRS v2.1 §12).
// Every route below only ever: (a) reads existing academic/attendance
// records, (b) writes to promotion_policies / promotion_recommendations /
// promotion_log, or (c) writes users.class_id via promotionEngine's
// applyPromotion/reversePromotion. Nothing here writes to courses,
// learning_instance_courses, enrollments, grades, attendance,
// current_academic_year_id, campus, or any financial/enrollment field.
// ============================================================

// Admin: view a Programme's configured Promotion Policy (or null if none
// configured yet — never a silently-inferred default, per §2.2/§17.1).
router.get("/policy/:programmeId", requireAuth, requireRole("admin"), (req, res) => {
  const programme = db.prepare("SELECT id FROM programmes WHERE id = ?").get(req.params.programmeId);
  if (!programme) return res.status(404).json({ error: "Programme not found." });
  const policy = promotionEngine.getProgrammePromotionPolicy(req.params.programmeId);
  res.json({ policy });
});

// Admin: create/update a Programme's Promotion Policy. This is the only
// place eligibility criteria are ever set — the evaluation engine only
// ever reads this table, never a hardcoded threshold (§2.2).
router.put("/policy/:programmeId", requireAuth, requireRole("admin"), (req, res) => {
  const programme = db.prepare("SELECT id FROM programmes WHERE id = ?").get(req.params.programmeId);
  if (!programme) return res.status(404).json({ error: "Programme not found." });
  const { minAverageScore, minAttendancePercent, requiresInstructorRecommendation, isActive } = req.body;
  const policy = promotionEngine.upsertProgrammePromotionPolicy(req.params.programmeId, {
    minAverageScore,
    minAttendancePercent,
    requiresInstructorRecommendation,
    isActive,
  });
  res.json({ ok: true, policy });
});

// Instructor: submit a promotion recommendation for a learner currently in
// one of the instructor's assigned classes. Scoped to (learner, learner's
// CURRENT class) so a recommendation never silently carries forward to a
// later Programme Level (see utils/promotionEngine.js).
router.post("/recommend", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { learnerId, recommends, note } = req.body;
  if (!learnerId || typeof recommends !== "boolean") {
    return res.status(400).json({ error: "learnerId and a boolean recommends are required." });
  }
  const learner = learnerById(learnerId);
  if (!learner) return res.status(404).json({ error: "Learner not found." });
  if (!learner.class_id) return res.status(409).json({ error: "Learner has no current Programme Level assigned." });

  if (req.user.role === "instructor") {
    if (!instructorHasClassAccess(req.user.id, learner.class_id)) {
      return res.status(403).json({ error: "You are not assigned to this learner's current class." });
    }
  }

  const recommendation = promotionEngine.recordInstructorRecommendation({
    learnerId,
    classId: learner.class_id,
    instructorId: req.user.id,
    recommends,
    note,
  });
  res.json({ ok: true, recommendation });
});

// Evaluate one learner's promotion eligibility against their Programme's
// configured Promotion Policy. Read-only — never mutates anything.
router.get("/eligibility/:learnerId", requireAuth, requireRole("admin", "instructor"), (req, res) => {
  const result = promotionEngine.evaluateLearnerPromotionEligibility(req.params.learnerId);
  res.json(result);
});

// Evaluate every learner currently in a class. Read-only.
router.get("/eligibility", requireAuth, requireRole("admin", "instructor"), (req, res) => {
  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "classId is required." });
  const learners = db.prepare("SELECT id FROM users WHERE role = 'learner' AND class_id = ?").all(classId);
  const results = learners.map((l) => promotionEngine.evaluateLearnerPromotionEligibility(l.id));
  res.json({ results });
});

// Manual promotion — supports single or bulk (§ "Support Manual promotion,
// Bulk promotion"). Each learner is independently evaluated; a learner who
// is not eligible is only promoted if overrideReason is supplied (admin
// discretion, per §11.2 "Administrators may override a learner's level"),
// and the override reason is recorded on the log entry either way.
router.post("/manual", requireAuth, requireRole("admin"), (req, res) => {
  const { learnerIds, overrideReason } = req.body;
  if (!Array.isArray(learnerIds) || !learnerIds.length) {
    return res.status(400).json({ error: "learnerIds (array) is required." });
  }

  const results = [];
  const run = db.transaction(() => {
    learnerIds.forEach((learnerId) => {
      const evaluation = promotionEngine.evaluateLearnerPromotionEligibility(learnerId);
      if (evaluation.blocked) {
        return results.push({ learnerId, ok: false, error: evaluation.reasons[0] });
      }
      if (!evaluation.eligible && !overrideReason) {
        return results.push({ learnerId, ok: false, eligible: false, reasons: evaluation.reasons, requiresOverrideReason: true });
      }
      const { logId, toClassId } = promotionEngine.applyPromotion({
        learnerId,
        toClassId: evaluation.toClassId,
        performedBy: req.user.id,
        action: "manual_promote",
        policySnapshot: { ...evaluation.breakdown, overrideReason: !evaluation.eligible ? overrideReason : undefined },
      });
      results.push({ learnerId, ok: true, logId, toClassId, wasOverride: !evaluation.eligible });
    });
  });
  run();
  res.json({ results });
});

// Automatic promotion — evaluates every learner in a class against the
// Programme's Promotion Policy and promotes ONLY those who are eligible.
// No override path here; that's precisely what distinguishes this from
// /manual. If no Promotion Policy is configured, every learner with a
// next class is eligibility-neutral and is promoted (see engine).
router.post("/auto-promote", requireAuth, requireRole("admin"), (req, res) => {
  const { classId } = req.body;
  if (!classId) return res.status(400).json({ error: "classId is required." });
  const learners = db.prepare("SELECT id FROM users WHERE role = 'learner' AND class_id = ?").all(classId);

  const results = [];
  const run = db.transaction(() => {
    learners.forEach(({ id: learnerId }) => {
      const evaluation = promotionEngine.evaluateLearnerPromotionEligibility(learnerId);
      if (evaluation.blocked) {
        return results.push({ learnerId, ok: false, promoted: false, error: evaluation.reasons[0] });
      }
      if (!evaluation.eligible) {
        return results.push({ learnerId, ok: true, promoted: false, reasons: evaluation.reasons });
      }
      const { logId, toClassId } = promotionEngine.applyPromotion({
        learnerId,
        toClassId: evaluation.toClassId,
        performedBy: req.user.id,
        action: "auto_promote",
        policySnapshot: evaluation.breakdown,
      });
      results.push({ learnerId, ok: true, promoted: true, logId, toClassId });
    });
  });
  run();
  res.json({ results, promotedCount: results.filter((r) => r.promoted).length, evaluatedCount: results.length });
});

// Reverse a specific promotion action by its promotion_log id — restores
// the learner's prior Programme Level and records a 'reversal' entry
// pointing back at the original. Level-only, same as every action above.
router.post("/reverse", requireAuth, requireRole("admin"), (req, res) => {
  const { logId } = req.body;
  if (!logId) return res.status(400).json({ error: "logId is required." });
  try {
    const result = promotionEngine.reversePromotion({ logId, performedBy: req.user.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

module.exports = router;
