const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  parseSettings,
  programmeAllowsSelfRegistration,
  offeringTypeAllowsSelfRegistration,
  programmeAllowsAudience,
  getOfferingTypeForProgramme,
  offeringTypeUsesParticipationStructuresV2,
} = require("../utils/offeringTypeSettings");
const {
  getActiveInstanceIdForProgramme,
  getLearningInstanceById,
  isTargetActiveInCurrentPeriod,
  PARTICIPATION_STRUCTURES,
  isValidParticipationStructure,
  isParticipationStructureAllowedForOfferingType,
  deriveEnrollmentOperationalSnapshot,
  resolveProgrammeRegistrationOpen,
  resolveParticipationStructureConfig,
  getProgrammeParticipationStructures,
  resolveActiveInstanceForRegistration,
  isCourseAvailableForIndividualCourseOffering,
  getEligibleCoursesForRun,
  usesRunScopedCourseCurriculum,
} = require("../utils/learningInstances");

// ABRS v2.1 Phase 5 prerequisite — shared by both write sites below
// (POST / and PATCH /:id/participation-structure) so the two can never
// validate a participationStructure value differently (§17.2's "one
// capability, one place it's implemented" principle). Byte-for-byte the
// historical hardcoded-enum error/behaviour when the resolved offering
// type hasn't opted into participationStructuresV2Enabled.
function validateParticipationStructureForProgramme(programmeId, value) {
  const offeringType = getOfferingTypeForProgramme(programmeId);
  if (offeringTypeUsesParticipationStructuresV2(offeringType) && value != null) {
    const config = resolveParticipationStructureConfig(programmeId, value);
    if (!config) {
      const available = getProgrammeParticipationStructures(programmeId).map((s) => s.key);
      return {
        error: available.length
          ? `participationStructure must be one of: ${available.join(", ")}.`
          : "This programme has no Participation Structures configured — contact the admin.",
      };
    }
    return { config };
  }
  if (!isValidParticipationStructure(value) || !isParticipationStructureAllowedForOfferingType(offeringType, value)) {
    return { error: `participationStructure must be one of: ${PARTICIPATION_STRUCTURES.join(", ")}` };
  }
  return {};
}
const { registrationBreakdown } = require("../utils/fees");
const pricingEngine = require("../utils/pricingEngine");

const router = express.Router();

/**
 * Lets an EXISTING account (an adult learner, or a parent on behalf of one
 * of their children) enrol into an additional Programme within their
 * eligible Learning Offering Types — without creating a new account. Every
 * previous enrolment (the account's original/primary placement in
 * users.class_id, and every row already in programme_enrollments) and every
 * past payment is left completely untouched; this only ever adds a new
 * 'pending_payment' row, exactly mirroring the account-creation flow in
 * routes/auth.js (POST /register) minus the "create a new account" part.
 */

// A learner is reachable by: themself, or a parent of theirs (staff can
// still act through the admin Portal's own routes — this endpoint is
// deliberately self-service only, same boundary as requireSelfParentOrStaff).
function resolveTargetLearner(req, res) {
  const targetUserId = req.body.targetUserId || req.query.targetUserId;
  if (!targetUserId) {
    res.status(400).json({ error: "targetUserId is required." });
    return null;
  }
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetUserId);
  if (!target || target.role !== "learner") {
    res.status(404).json({ error: "Learner not found." });
    return null;
  }
  const isSelf = req.user.id === target.id;
  const isParent = req.user.role === "parent" && target.parent_id === req.user.id;
  if (!isSelf && !isParent) {
    res.status(403).json({ error: "You don't have permission to manage this account's enrolments." });
    return null;
  }
  return target;
}

