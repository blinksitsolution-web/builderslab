const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requireSelfParentOrStaff, requireActiveAccess } = require("../middleware/auth");
const { accessRestriction, RESTRICTION_MESSAGE } = require("../utils/accessControl");
const { getSetting } = require("../utils/settings");
const { getYearById, getTermById } = require("../utils/academicTerm");
const { moduleResult, gradeFor } = require("../utils/transcriptEngine");
const { generateSkillsSummary } = require("../utils/ai");
const {
  getActiveInstanceIdForCourse,
  getActiveInstanceIdForClass,
  getLearningInstanceById,
  getAcademicPeriodById,
  resolveConstitutionalTermId,
  getEnrolledLearningInstanceIdForLearner,
} = require("../utils/learningInstances");
const { isLearnerAssignedToInstructor } = require("../utils/instructorScope");

const router = express.Router();

// ============================================================
// Certificate Engine — issuing + immutable retrieval.
// Template CRUD lives in routes/certificateTemplates.js, branding CRUD in
// routes/campusBranding.js. This file only ever INSERTs into
// issued_certificates (plus one status-flag UPDATE for revoke) — full
// template_snapshot/branding_snapshot are taken at issue time, so later
// template or branding edits can never alter an already-issued certificate.
// ============================================================

// Highest Score = highest Module Total the learner has ever achieved, across
// every term they have a grade in (not just the active one — a graduation
// certificate should reflect the whole program). Highest Grade/Interpretation
// are then derived from that score via the grading scheme — NEVER from
// Total Raw Score, which stays a transcript-only cumulative statistic (see
// utils/transcriptEngine.js and routes/grades.js).
function highestResult(learnerId) {
  const pairs = db
    .prepare(
      `SELECT DISTINCT course_id, term_id FROM grades WHERE user_id = ? AND term_id IS NOT NULL
       UNION SELECT DISTINCT course_id, term_id FROM examination_attempts ea
         JOIN examinations e ON e.id = ea.examination_id WHERE ea.user_id = ? AND ea.term_id IS NOT NULL`
    )
    .all(learnerId, learnerId);
  let highestScore = null;
  pairs.forEach(({ course_id, term_id }) => {
    const r = moduleResult(learnerId, course_id, term_id);
    if (r.total != null && (highestScore == null || r.total > highestScore)) highestScore = r.total;
  });
  const { grade, interpretation } = gradeFor(highestScore);
  return { highestScore: highestScore != null ? Math.round(highestScore * 10) / 10 : null, highestGrade: grade, highestInterpretation: interpretation };
}

// Institution logo root cause (blank/missing logo on every certificate):
// this used to return ONLY the campus_branding_profiles row, which has its
// own `institution_logo_path` column — but that column is a one-time
// migration SEED (db/migrate.js copies the legacy site_settings.branding
// logo into it per-campus exactly once, "so certificates look the same
// right after upgrading") and is never kept in sync afterwards. It is
// exactly the kind of certificate-only duplicate/stale copy of the
// Institution logo the branding architecture must not have, and the
// client (CertificateCard.jsx) was reading `logoPath` — a key that never
// existed on this object at all, campus-level or otherwise — so no
// certificate has ever actually rendered a logo.
//
// Fix: resolve the Institution logo from the SAME authoritative source
// Transcript uses (site_settings 'branding'.logoPath, see routes/grades.js
// and routes/settings.js) and expose it here as `logoPath`, merged onto
// (never replacing) the campus/partner branding row. This is captured
// into branding_snapshot at issue time in issueOne() below, matching this
// table's existing snapshot-at-issue-time immutability — it does not made
// this "live" for already-issued certificates, only for ones issued after
// this fix, exactly like every other snapshotted field here.
//
// campus_branding_profiles.partner_logo_path is untouched and remains the
// one legitimate, campus-owned Partner/Campus logo — a different concept
// from the Institution logo and never conflated with it.
function brandingFor(campusName) {
  const row = db.prepare("SELECT * FROM campus_branding_profiles WHERE campus_name = ?").get(campusName) || {
    campus_name: campusName,
    institution_name: "Dalijay Tech Hub",
  };
  const institutionBranding = getSetting("branding", { logoPath: "/images/DTH.jpg" });
  return { ...row, logoPath: institutionBranding.logoPath || null };
}

