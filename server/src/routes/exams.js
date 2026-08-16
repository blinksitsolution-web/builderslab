const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requireSelfParentOrStaff, requireActiveAccessSelf, requireActiveAccess } = require("../middleware/auth");
const { retakeEligibleLearners } = require("../utils/transcriptInterpretation");
const { moduleResult } = require("../utils/transcriptEngine");
const { getActiveInstanceIdForCourse, getLearningInstanceById, instanceBelongsToInstructor, instanceTargetsCourse, resolveConstitutionalTermId, resolveConstitutionalTermIdForCourse } = require("../utils/learningInstances");
const { instructorHasCourseAccess } = require("../utils/instructorScope");
const { computeDeadline, expiryReason } = require("../utils/assessmentTiming");
const { periodAccessDecisionForCourse, sendPeriodAccessDenied } = require("../utils/periodPayments");

const router = express.Router();

const TERM_TYPES = ["midterm", "end_of_term", "retake", "final"];

const { getOfferingTypeById } = require("../utils/offeringTypeSettings");

// Corporate Training and Bootcamp programmes don't run on a
// midterm/end-of-term academic-term cycle — the only examination type/name
// available to instructors for them is "Final Examination", regardless of
// that offering type's Assessments settings. Every other offering type
// (Kids STEM, Adult Professional, and any admin-created type) offers
// whichever of Midterm/End Of Term/Retake its own Learning Offering Type
// Settings → Assessments toggles have switched on — these used to be
// display-only (this function always returned the full classic set no
// matter what the toggles said), which is why turning them off/on in the
// Admin Portal never actually changed the instructor's "Type" dropdown.
const FINAL_ONLY_SLUGS = new Set(["corporate_training", "bootcamp"]);
function allowedTermTypesForModule(courseId) {
  const row = db
    .prepare(
      `SELECT t.id AS offering_type_id, t.slug AS offering_type_slug FROM courses m
       LEFT JOIN programmes p ON p.id = m.programme_id
       LEFT JOIN learning_offering_types t ON t.id = p.offering_type_id
       WHERE m.id = ?`
    )
    .get(courseId);
  if (row && FINAL_ONLY_SLUGS.has(row.offering_type_slug)) return ["final"];
  const offeringType = row && row.offering_type_id ? getOfferingTypeById(row.offering_type_id) : null;
  // No resolvable offering type (e.g. a module not yet linked to a
  // Programme) — fall back to the full classic set rather than showing
  // nothing, exactly as before.
  if (!offeringType) return ["midterm", "end_of_term", "retake"];
  const a = offeringType.settings.assessments;
  const types = [];
  if (a.midtermExams) types.push("midterm");
  if (a.endOfTermExams) types.push("end_of_term");
  if (a.retakeExams) types.push("retake");
  // Never return a genuinely empty dropdown — an offering type with every
  // Assessments toggle switched off still needs at least one way to author
  // an examination.
  return types.length ? types : ["midterm", "end_of_term", "retake"];
}

function instructorOwnsModule(instructorId, courseId) {
  return instructorHasCourseAccess(instructorId, courseId);
}

function assignedIds(row) {
  if (!row.assigned_learner_ids) return null;
  try {
    return JSON.parse(row.assigned_learner_ids);
  } catch (e) {
    return null;
  }
}

// A retake exam is only visible/sittable by the learners it was assigned to;
// midterm/end_of_term behave exactly as before (visible to the whole class).
function visibleToLearner(row, learnerId) {
  if (row.term_type !== "retake") return true;
  const ids = assignedIds(row);
  return Array.isArray(ids) && ids.includes(learnerId);
}

function toPublicExam(row, { includeAnswers } = {}) {
  const questions = JSON.parse(row.questions).map((q) => (includeAnswers ? q : { question: q.question, choices: q.choices }));
  return {
    id: row.id,
    courseId: row.course_id,
    classId: row.class_id,
    title: row.title,
    termType: row.term_type,
    questions,
    questionCount: questions.length,
    createdBy: row.created_by,
    createdAt: row.created_at,
    assignedLearnerIds: row.term_type === "retake" ? assignedIds(row) || [] : undefined,
    closesAt: row.closes_at || null,
    timedEnabled: !!row.timed_enabled,
    durationMinutes: row.duration_minutes || null,
  };
}