function toEnrollmentView(row) {
  return {
    id: row.id,
    userId: row.user_id,
    programmeId: row.programme_id,
    programmeName: row.programme_name,
    offeringTypeName: row.offering_type_name,
    offeringTypeIcon: row.offering_type_icon,
    classId: row.class_id,
    className: row.class_name,
    isPrimary: !!row.is_primary,
    status: row.status,
    paymentStatus: row.payment_status,
    joinedDate: row.joined_date,
    // The specific run/cohort this enrolment belongs to, if one has been
    // set up and was active at enrolment time — NULL for a Programme with
    // no Learning Instance configured yet (never blocks enrolling; see
    // utils/learningInstances.js's getActiveInstanceIdForProgramme).
    learningInstanceId: row.learning_instance_id || null,
    learningInstanceName: row.learning_instance_name || null,
    learningInstanceStatus: row.learning_instance_status || null,
    // §17/§11.4 — the Operational Group this Enrollment is assigned to,
    // if any. Distinct from classId/className (Programme Level) and from
    // learningInstanceId (Programme Run) — see utils/learningInstances.js
    // resolveEnrollmentOperationalConfig() for how this is resolved.
    operationalGroupId: row.operational_group_id || null,
    operationalGroupName: row.operational_group_name || null,
    // §17 — the immutable record of what this learner was actually
    // charged/agreed to at the moment of enrollment. Captured once, at
    // creation (utils/pricingEngine.js buildPricingSnapshot/
    // buildFinancialPolicySnapshot), and never overwritten afterward —
    // this must always reflect that original record, never a live
    // re-resolution against the Programme Run's current pricing
    // configuration. NULL only for Enrollments that predate snapshotting.
    pricingSnapshot: parseSnapshotJson(row.pricing_snapshot),
    financialPolicySnapshot: parseSnapshotJson(row.financial_policy_snapshot),
  };
}

// Snapshot columns are persisted as JSON text (see migratePricing.js); a
// bad/missing value must never break the rest of the Enrollment response,
// so this parses defensively and falls back to null rather than throwing.
function parseSnapshotJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

const ENROLLMENT_SELECT = `
  SELECT pe.*, p.name as programme_name, t.name as offering_type_name, t.icon as offering_type_icon, c.name as class_name,
         li.name as learning_instance_name, li.status as learning_instance_status,
         og.name as operational_group_name
  FROM programme_enrollments pe
  JOIN programmes p ON p.id = pe.programme_id
  JOIN learning_offering_types t ON t.id = p.offering_type_id
  LEFT JOIN classes c ON c.id = pe.class_id
  LEFT JOIN learning_instances li ON li.id = pe.learning_instance_id
  LEFT JOIN operational_groups og ON og.id = pe.operational_group_id
`;

// GET /api/enrolments/mine?targetUserId=<learnerId>
// Every programme this account is enrolled in — its original/primary
// placement plus any additional programmes enrolled via this feature.
router.get("/mine", requireAuth, (req, res) => {
  const target = resolveTargetLearner(req, res);
  if (!target) return;
  const rows = db.prepare(ENROLLMENT_SELECT + " WHERE pe.user_id = ? ORDER BY pe.is_primary DESC, pe.created_at ASC").all(target.id);
  res.json({ enrolments: rows.map(toEnrollmentView) });
});

// GET /api/enrolments/eligible-offerings?targetUserId=<learnerId>
// Offering Types this account could self-enrol an ADDITIONAL programme
// into — same self-registration + audience rules the public registration
// page uses (routes/learningOfferings.js GET /types/registration), just
// scoped to whichever audience this specific account belongs to.
router.get("/eligible-offerings", requireAuth, (req, res) => {
  const target = resolveTargetLearner(req, res);
  if (!target) return;
  const kind = target.is_adult ? "adult" : "parent-learner";
  const rows = db.prepare("SELECT * FROM learning_offering_types WHERE is_active = 1 ORDER BY sort_order ASC, name ASC").all();
  const offerings = rows
    .map((row) => ({ ...row, settings: parseSettings(row.settings) }))
    .filter((t) => offeringTypeAllowsSelfRegistration(t))
    .filter((t) => {
      const required = t.settings.enrollment.parentAccountRequired;
      if (required === "optional") return true;
      return kind === "adult" ? required === "no" : required === "yes";
    })
    .map((t) => ({ id: t.id, name: t.name, slug: t.slug, icon: t.icon, color: t.color, learningGroupLabel: t.learning_group_label }));
  res.json({ offerings, audience: kind });
});