const DEFAULT_CERT_ORG_SETTINGS = {
  institutionName: "Dalijay Tech Hub",
  programName: "Builder's Lab",
  signatureCount: 1,
  signature1: { path: null, name: "", title: "" },
  signature2: { path: null, name: "", title: "" },
};
function orgSettings() {
  const stored = getSetting("certificateOrgSettings", DEFAULT_CERT_ORG_SETTINGS);
  return {
    ...DEFAULT_CERT_ORG_SETTINGS,
    ...stored,
    signature1: { ...DEFAULT_CERT_ORG_SETTINGS.signature1, ...(stored.signature1 || {}) },
    signature2: { ...DEFAULT_CERT_ORG_SETTINGS.signature2, ...(stored.signature2 || {}) },
  };
}

function formatCertNumber(format, { campus, year, seq }) {
  return String(format || "CERT-{campus}-{year}-{seq}")
    .replace("{campus}", (campus || "").toUpperCase().replace(/\s+/g, ""))
    .replace("{year}", year || new Date().getFullYear())
    .replace("{seq}", String(seq).padStart(4, "0"));
}

// Only resolves + exposes placeholders the template actually declares (see
// certificate_templates.placeholders) — "only expose placeholders
// applicable to the selected certificate template."
async function buildPlaceholderData(template, { learner, courseId, term, awardFields, branding, org }) {
  const wanted = new Set(JSON.parse(template.placeholders || "[]"));
  const data = {};
  if (wanted.has("student_name")) data.student_name = learner.name;
  if (wanted.has("campus")) data.campus = learner.campus;
  if (wanted.has("partner_school")) data.partner_school = branding.partner_school_name || "";
  if (wanted.has("issue_date")) data.issue_date = new Date().toISOString().slice(0, 10);
  if (wanted.has("course_name")) data.course_name = org.programName;

  if (courseId && (wanted.has("module_name") || wanted.has("grade") || wanted.has("completion_date"))) {
    const mod = db.prepare("SELECT * FROM courses WHERE id = ?").get(courseId);
    if (wanted.has("module_name")) data.module_name = mod ? mod.title : "";
    if (wanted.has("completion_date")) data.completion_date = new Date().toISOString().slice(0, 10);
    if (wanted.has("grade") && term) {
      const r = moduleResult(learner.id, courseId, term.id);
      data.grade = r.grade;
      if (template.type === "module_completion" && !data.skills) {
        data.skills = await generateSkillsSummary(mod ? mod.title : "", mod ? mod.blurb : "", r.total);
      }
    }
  }

  if (wanted.has("highest_score") || wanted.has("highest_grade") || wanted.has("highest_interpretation")) {
    const h = highestResult(learner.id);
    if (wanted.has("highest_score")) data.highest_score = h.highestScore;
    if (wanted.has("highest_grade")) data.highest_grade = h.highestGrade;
    if (wanted.has("highest_interpretation")) data.highest_interpretation = h.highestInterpretation;
  }

  // Award-certificate fields — administrator-entered, never auto-derived.
  if (awardFields) {
    ["awardTitle", "citation", "achievement", "reason", "academicYear"].forEach((k) => {
      if (awardFields[k] != null) data[k] = awardFields[k];
    });
  }

  return data;
}