function safeParseAnswers(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function toPublicAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status || "submitted", // in_progress | submitted | expired | violation
    startedAt: row.started_at || null,
    deadlineAt: row.deadline_at || null,
    violationCount: row.violation_count || 0,
    endedReason: row.ended_reason || (row.status === "submitted" || !row.status ? "submitted" : null),
    score: row.status === "in_progress" ? null : row.score,
    submittedAt: row.status === "in_progress" ? null : row.submitted_at,
    // Only surfaced while in_progress — lets the React learner client
    // restore previously-autosaved selections on a page refresh/reopen
    // (the attempt's own deadline_at already makes that safe: this can
    // never extend or reset a timer, it only redisplays what was already
    // saved). Omitted entirely once ended so every other existing
    // consumer of toPublicAttempt (instructor results tables, "mine"
    // history) is byte-for-byte unchanged.
    answers: row.status === "in_progress" ? safeParseAnswers(row.answers) : undefined,
  };
}

// Fetches or lazily creates the one attempt row a learner may have for this
// examination. Existing pre-migration rows already carry a real score and
// default to status='submitted' (see migrate.js v15) — they're returned
// as-is, never re-created.
function getOrStartAttempt(exam, userId) {
  let row = db.prepare("SELECT * FROM examination_attempts WHERE examination_id = ? AND user_id = ?").get(exam.id, userId);
  if (row) return row;
  const startedAt = new Date().toISOString();
  const deadlineAt = computeDeadline(exam, startedAt);
  const id = uuid();
  // ABRS v2.2 Compliance Remediation: when the exam row itself carries no
  // term_id (a legacy exam predating this stamping, or one created before
  // its module's Run had an Academic Period linked to a Term), fall back
  // to this module's own Active Programme Run -> Academic Period ->
  // Academic Term (§8.2/§19) — never an institution-wide "active term"
  // resolved independently of this exam's own module/Run.
  const attemptTermId = exam.term_id || resolveConstitutionalTermIdForCourse(exam.course_id);
  const learningInstanceId = getActiveInstanceIdForCourse(exam.course_id);
  db.prepare(
    `INSERT INTO examination_attempts
       (id, examination_id, user_id, answers, score, submitted_at, term_id, learning_instance_id,
        started_at, deadline_at, status, violation_count, ended_reason)
     VALUES (?, ?, ?, '[]', 0, datetime('now'), ?, ?, ?, ?, 'in_progress', 0, NULL)`
  ).run(id, exam.id, userId, attemptTermId, learningInstanceId, startedAt, deadlineAt);
  return db.prepare("SELECT * FROM examination_attempts WHERE id = ?").get(id);
}

function gradeExam(exam, answers) {
  const questions = JSON.parse(exam.questions);
  let correct = 0;
  questions.forEach((q, i) => { if (answers && Number(answers[i]) === Number(q.correctIndex)) correct++; });
  const score = Math.round((correct / questions.length) * 100);
  return { score, correctAnswers: questions.map((q) => q.correctIndex) };
}