// POST /api/enrolments — { targetUserId, programmeId, classId }
// Creates the new 'pending_payment' enrolment. Payment is then initiated the
// same way registration payment is (POST /api/payments/:userId/initiate,
// with a programmeEnrollmentId) — nothing about the existing payment flow
// is duplicated here.
router.post("/", requireAuth, (req, res) => {
  const target = resolveTargetLearner(req, res);
  if (!target) return;
  const { programmeId, classId } = req.body;
  if (!programmeId || !classId) return res.status(400).json({ error: "programmeId and classId are required." });

  const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!classRow || classRow.programme_id !== programmeId) {
    return res.status(400).json({ error: "That Batch/Cohort doesn't belong to the selected programme." });
  }
  const programme = db.prepare("SELECT * FROM programmes WHERE id = ?").get(programmeId);
  if (!programme || !programme.is_active) return res.status(404).json({ error: "Programme not found." });

  const kind = target.is_adult ? "adult" : "parent-learner";
  if (!programmeAllowsSelfRegistration(programmeId)) {
    return res.status(400).json({ error: "Self-registration isn't open for this programme — contact the admin to be enrolled." });
  }
  if (!programmeAllowsAudience(programme, kind)) {
    return res.status(400).json({ error: "This programme isn't open to this account's registration path." });
  }
  if (!resolveProgrammeRegistrationOpen(programme, req.body.operationalGroupId)) {
    return res.status(409).json({ error: "Registration for this programme is currently closed — contact the admin." });
  }
  // ABRS v2.2 amendment (concurrent Programme Runs): don't silently guess
  // which Active Run this enrolment attaches to once a Programme has more
  // than one — require operationalGroupId to disambiguate, same as auth.js.
  // This is also the authoritative resolution used below (not just a
  // pre-check) — must not be recomputed afterwards via the legacy
  // single-value resolver, or a correctly-disambiguated request could
  // still silently attach to the wrong Run.
  const resolvedRun = resolveActiveInstanceForRegistration(programmeId, req.body.operationalGroupId, req.body.learningInstanceId, req.body.participationStructure || null);
  if (resolvedRun.ambiguous) {
    return res.status(409).json({
      error: "This programme currently has more than one active run — choose which one to register into.",
      activeRuns: resolvedRun.options.map((o) => ({ id: o.id, name: o.name })),
    });
  }

  // Already enrolled (active or awaiting payment) in this exact programme?
  const dup = db
    .prepare("SELECT id FROM programme_enrollments WHERE user_id = ? AND programme_id = ? AND status IN ('pending_payment','active')")
    .get(target.id, programmeId);
  if (dup) return res.status(409).json({ error: "This account already has an enrolment (active or awaiting payment) in that programme." });

  const id = uuid();
  const learningInstanceId = resolvedRun.instance ? resolvedRun.instance.id : null;
  // Registration Source of Truth: an additional-programme enrolment is a
  // registration action and must be gated exactly like initial registration
  // — only through an ACTIVE Programme Run. No Active Programme Run means
  // there is no valid registration opportunity for this programme.
  if (!learningInstanceId) {
    return res.status(409).json({ error: "There are currently no available registration opportunities for this programme — an admin has not opened an active registration run yet." });
  }
  // Phase 8 — if that active run has an academic structure configured, this
  // Programme must currently be one of the CURRENT period's configured
  // targets (same back-compat rule as everywhere else in this task: no
  // structure, or a period with no targets configured yet, never blocks
  // this).
  if (learningInstanceId) {
    const instance = getLearningInstanceById(learningInstanceId);
    if (!isTargetActiveInCurrentPeriod(instance, { programmeId })) {
      return res.status(400).json({ error: "This programme isn't part of the current academic period — contact the admin." });
    }
  }
  const requestedParticipationStructure = req.body.participationStructure || null;
  const psValidation = validateParticipationStructureForProgramme(programmeId, requestedParticipationStructure);
  if (psValidation.error) return res.status(400).json({ error: psValidation.error });

  // §17/§18 — Operational Group selection is optional (most Programme Runs
  // have none) and, when provided, must belong to THIS registration's own
  // resolved Programme Run — an Operational Group can never span Runs
  // (§11.2), so a group from a different Run (even of the same Programme)
  // is rejected rather than silently ignored.
  const requestedOperationalGroupId = req.body.operationalGroupId || null;
  if (requestedOperationalGroupId) {
    const group = db.prepare("SELECT id, learning_instance_id, is_active FROM operational_groups WHERE id = ?").get(requestedOperationalGroupId);
    if (!group || group.learning_instance_id !== learningInstanceId || !group.is_active) {
      return res.status(400).json({ error: "operationalGroupId is not a valid, active Operational Group for this programme's current Programme Run." });
    }
  }
  const courseIds = req.body.courseIds || req.body.requestedCourseIds || null;
  if (requestedParticipationStructure === "individual_course") {
    if (!learningInstanceId) {
      return res.status(400).json({ error: "learningInstanceId is required for Individual Course enrolment." });
    }
    const offering = getLearningInstanceById(learningInstanceId);
    if (!offering || offering.participationStructure !== "individual_course") {
      return res.status(400).json({ error: "learningInstanceId must refer to an Individual Course Learning Instance." });
    }
    if (!Array.isArray(courseIds) || courseIds.length === 0) {
      return res.status(400).json({ error: "Choose at least one course for Individual Course enrolment." });
    }
    for (const m of courseIds) {
      const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(m);
      if (!course || !course.is_open) {
        return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
      }
      if (course.programme_id && course.programme_id !== programmeId) {
        return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
      }
      if (!isCourseAvailableForIndividualCourseOffering(learningInstanceId, m)) {
        return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
      }
    }
  }

  // Course ID Authority — same rule as routes/auth.js's adult registration
  // path: this additional-programme enrolment route never REQUIRES
  // courseIds outside Individual Course (validated above), but a client
  // submitting them for an Adult Professional Programme must not be
  // trusted blindly — they end up granted as real course access via
  // resolveRunConfiguredCourseCurriculum, so they're restricted to courses
  // actually configured/eligible on the resolved Programme Run.
  if (requestedParticipationStructure !== "individual_course" && Array.isArray(courseIds) && courseIds.length) {
    const offeringType = getOfferingTypeForProgramme(programmeId);
    if (offeringType && usesRunScopedCourseCurriculum(offeringType.slug)) {
      const eligible = new Set(getEligibleCoursesForRun(learningInstanceId, programmeId));
      const invalidCourseIds = courseIds.filter((cid) => !eligible.has(cid));
      if (invalidCourseIds.length) {
        return res.status(400).json({
          error: "One or more courses are not configured for this Programme Run.",
          invalidCourseIds,
        });
      }
    }
  }

  const effectiveEnrolmentClassId = requestedParticipationStructure === "individual_course" ? null : classId;
  const requestedModuleIdsJSON = Array.isArray(courseIds) && courseIds.length ? JSON.stringify(courseIds) : null;

  try {
    const operationalSnapshot = deriveEnrollmentOperationalSnapshot({ classRow, instanceId: learningInstanceId, operationalGroupId: requestedOperationalGroupId });
    const pricingSnapshot = pricingEngine.buildPricingSnapshot({
      learningInstanceId,
      classId,
      operationalGroupId: operationalSnapshot.operationalGroupId,
      userId: target.id,
      corporateClientId: target.corporate_client_id || null,
      legacyAdjustmentContext: { campus: target.campus, school_name: target.school_name, own_robotics_kit: target.own_robotics_kit },
    });
    const financialPolicySnapshot = pricingEngine.buildFinancialPolicySnapshot({ learningInstanceId });
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id, participation_structure, requested_course_ids, delivery_mode, campus_id, academic_period_id, course_group_id, operational_group_id, pricing_snapshot, financial_policy_snapshot)
       VALUES (?, ?, ?, ?, 0, 'pending_payment', 'unpaid', date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      target.id,
      programmeId,
      effectiveEnrolmentClassId,
      learningInstanceId,
      requestedParticipationStructure,
      requestedModuleIdsJSON,
      operationalSnapshot.deliveryMode,
      operationalSnapshot.campusId,
      operationalSnapshot.academicPeriodId,
      operationalSnapshot.courseGroupId,
      operationalSnapshot.operationalGroupId,
      pricingSnapshot,
      financialPolicySnapshot
    );
  } catch (e) {
    // Backstop for the SELECT-then-INSERT check above (e.g. a repeated/
    // concurrent submission) — the DB's own partial unique index
    // (idx_programme_enrollments_no_dup_active, migrate.js) rejects it
    // the same way.
    if (String(e && e.message).includes("UNIQUE constraint failed")) {
      return res.status(409).json({ error: "This account already has an enrolment (active or awaiting payment) in that programme." });
    }
    throw e;
  }

  const row = db.prepare(ENROLLMENT_SELECT + " WHERE pe.id = ?").get(id);
  res.json({ ok: true, enrolment: toEnrollmentView(row) });
});