async function issueOne({ template, learner, courseId, termId, academicYearId, awardFields, issuedBy, learningInstanceAcademicPeriodId }) {
  const branding = brandingFor(learner.campus);
  const org = orgSettings();
  // The global, always-applicable signature(s) — an admin indicates one or
  // two and uploads each once (routes/certificateTemplates.js's
  // /org-settings/signature/:slot), exactly like transcripts' single global
  // signature upload — snapshotted here alongside the campus branding so a
  // later signature change never alters an already-issued certificate.
  // Kept as its own key (orgSignatures) rather than overwriting
  // branding.signature_path/authorized_signatory, so certificates issued
  // before this existed keep rendering their old campus-based signature.
  const brandingWithSignatures = { ...branding, orgSignatures: { count: org.signatureCount, signature1: org.signature1, signature2: org.signature2 } };

  // Module Completion certificates resolve the run the same way every other
  // module-level record does (the Module's own active instance, or its
  // Programme's); every other certificate type (graduation/honor/
  // recognition) is scoped to the learner's own Programme placement instead,
  // since there's no single module involved.
  //
  // Historical-integrity fix: a graduation/honor/recognition certificate
  // must snapshot the Run the learner actually completed under, not
  // whichever Run happens to be "currently active" for their class at the
  // moment an admin gets around to issuing it. getActiveInstanceIdForClass
  // can silently resolve to a NEWER Run once one has been activated after
  // the learner's own Run closed (e.g. a late-issued certificate for a
  // 2026 cohort, issued after a 2027 Run is already open) — exactly the
  // "certificate must remain associated with the historical Learning
  // Instance" rule. getEnrolledLearningInstanceIdForLearner reads the
  // learner's own primary programme_enrollments row, so it's authoritative
  // once an enrollment exists; the active-instance lookup remains only as
  // the fallback for the (rare) case of no enrollment record at all.
  const learningInstanceId = courseId
    ? getActiveInstanceIdForCourse(courseId)
    : getEnrolledLearningInstanceIdForLearner(learner.id) || getActiveInstanceIdForClass(learner.class_id);

  // Phase 9 — an academic period is only ever attached to a certificate when
  // an admin explicitly identifies one (learningInstanceAcademicPeriodId in
  // the /issue request body), and only once it's confirmed to actually
  // belong to the resolved Learning Instance — never guessed/inferred from
  // the term alone. Left null for every certificate type/flow that doesn't
  // pass one, which is exactly what keeps every pre-existing certificate
  // (and every certificate for a Learning Instance with no academic
  // structure configured) issuing/behaving exactly as before this shipped.
  let periodId = null;
  let explicitPeriod = null;
  if (learningInstanceAcademicPeriodId) {
    if (!learningInstanceId) {
      throw new Error("A learningInstanceAcademicPeriodId was given, but no Learning Instance could be resolved for this certificate.");
    }
    explicitPeriod = getAcademicPeriodById(learningInstanceId, learningInstanceAcademicPeriodId);
    if (!explicitPeriod) {
      throw new Error("The given learningInstanceAcademicPeriodId does not belong to this certificate's Learning Instance.");
    }
    periodId = explicitPeriod.id;
  }

  // ABRS v2.2 Compliance Remediation: term_id derives from the
  // constitutional ownership chain — Programme Run -> Academic Period ->
  // Academic Term (§8.2/§19) — never from an institution-wide "active
  // term" resolved independently of this certificate's own Run. Three
  // cases, in order of precedence:
  //   1. An explicit termId (a caller/admin deliberately naming a known,
  //      possibly-historical Academic Term entity — e.g. reissuing a
  //      certificate for a legacy record). An explicit choice, not a
  //      silently-applied default, so it's honored as before.
  //   2. An explicit learningInstanceAcademicPeriodId was given — that
  //      exact Academic Period's own linked Academic Term is the most
  //      specific point in the ownership chain available, so it wins over
  //      "whatever the Run's current period happens to be".
  //   3. Otherwise, the resolved Learning Instance's CURRENT Academic
  //      Period's linked Academic Term (the common case — issuing a
  //      certificate today, for this Run, right now).
  // Any of these can legitimately resolve to null (no Academic Term
  // linked yet) — a certificate can still be issued without a term (same
  // as before this remediation), it's simply unscoped by term until an
  // admin finishes configuring the Run's Academic Calendar.
  let term;
  if (termId) {
    term = getTermById(termId);
  } else if (explicitPeriod) {
    term = explicitPeriod.academicTermId ? getTermById(explicitPeriod.academicTermId) : null;
  } else {
    const resolvedTermId = resolveConstitutionalTermId(learningInstanceId);
    term = resolvedTermId ? getTermById(resolvedTermId) : null;
  }
  const year = academicYearId ? getYearById(academicYearId) : term ? getYearById(term.academic_year_id) : null;

  const data = await buildPlaceholderData(template, { learner, courseId, term, awardFields, branding, org });

  // Certificate numbering: unique server-side, permanent once assigned.
  // certificate_number carries a DB-level UNIQUE constraint (schema.sql /
  // migrate.js), which is the actual integrity guarantee — but the naive
  // "COUNT existing rows for this template+campus, +1" scheme used to
  // compute the *next* number has an await (buildPlaceholderData, which can
  // call out to the AI skills-summary service) between counting and
  // inserting. Two concurrent issue requests for the same template+campus
  // could both count the same value and then collide on insert. Rather than
  // let that surface as a raw SQL error to the admin, retry with the next
  // sequence number a bounded number of times — by the time a retry is
  // needed, whichever request lost the race simply asks the DB for the
  // count again and tries the next number.
  const id = uuid();
  const MAX_ATTEMPTS = 5;
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seqRow = db
      .prepare("SELECT COUNT(*) as n FROM issued_certificates WHERE template_id = ? AND campus_name = ?")
      .get(template.id, learner.campus);
    const certificateNumber = formatCertNumber(template.number_format, {
      campus: learner.campus,
      year: year ? year.name.split("/")[0] : new Date().getFullYear(),
      seq: (seqRow.n || 0) + 1 + attempt, // nudge past whatever the previous failed attempt(s) collided with
    });
    try {
      db.prepare(
        `INSERT INTO issued_certificates
           (id, certificate_number, template_id, learner_id, campus_name, academic_year_id, term_id, course_id, data, template_snapshot, branding_snapshot, issued_by, learning_instance_id, learning_instance_academic_period_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        certificateNumber,
        template.id,
        learner.id,
        learner.campus,
        year ? year.id : null,
        term ? term.id : null,
        courseId || null,
        JSON.stringify(data),
        JSON.stringify(template),
        JSON.stringify(brandingWithSignatures),
        issuedBy,
        learningInstanceId,
        periodId
      );
      return db.prepare("SELECT * FROM issued_certificates WHERE id = ?").get(id);
    } catch (e) {
      if (/UNIQUE/i.test(e.message) && /certificate_number/i.test(e.message)) { lastError = e; continue; }
      throw e;
    }
  }
  throw lastError || new Error("Could not assign a unique certificate number after several attempts.");
}

function resolveLearnerIds(body) {
  if (Array.isArray(body.learnerIds) && body.learnerIds.length) return body.learnerIds;
  // classId-based targeting removed (§22/§11.4 remediation): the legacy
  // `classes` table overloads Programme Level and Operational Group
  // (§11.5), and Operational Group must never gate or alter certificate
  // eligibility. Callers select recipients via Programme Run-scoped
  // enrollment (learnerIds, resolved from the constitutional Enrollment
  // owner) or campus, never via this legacy grouping table.
  if (body.campusName) {
    return db.prepare("SELECT id FROM users WHERE role='learner' AND campus = ?").all(body.campusName).map((r) => r.id);
  }
  if (Array.isArray(body.campusNames) && body.campusNames.length) {
    const placeholders = body.campusNames.map(() => "?").join(",");
    return db.prepare(`SELECT id FROM users WHERE role='learner' AND campus IN (${placeholders})`).all(...body.campusNames).map((r) => r.id);
  }
  // No explicit cohort given for a Module Completion certificate: default to
  // every learner currently enrolled in that module (the common "issue for
  // this whole class's module" case).
  if (body.courseId) {
    return db.prepare("SELECT user_id FROM enrollments WHERE course_id = ?").all(body.courseId).map((r) => r.user_id);
  }
  return [];
}

// Issue to an individual learner, multiple learners, an entire campus, or
// multiple campuses — campus determines branding, per spec. Never an
// Operational Group (§11.4) — see resolveLearnerIds.
router.post("/issue", requireAuth, requireRole("admin"), async (req, res) => {
  const { templateId, courseId, academicYearId, termId, awardFields, learningInstanceAcademicPeriodId } = req.body;
  const template = db.prepare("SELECT * FROM certificate_templates WHERE id = ? AND is_active = 1").get(templateId);
  if (!template) return res.status(404).json({ error: "Active certificate template not found." });
  if (template.type === "module_completion" && !courseId) {
    return res.status(400).json({ error: "courseId is required for a Module Completion certificate." });
  }

  const learnerIds = resolveLearnerIds(req.body);
  if (!learnerIds.length) return res.status(400).json({ error: "No target learners resolved — provide learnerIds, campusName, or campusNames." });

  const issued = [];
  const skipped = [];
  for (const learnerId of learnerIds) {
    const learner = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'learner'").get(learnerId);
    if (!learner || !learner.campus) { skipped.push({ learnerId, reason: "Learner not found or has no campus set." }); continue; }
    // Idempotency: don't re-issue the same template+module+period to the
    // same learner twice (a batch re-run just reports it as already
    // issued). Phase 9 — the academic period is now part of that identity:
    // a NULL learningInstanceAcademicPeriodId only ever matches another
    // NULL (so every pre-Phase-9 certificate, and every certificate for a
    // Learning Instance with no academic structure, keeps deduplicating
    // exactly as before), while two DIFFERENT periods for the same
    // learner+module are never treated as duplicates of each other — a
    // later period's certificate must never be blocked/skipped just
    // because an earlier period's certificate already exists.
    const dup = db
      .prepare(
        `SELECT id FROM issued_certificates
         WHERE template_id = ? AND learner_id = ? AND (course_id IS ? OR course_id = ?)
           AND (learning_instance_academic_period_id IS ? OR learning_instance_academic_period_id = ?)
           AND is_revoked = 0`
      )
      .get(template.id, learnerId, courseId || null, courseId || null, learningInstanceAcademicPeriodId || null, learningInstanceAcademicPeriodId || null);
    if (dup) { skipped.push({ learnerId, reason: "Already issued." }); continue; }
    try {
      issued.push(await issueOne({ template, learner, courseId, termId, academicYearId, awardFields, issuedBy: req.user.id, learningInstanceAcademicPeriodId }));
    } catch (e) {
      skipped.push({ learnerId, reason: e.message || "Could not issue this certificate." });
    }
  }
  res.json({ issued: issued.length, skipped, certificates: issued });
});

// Self/parent/staff: every certificate issued to one learner. Certificates
// are only ever visible here after issuance — there's no "preview before
// issuing" path, per spec.
router.get("/learner/:userId", requireAuth, requireSelfParentOrStaff("userId"), requireActiveAccess("userId"), (req, res) => {
  if (req.user.role === "instructor" && !isLearnerAssignedToInstructor(req.user.id, req.params.userId)) {
    return res.status(403).json({ error: "This learner is outside your assigned scope." });
  }
  const rows = db
    .prepare("SELECT * FROM issued_certificates WHERE learner_id = ? AND is_revoked = 0 ORDER BY issued_at DESC")
    .all(req.params.userId);
  res.json({
    certificates: rows.map((r) => ({
      ...r,
      data: JSON.parse(r.data),
      branding: JSON.parse(r.branding_snapshot),
      // Certificates/transcripts must identify their Learning Instance
      // rather than silently mixing runs — resolved here (not stored
      // redundantly on the row) so a Learning Instance renamed after issue
      // still shows its current name, same as everywhere else in the app.
      learningInstance: r.learning_instance_id ? getLearningInstanceById(r.learning_instance_id) : null,
      // Phase 9 — which academic period (if any) this certificate was
      // issued for, resolved live (not stored redundantly) so a
      // since-renamed period still shows its current name. null for every
      // certificate issued before Phase 9, or for a Learning Instance with
      // no academic structure — those remain valid, undated-by-period
      // certificates, not an error.
      academicPeriod: r.learning_instance_id && r.learning_instance_academic_period_id
        ? getAcademicPeriodById(r.learning_instance_id, r.learning_instance_academic_period_id)
        : null,
    })),
  });
});

// Single certificate — full immutable snapshot, for preview/PDF download.
// Reuses the same requireSelfParentOrStaff check via a lookup on the cert's
// learner_id, and staff (instructor/admin) can always view.
router.get("/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM issued_certificates WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Certificate not found." });
  const isStaff = req.user.role === "admin" || req.user.role === "instructor";
  const isSelf = req.user.id === row.learner_id;
  const isParent = req.user.role === "parent" && db.prepare("SELECT 1 FROM users WHERE id = ? AND parent_id = ?").get(row.learner_id, req.user.id);
  if (!isStaff && !isSelf && !isParent) return res.status(403).json({ error: "Not authorized to view this certificate." });
  if (req.user.role === "instructor" && !isLearnerAssignedToInstructor(req.user.id, row.learner_id)) {
    return res.status(403).json({ error: "This learner is outside your assigned scope." });
  }
  if (!isStaff) {
    const learner = db.prepare("SELECT * FROM users WHERE id = ?").get(row.learner_id);
    if (accessRestriction(learner).restricted) return res.status(403).json({ error: RESTRICTION_MESSAGE, code: "ACCESS_RESTRICTED" });
  }
  res.json({
    ...row,
    data: JSON.parse(row.data),
    template: JSON.parse(row.template_snapshot),
    branding: JSON.parse(row.branding_snapshot),
    learningInstance: row.learning_instance_id ? getLearningInstanceById(row.learning_instance_id) : null,
    academicPeriod: row.learning_instance_id && row.learning_instance_academic_period_id
      ? getAcademicPeriodById(row.learning_instance_id, row.learning_instance_academic_period_id)
      : null,
  });
});

// Revoke = a status flag only, never a content edit — the snapshot stays
// exactly as issued (e.g. for audit), it's just no longer shown to the
// learner/parent as an active certificate.
router.post("/:id/revoke", requireAuth, requireRole("admin"), (req, res) => {
  const result = db.prepare("UPDATE issued_certificates SET is_revoked = 1 WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Certificate not found." });
  res.json({ ok: true });
});

module.exports = router;