// Permanently ends an in-progress attempt (normal submission, expiry, or a
// second tab/window violation) using the same grading + retake bookkeeping
// regardless of which of those three ended it — once ended it can never be
// resumed or re-graded (enforced by requiring status='in_progress' in the
// UPDATE's WHERE clause).
function finalizeAttempt(exam, attempt, { answers, endedReason }) {
  const { score } = gradeExam(exam, answers);
  const info = db
    .prepare(
      `UPDATE examination_attempts
         SET answers = ?, score = ?, submitted_at = datetime('now'), status = ?, ended_reason = ?
       WHERE id = ? AND status = 'in_progress'`
    )
    .run(JSON.stringify(Array.isArray(answers) ? answers : []), score, endedReason, endedReason, attempt.id);
  if (info.changes === 0) return null; // already finalized by a concurrent request
  if (exam.term_type === "retake" && attempt.term_id) {
    const result = moduleResult(attempt.user_id, exam.course_id, attempt.term_id);
    db.prepare(
      `INSERT INTO retake_attempts (id, learner_id, course_id, term_id, examination_id, score, new_total, new_grade, new_interpretation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuid(), attempt.user_id, exam.course_id, attempt.term_id, exam.id, score, result.total, result.grade, result.interpretation);
  }
  return score;
}

// Instructor/admin: which enrolled learners currently need a Retake exam for
// this module, determined only from their transcript for the active
// Academic Term (or an explicitly requested historical term, for review).
router.get("/retake-eligible/:courseId", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  if (req.user.role === "instructor" && !instructorOwnsModule(req.user.id, req.params.courseId)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  // ABRS v2.2 Compliance Remediation: retake eligibility derives from this
  // module's own Active Programme Run -> Academic Period -> Academic Term
  // (§8.2/§19), never an institution-wide active term.
  const termId = resolveConstitutionalTermIdForCourse(req.params.courseId);
  if (!termId) {
    return res.status(409).json({
      error: "This module's Programme Run has no Academic Period linked to an Academic Term yet — an admin must configure the Run's Academic Calendar first.",
    });
  }
  res.json({ learners: retakeEligibleLearners(req.params.courseId, termId) });
});

// Instructor/admin: which examination type(s) this module supports — used
// by the "Create examination" UI to show only "Final Examination" for
// Corporate Training / Bootcamp modules, and the classic
// midterm/end-of-term/retake set for everything else.
router.get("/term-types/:courseId", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  res.json({ termTypes: allowedTermTypesForModule(req.params.courseId) });
});

// Instructor/admin: author a midterm, end-of-term, or retake MCQ examination.
// Questions are supplied with the correct answer up front (the instructor
// sets the answer key while writing the exam) — grading is fully automatic
// from then on, same principle as the AI lesson quizzes.
router.post("/", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { courseId, classId, title, termType, questions, assignedLearnerIds, learningInstanceId, closesAt, timedEnabled, durationMinutes } = req.body;
  if (!courseId || !title || !TERM_TYPES.includes(termType)) {
    return res.status(400).json({ error: "courseId, title and a valid termType ('midterm', 'end_of_term', 'retake' or 'final') are required." });
  }
  if (closesAt != null && closesAt !== "" && isNaN(new Date(closesAt).getTime())) {
    return res.status(400).json({ error: "closesAt must be a valid date/time." });
  }
  if (timedEnabled && (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) <= 0)) {
    return res.status(400).json({ error: "Set a positive duration (in minutes) when a timed attempt is enabled." });
  }
  const allowed = allowedTermTypesForModule(courseId);
  if (!allowed.includes(termType)) {
    return res.status(400).json({ error: `This module only supports the following examination type(s): ${allowed.join(", ")}.` });
  }
  if (!Array.isArray(questions) || questions.length < 1) {
    return res.status(400).json({ error: "At least one question is required." });
  }
  for (const q of questions) {
    if (!q.question || !Array.isArray(q.choices) || q.choices.length < 2 || q.correctIndex == null) {
      return res.status(400).json({ error: "Each question needs text, at least 2 choices, and a correctIndex." });
    }
  }
  if (req.user.role === "instructor" && !instructorOwnsModule(req.user.id, courseId)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }

  // Same "explicit pick, validated against the module and the instructor's
  // own assignments; else fall back to the module's active run" rule as
  // notes.js — see instructorProgrammeAndCourseIds/instanceBelongsToInstructor.
  let resolvedInstanceId;
  if (learningInstanceId) {
    const instance = getLearningInstanceById(learningInstanceId);
    if (!instance || (instance.courseId !== courseId && !instanceTargetsCourse(instance.id, courseId))) {
      return res.status(400).json({ error: "learningInstanceId does not belong to this module." });
    }
    if (req.user.role === "instructor" && !instanceBelongsToInstructor(req.user.id, instance)) {
      return res.status(403).json({ error: "You haven't been assigned to this Learning Instance." });
    }
    resolvedInstanceId = instance.id;
  } else {
    resolvedInstanceId = getActiveInstanceIdForCourse(courseId);
  }

  // ABRS v2.2 Compliance Remediation: an examination's term_id derives
  // from THE SAME Learning Instance just resolved above -> its current
  // Academic Period -> Academic Term (§8.2/§19) — resolving learning_
  // instance_id and term_id from one shared chain, rather than two
  // independent lookups that could disagree when an explicit
  // learningInstanceId is picked. Never an institution-wide active term.
  const activeTermId = resolveConstitutionalTermId(resolvedInstanceId);
  if (!activeTermId) {
    return res.status(409).json({
      error: "This Programme Run has no Academic Period linked to an Academic Term yet — an admin must configure the Run's Academic Calendar first.",
    });
  }

  let assignedJson = null;
  if (termType === "retake") {
    if (!Array.isArray(assignedLearnerIds) || assignedLearnerIds.length < 1) {
      return res.status(400).json({ error: "Select at least one Retake-eligible learner to assign this examination to." });
    }
    // Only allow assigning learners who are actually Retake-eligible for this
    // module, per their transcript for the active Academic Term.
    const eligibleIds = new Set(retakeEligibleLearners(courseId, activeTermId).map((l) => l.id));
    const invalid = assignedLearnerIds.filter((id) => !eligibleIds.has(id));
    if (invalid.length) {
      return res.status(400).json({ error: "One or more selected learners are not Retake-eligible for this module." });
    }
    assignedJson = JSON.stringify(assignedLearnerIds);
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO examinations (id, course_id, class_id, title, term_type, questions, created_by, created_at, assigned_learner_ids, term_id, learning_instance_id, closes_at, timed_enabled, duration_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`
  ).run(
    id, courseId, classId || null, title, termType, JSON.stringify(questions), req.user.name, assignedJson, activeTermId, resolvedInstanceId,
    closesAt || null, timedEnabled ? 1 : 0, timedEnabled ? Number(durationMinutes) : null
  );
  res.json({ ok: true, id });
});