// GET /api/enrolments/fee-preview?targetUserId=<id>&classId=<id>
// The registration fee this account will actually be charged for a given
// Batch/Cohort, computed with the exact same registrationBreakdown() the
// payment step itself uses (routes/payments.js POST /:userId/initiate's
// programmeEnrollmentId branch) — so what's shown here is guaranteed to
// match what's charged, including any per-Batch/per-Offering-Type fee
// override and multi-ward discount. Lets "My Programmes" (and any other
// Offering Type → Programme → Batch/Cohort picker) show the cost before a
// learner/parent commits to enrolling, instead of only revealing it at the
// payment step afterwards.
router.get("/fee-preview", requireAuth, (req, res) => {
  const target = resolveTargetLearner(req, res);
  if (!target) return;
  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "classId is required." });
  const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!classRow) return res.status(404).json({ error: "Batch/Cohort not found." });
  const { breakdown, totalGHS } = registrationBreakdown([
    { name: target.name, campus: target.campus, schoolName: target.school_name, ownRoboticsKit: target.own_robotics_kit, classId, sponsored: !!target.sponsor_id },
  ]);
  res.json({ amountGHS: totalGHS, discounted: breakdown[0]?.discounted || false });
});

// PATCH /api/enrolments/:id/participation-structure — admin-only
// correction/assignment of the Builders' Lab participation structure on
// an existing enrolment row (primary or additional). Registration already
// sets this going forward (routes/auth.js, and this file's POST / above);
// this exists so Admin can also see-and-fix it directly, per the spec's
// "Admin must be able to clearly see... learner participation structure"
// requirement, and so historical rows (NULL by design — never guessed at
// migration time, see migrate.js v29) can be tagged retroactively by a
// human who actually knows the right answer, rather than the system
// inferring one.
router.patch("/:id/participation-structure", requireAuth, requireRole("admin"), (req, res) => {
  const existing = db.prepare("SELECT id, programme_id FROM programme_enrollments WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Enrolment not found." });
  const { participationStructure } = req.body;
  const psValidation = validateParticipationStructureForProgramme(existing.programme_id, participationStructure || null);
  if (psValidation.error) return res.status(400).json({ error: psValidation.error });
  db.prepare("UPDATE programme_enrollments SET participation_structure = ?, updated_at = datetime('now') WHERE id = ?").run(
    participationStructure || null,
    req.params.id
  );
  res.json({ ok: true, participationStructure: participationStructure || null });
});