// Anyone signed in: list exams for a module (learners see them to know
// what's available; correct answers are always stripped here). Retake exams
// are filtered out here for learners who weren't assigned to them.
// Scoped to a single Academic Term by default (?termId= for staff
// reviewing a specific known historical term) so a past term's
// midterm/end-of-term exams don't show as currently available once the
// term has moved on. ABRS v2.2 Compliance Remediation: the default
// (no ?termId=) case no longer applies one institution-wide "active term"
// uniformly across every module — each exam row is checked against its
// OWN module's Active Programme Run -> Academic Period -> Academic Term
// (§8.2/§19), since two modules can legitimately be on two different Runs
// with two different current terms.
router.get("/", requireAuth, requireActiveAccessSelf, (req, res) => {
  const { courseId, learningInstanceId, classId } = req.query;
  const explicitTermId = req.query.termId || null;
  let rows = courseId
    ? db.prepare("SELECT * FROM examinations WHERE course_id = ? ORDER BY created_at DESC").all(courseId)
    : db.prepare("SELECT * FROM examinations ORDER BY created_at DESC").all();
  if (learningInstanceId) rows = rows.filter((r) => r.learning_instance_id === learningInstanceId);
  if (classId) rows = rows.filter((r) => !r.class_id || r.class_id === classId);
  if (explicitTermId) {
    rows = rows.filter((r) => !r.term_id || r.term_id === explicitTermId);
  } else {
    const courseTermIdCache = new Map();
    const currentTermForCourse = (cid) => {
      if (!cid) return null;
      if (!courseTermIdCache.has(cid)) courseTermIdCache.set(cid, resolveConstitutionalTermIdForCourse(cid));
      return courseTermIdCache.get(cid);
    };
    rows = rows.filter((r) => !r.term_id || r.term_id === currentTermForCourse(r.course_id));
  }
  if (req.user.role === "learner") {
    rows = rows.filter((r) => visibleToLearner(r, req.user.id));
  }
  res.json({
    examinations: rows.map((r) => {
      const pub = toPublicExam(r, { includeAnswers: req.user.role !== "learner" });
      if (req.user.role === "learner") {
        pub.myAttempt = toPublicAttempt(db.prepare("SELECT * FROM examination_attempts WHERE examination_id = ? AND user_id = ?").get(r.id, req.user.id));
      }
      return pub;
    }),
  });
});

// One exam's full detail — answers included only for instructor/admin.
router.get("/:id", requireAuth, requireActiveAccessSelf, (req, res) => {
  const row = db.prepare("SELECT * FROM examinations WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Examination not found." });
  if (req.user.role === "learner" && !visibleToLearner(row, req.user.id)) {
    return res.status(404).json({ error: "Examination not found." });
  }
  const pub = toPublicExam(row, { includeAnswers: req.user.role !== "learner" });
  if (req.user.role === "learner") {
    pub.myAttempt = toPublicAttempt(db.prepare("SELECT * FROM examination_attempts WHERE examination_id = ? AND user_id = ?").get(row.id, req.user.id));
  }
  res.json(pub);
});

// Learner: start (or resume) an attempt. Server-authoritative — the timer
// deadline is computed here from the exam's closing date/timed-duration
// config and persisted on the attempt row, so a page refresh/reopen neither
// resets nor extends it. Idempotent: calling this again for an
// already-in-progress attempt just returns its existing (unchanged)
// started_at/deadline_at rather than starting a fresh timer.
router.post("/:id/start", requireAuth, requireRole("learner"), requireActiveAccessSelf, (req, res) => {
  const exam = db.prepare("SELECT * FROM examinations WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ error: "Examination not found." });
  if (!visibleToLearner(exam, req.user.id)) {
    return res.status(403).json({ error: "This examination wasn't assigned to you." });
  }
  // Root-cause fix (period-payment enforcement): same per-Course
  // period-payment decision routes/modules.js's lessons gate already
  // applies — see utils/periodPayments.js.
  const periodDecision = periodAccessDecisionForCourse(req.user, exam.course_id);
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);
  if (expiryReason(exam, {}) === "closing_date") {
    return res.status(403).json({ error: "This examination's closing date/time has passed." });
  }
  let attempt = getOrStartAttempt(exam, req.user.id);
  if (attempt.status === "in_progress") {
    const reason = expiryReason(exam, attempt);
    if (reason) {
      finalizeAttempt(exam, attempt, { answers: JSON.parse(attempt.answers || "[]"), endedReason: reason });
      attempt = db.prepare("SELECT * FROM examination_attempts WHERE id = ?").get(attempt.id);
    }
  } else {
    return res.status(409).json({ error: "You've already sat this examination.", attempt: toPublicAttempt(attempt) });
  }
  res.json({ ok: true, attempt: toPublicAttempt(attempt) });
});

// Learner: report a detected loss of visibility/focus on the active
// attempt. First violation -> warning only. Second -> the attempt is ended
// immediately (graded with whatever answers were provided, or 0 if none).
// Persisted server-side so a refresh or client manipulation can't reset the
// count, matching the one-attempt model's enforcement.
// Learner: autosave in-progress answers. The server is otherwise only ever
// handed the learner's answers at the moment of an explicit submit or a
// violation report — if the attempt instead ends because a *later* request
// (e.g. reopening the page, or the periodic status poll) notices the
// deadline has already passed, finalizeAttempt() would fall back to
// whatever answers are currently stored on the row. Without this endpoint
// that fallback would always be the empty '[]' the row started with, even
// though the learner may have answered several questions before running out
// of time. The client calls this periodically/on-change while an attempt is
// in progress purely to keep that fallback current; it never grades or ends
// anything by itself.
router.post("/:id/answers", requireAuth, requireRole("learner"), requireActiveAccessSelf, (req, res) => {
  const { answers } = req.body;
  const exam = db.prepare("SELECT * FROM examinations WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ error: "Examination not found." });
  const attempt = db.prepare("SELECT * FROM examination_attempts WHERE examination_id = ? AND user_id = ?").get(exam.id, req.user.id);
  if (!attempt || attempt.status !== "in_progress") return res.status(409).json({ error: "No active attempt to save answers against." });
  if (expiryReason(exam, attempt)) return res.status(409).json({ error: "Time's up — answers can no longer be saved." });
  const questions = JSON.parse(exam.questions);
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return res.status(400).json({ error: `Expected ${questions.length} answer(s).` });
  }
  db.prepare("UPDATE examination_attempts SET answers = ? WHERE id = ? AND status = 'in_progress'").run(JSON.stringify(answers), attempt.id);
  res.json({ ok: true });
});