// ============================================================
// PATCH /api/enrolments/:id/operational-group — administrative
// Operational Group transfer (ABRS v2.2 §11.4, §20.2).
//
// This is the single endpoint authorized to write
// programme_enrollments.operational_group_id (§20.2's "exactly one
// endpoint that reassigns an Operational Group, distinct from the
// Promotion endpoint"). It is deliberately NOT part of
// routes/promotion.js and never touches class_id, current_academic_year_
// id, status, or any other Enrollment/Promotion field — §11.4 is
// explicit that moving a learner between Operational Groups "must never
// be implemented through the Promotion workflow or be recorded as a
// Programme Level change," even when triggered by the same admin action
// as a Promotion (§14's closing paragraph: two actions, reviewed
// separately, even behind one UI click).
// ============================================================
router.patch("/:id/operational-group", requireAuth, requireRole("admin"), (req, res) => {
  const existing = db.prepare("SELECT * FROM programme_enrollments WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Enrolment not found." });

  const { operationalGroupId } = req.body;
  if (operationalGroupId === undefined) {
    return res.status(400).json({ error: "operationalGroupId is required (pass null to unassign)." });
  }

  if (operationalGroupId !== null) {
    if (!existing.learning_instance_id) {
      return res.status(409).json({ error: "This Enrolment has no Programme Run on record — an Operational Group can't be assigned without one." });
    }
    const group = db.prepare("SELECT id, learning_instance_id, is_active FROM operational_groups WHERE id = ?").get(operationalGroupId);
    if (!group) return res.status(404).json({ error: "Operational Group not found." });
    if (group.learning_instance_id !== existing.learning_instance_id) {
      return res.status(400).json({ error: "That Operational Group belongs to a different Programme Run than this Enrolment's." });
    }
    if (!group.is_active) return res.status(400).json({ error: "That Operational Group has been retired and can no longer be newly assigned." });
  }

  db.prepare("UPDATE programme_enrollments SET operational_group_id = ?, updated_at = datetime('now') WHERE id = ?").run(operationalGroupId, req.params.id);
  const row = db.prepare(ENROLLMENT_SELECT + " WHERE pe.id = ?").get(req.params.id);
  res.json({ ok: true, enrolment: toEnrollmentView(row) });
});

module.exports = router;