router.post("/:id/violation", requireAuth, requireRole("learner"), requireActiveAccessSelf, (req, res) => {
  const exam = db.prepare("SELECT * FROM examinations WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ error: "Examination not found." });
  let attempt = db.prepare("SELECT * FROM examination_attempts WHERE examination_id = ? AND user_id = ?").get(exam.id, req.user.id);
  if (!attempt || attempt.status !== "in_progress") {
    return res.status(409).json({ error: "No active attempt to record a violation against." });
  }
  const reason = expiryReason(exam, attempt);
  if (reason) {
    finalizeAttempt(exam, attempt, { answers: JSON.parse(attempt.answers || "[]"), endedReason: reason });
    attempt = db.prepare("SELECT * FROM examination_attempts WHERE id = ?").get(attempt.id);
    return res.json({ ok: true, ended: true, attempt: toPublicAttempt(attempt) });
  }
  const info = db
    .prepare("UPDATE examination_attempts SET violation_count = violation_count + 1 WHERE id = ? AND status = 'in_progress'")
    .run(attempt.id);
  attempt = db.prepare("SELECT * FROM examination_attempts WHERE id = ?").get(attempt.id);
  if (info.changes === 0 || attempt.status !== "in_progress") {
    return res.json({ ok: true, ended: true, attempt: toPublicAttempt(attempt) });
  }
  if (attempt.violation_count >= 2) {
    const { answers } = req.body || {};
    finalizeAttempt(exam, attempt, { answers, endedReason: "violation" });
    attempt = db.prepare("SELECT * FROM examination_attempts WHERE id = ?").get(attempt.id);
    return res.json({ ok: true, ended: true, attempt: toPublicAttempt(attempt) });
  }
  res.json({ ok: true, ended: false, attempt: toPublicAttempt(attempt) });
});

// Learner: submit answers for auto-grading. One attempt per exam (matches
// how a real midterm/end-of-term/retake sitting works) — resits need a fresh
// exam or an admin-cleared attempt, not a silent retake. Always finalizes
// the attempt row created/resumed by /start (creating one on the fly for any
// older client that calls submit directly, so non-timed/no-deadline exams
// keep working exactly as before).
router.post("/:id/attempt", requireAuth, requireRole("learner"), requireActiveAccessSelf, (req, res) => {
  const { answers } = req.body;
  const exam = db.prepare("SELECT * FROM examinations WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ error: "Examination not found." });
  if (!visibleToLearner(exam, req.user.id)) {
    return res.status(403).json({ error: "This examination wasn't assigned to you." });
  }
  // Root-cause fix (period-payment enforcement): same per-Course
  // period-payment decision routes/modules.js's lessons gate already
  // applies — see utils/periodPayments.js.
  const periodDecision = periodAccessDecisionForCourse(req.user, exam.course_id);
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);
  let attempt = getOrStartAttempt(exam, req.user.id);
  if (attempt.status !== "in_progress") {
    return res.status(409).json({ error: "You've already sat this examination." });
  }
  const questions = JSON.parse(exam.questions);
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return res.status(400).json({ error: `Expected ${questions.length} answer(s).` });
  }
  const reason = expiryReason(exam, attempt);
  const score = finalizeAttempt(exam, attempt, { answers, endedReason: reason || "submitted" });
  if (score === null) return res.status(409).json({ error: "You've already sat this examination." });
  if (reason) {
    return res.status(409).json({
      error: reason === "closing_date" ? "This examination's closing date/time passed — your attempt was automatically ended." : "Time's up — your attempt was automatically submitted.",
      score,
    });
  }
  const { correctAnswers } = gradeExam(exam, answers);
  res.json({ ok: true, score, correctAnswers });
});

// Instructor/admin: every learner's result for one examination.
router.get("/:id/attempts", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const exam = db.prepare("SELECT * FROM examinations WHERE id = ?").get(req.params.id);
  if (!exam) return res.status(404).json({ error: "Examination not found." });
  if (req.user.role === "instructor" && !instructorOwnsModule(req.user.id, exam.course_id)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  const rows = db
    .prepare(
      `SELECT a.*, u.name as learner_name FROM examination_attempts a
       JOIN users u ON u.id = a.user_id WHERE a.examination_id = ? ORDER BY a.submitted_at DESC`
    )
    .all(req.params.id);
  res.json({ attempts: rows.map((r) => ({ ...r, score: r.status === "in_progress" ? null : r.score })) });
});

// Self/parent/staff: one learner's own exam results across every
// examination — this is what parents and instructors see too.
router.get("/mine/:userId", requireAuth, requireSelfParentOrStaff("userId"), requireActiveAccess("userId"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.score, a.submitted_at, a.status, a.ended_reason, a.violation_count, e.id as examination_id, e.title, e.term_type, e.course_id
       FROM examination_attempts a JOIN examinations e ON e.id = a.examination_id
       WHERE a.user_id = ? ORDER BY a.submitted_at DESC`
    )
    .all(req.params.userId);
  // In-progress attempts have no real score yet (a 0 placeholder row backs
  // the timer/violation state) — never surface them as a completed result.
  res.json({ results: rows.filter((r) => r.status !== "in_progress") });
});

module.exports = router;
