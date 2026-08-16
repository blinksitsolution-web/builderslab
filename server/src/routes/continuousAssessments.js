const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requireSelfParentOrStaff, requireActiveAccessSelf, requireActiveAccess } = require("../middleware/auth");
const { getActiveInstanceIdForCourse, getLearningInstanceById, instanceBelongsToInstructor, instanceTargetsCourse } = require("../utils/learningInstances");
const { instructorHasCourseAccess, instructorHasClassAccess } = require("../utils/instructorScope");
const { computeDeadline, expiryReason } = require("../utils/assessmentTiming");
const { periodAccessDecisionForCourse, sendPeriodAccessDenied } = require("../utils/periodPayments");

const router = express.Router();

// Question types supported today. Deliberately not a DB CHECK constraint —
// `ca_questions.type` is free text — so new types can be added later without
// touching the schema or this validation list.
const QUESTION_TYPES = ["mcq", "true_false"];

function instructorOwnsModule(instructorId, courseId) {
  return instructorHasCourseAccess(instructorId, courseId);
}

// Examination and Continuous Assessment Ownership: an instructor assigned to
// this Module may VIEW/USE any Continuous Assessment created for it (shared
// academic scope — e.g. two instructors covering the same Module) — that's
// already what GET/list below does, unchanged. But only the instructor who
// actually authored it may edit/publish/unpublish/delete it; a co-instructor
// on the same Module is not automatically granted write access to someone
// else's assessment (no explicit permission for that exists in this
// codebase yet — this is the "default" the prompt asks for). Admin is
// always exempt.
function assertCanManageAssessment(req, row) {
  if (req.user.role === "instructor" && row.created_by !== req.user.name) {
    return "Only the instructor who created this Continuous Assessment can edit, publish, unpublish, or delete it.";
  }
  return null;
}

// A learner must have watched the video lesson / read the note before taking
// its Continuous Assessment — same gating rule already used for AI quizzes.
// Video lessons and notes both write to `progress` keyed by a synthetic
// lesson_id ("vlesson:<noteId>" or "note:<noteId>"); we don't know which one
// applies here without the note's kind, so we just check both.
function learnerCompletedLesson(userId, courseId, noteId) {
  const row = db
    .prepare(
      `SELECT 1 FROM progress
       WHERE user_id = ? AND course_id = ? AND lesson_id IN (?, ?) AND watched_seconds > 0`
    )
    .get(userId, courseId, `vlesson:${noteId}`, `note:${noteId}`);
  return !!row;
}

function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1) return "At least one question is required.";
  for (const q of questions) {
    if (!q.question || typeof q.question !== "string") return "Every question needs question text.";
    if (!QUESTION_TYPES.includes(q.type)) return `Question type must be one of: ${QUESTION_TYPES.join(", ")}.`;
    if (q.type === "mcq") {
      if (!Array.isArray(q.options) || q.options.length !== 4) return "Multiple Choice questions need exactly 4 options.";
    } else if (q.type === "true_false") {
      q.options = ["True", "False"];
    }
    if (q.correctAnswer == null || q.correctAnswer < 0 || q.correctAnswer >= q.options.length) {
      return "Every question needs a valid correct answer.";
    }
    if (q.marks == null || Number(q.marks) <= 0) return "Every question needs marks greater than 0.";
  }
  return null;
}

function toPublicAssessment(row, { includeAnswers } = {}) {
  const questions = db.prepare("SELECT * FROM ca_questions WHERE assessment_id = ? ORDER BY sort_order ASC").all(row.id);
  return {
    id: row.id,
    courseId: row.course_id,
    noteId: row.note_id,
    classId: row.class_id,
    title: row.title,
    published: !!row.published,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    maxMarks: questions.reduce((sum, q) => sum + q.marks, 0),
    questions: questions.map((q) => ({
      id: q.id,
      type: q.type,
      question: q.question,
      options: JSON.parse(q.options),
      marks: q.marks,
      ...(includeAnswers ? { correctAnswer: q.correct_answer } : {}),
    })),
    closesAt: row.closes_at || null,
    timedEnabled: !!row.timed_enabled,
    durationMinutes: row.duration_minutes || null,
  };
}

function safeParseCaAnswers(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function toPublicCaAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status || "submitted",
    startedAt: row.started_at || null,
    deadlineAt: row.deadline_at || null,
    violationCount: row.violation_count || 0,
    endedReason: row.ended_reason || (row.status === "submitted" || !row.status ? "submitted" : null),
    totalMarks: row.status === "in_progress" ? null : row.total_marks,
    maxMarks: row.status === "in_progress" ? null : row.max_marks,
    percentage: row.status === "in_progress" ? null : row.percentage,
    submittedAt: row.status === "in_progress" ? null : row.submitted_at,
    // See exams.js's toPublicAttempt for the rationale — same additive,
    // in-progress-only field so the learner client can restore
    // previously-autosaved selections after a refresh.
    answers: row.status === "in_progress" ? safeParseCaAnswers(row.answers) : undefined,
  };
}

// Fetches or lazily creates the one attempt row a learner may have for this
// Continuous Assessment — same lazy-start pattern as exams.js's
// getOrStartAttempt, kept as a separate function since ca_attempts has its
// own columns (total_marks/max_marks/percentage vs examinations' score).
function getOrStartCaAttempt(assessment, userId) {
  let row = db.prepare("SELECT * FROM ca_attempts WHERE assessment_id = ? AND user_id = ?").get(assessment.id, userId);
  if (row) return row;
  const startedAt = new Date().toISOString();
  const deadlineAt = computeDeadline(assessment, startedAt);
  const id = uuid();
  const learningInstanceId = getActiveInstanceIdForCourse(assessment.course_id);
  db.prepare(
    `INSERT INTO ca_attempts
       (id, assessment_id, user_id, answers, total_marks, max_marks, percentage, submitted_at, learning_instance_id,
        started_at, deadline_at, status, violation_count, ended_reason)
     VALUES (?, ?, ?, '[]', 0, 0, 0, datetime('now'), ?, ?, ?, 'in_progress', 0, NULL)`
  ).run(id, assessment.id, userId, learningInstanceId, startedAt, deadlineAt);
  return db.prepare("SELECT * FROM ca_attempts WHERE id = ?").get(id);
}

function gradeCa(questions, answers) {
  let totalMarks = 0;
  const maxMarks = questions.reduce((sum, q) => sum + q.marks, 0);
  questions.forEach((q, i) => {
    if (answers && Number(answers[i]) === Number(q.correct_answer)) totalMarks += q.marks;
  });
  const percentage = maxMarks ? Math.round((totalMarks / maxMarks) * 100) : 0;
  return { totalMarks, maxMarks, percentage, correctAnswers: questions.map((q) => q.correct_answer) };
}

// Permanently ends an in-progress CA attempt (normal submission, expiry, or
// a second tab/window violation). Once ended it can never be resumed or
// re-graded (enforced by requiring status='in_progress' in the WHERE
// clause).
function finalizeCaAttempt(assessment, attempt, { answers, endedReason }) {
  const questions = db.prepare("SELECT * FROM ca_questions WHERE assessment_id = ? ORDER BY sort_order ASC").all(assessment.id);
  const { totalMarks, maxMarks, percentage } = gradeCa(questions, answers);
  const info = db
    .prepare(
      `UPDATE ca_attempts
         SET answers = ?, total_marks = ?, max_marks = ?, percentage = ?, submitted_at = datetime('now'), status = ?, ended_reason = ?
       WHERE id = ? AND status = 'in_progress'`
    )
    .run(JSON.stringify(Array.isArray(answers) ? answers : []), totalMarks, maxMarks, percentage, endedReason, endedReason, attempt.id);
  if (info.changes === 0) return null; // already finalized by a concurrent request
  return { totalMarks, maxMarks, percentage };
}

function saveQuestions(assessmentId, questions) {
  db.prepare("DELETE FROM ca_questions WHERE assessment_id = ?").run(assessmentId);
  const insert = db.prepare(
    `INSERT INTO ca_questions (id, assessment_id, type, question, options, correct_answer, marks, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  questions.forEach((q, i) => {
    insert.run(uuid(), assessmentId, q.type, q.question, JSON.stringify(q.options), Number(q.correctAnswer), Number(q.marks), i);
  });
}

// Instructor/admin: create a Continuous Assessment attached to a video
// lesson or note (`noteId` is the notes.id either way). Completely
// independent of the AI-generated quiz and of the Examination panel.
router.post("/", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { courseId, noteId, title, questions, closesAt, timedEnabled, durationMinutes, learningInstanceId, classId } = req.body;
  if (!courseId || !noteId || !title) {
    return res.status(400).json({ error: "courseId, noteId and title are required." });
  }
  const note = db.prepare("SELECT id FROM notes WHERE id = ? AND course_id = ? AND kind IN ('video_lesson','note')").get(noteId, courseId);
  if (!note) return res.status(404).json({ error: "Video lesson or note not found." });
  if (req.user.role === "instructor") {
    if (!instructorOwnsModule(req.user.id, courseId)) {
      return res.status(403).json({ error: "You haven't been assigned to this module." });
    }
    // Instructor-portal filter consistency pass: same Class-scoping
    // Notes/Examinations already support (class_id was missing from this
    // table entirely until now — see migrate.js).
    if (classId && !instructorHasClassAccess(req.user.id, classId)) {
      return res.status(403).json({ error: "You haven't been assigned to this class." });
    }
  }
  const qError = validateQuestions(questions);
  if (qError) return res.status(400).json({ error: qError });
  if (closesAt != null && closesAt !== "" && isNaN(new Date(closesAt).getTime())) {
    return res.status(400).json({ error: "closesAt must be a valid date/time." });
  }
  if (timedEnabled && (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) <= 0)) {
    return res.status(400).json({ error: "Set a positive duration (in minutes) when a timed attempt is enabled." });
  }

  // ABRS v2.2 amendment (concurrent Programme Runs): same "explicit pick,
  // validated against the module and the instructor's own assignments;
  // else fall back to the module's active run" rule as exams.js/notes.js
  // — see instanceBelongsToInstructor. Without this, a module with more
  // than one currently-Active Run would always silently fall back to
  // getActiveInstanceIdForCourse's "most recently activated" default,
  // which could attach this Continuous Assessment to a Run the instructor
  // isn't even teaching.
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

  const id = uuid();
  db.prepare(
    `INSERT INTO continuous_assessments (id, course_id, note_id, title, published, created_by, created_at, updated_at, learning_instance_id, closes_at, timed_enabled, duration_minutes, class_id)
     VALUES (?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'), ?, ?, ?, ?, ?)`
  ).run(id, courseId, noteId, title, req.user.name, resolvedInstanceId, closesAt || null, timedEnabled ? 1 : 0, timedEnabled ? Number(durationMinutes) : null, classId || null);
  saveQuestions(id, questions);
  res.json({ ok: true, id });
});

// List Continuous Assessments for a lesson/note or a whole module. Learners
// only ever see published ones; instructor/admin see everything so they can
// manage drafts.
router.get("/", requireAuth, requireActiveAccessSelf, (req, res) => {
  const { courseId, noteId, classId } = req.query;
  if (!courseId && !noteId) return res.status(400).json({ error: "courseId or noteId is required." });
  let rows;
  if (noteId) {
    rows = db.prepare("SELECT * FROM continuous_assessments WHERE note_id = ? ORDER BY created_at DESC").all(noteId);
  } else {
    rows = db.prepare("SELECT * FROM continuous_assessments WHERE course_id = ? ORDER BY created_at DESC").all(courseId);
  }
  if (classId) rows = rows.filter((r) => !r.class_id || r.class_id === classId);
  if (req.user.role === "learner") rows = rows.filter((r) => r.published);
  const includeAnswers = req.user.role !== "learner";
  res.json({
    assessments: rows.map((r) => {
      const pub = toPublicAssessment(r, { includeAnswers });
      if (req.user.role === "learner") {
        const attemptRow = db.prepare("SELECT * FROM ca_attempts WHERE assessment_id = ? AND user_id = ?").get(r.id, req.user.id);
        pub.attempted = !!attemptRow;
        pub.myAttempt = toPublicCaAttempt(attemptRow);
        pub.completedLesson = learnerCompletedLesson(req.user.id, r.course_id, r.note_id);
      }
      return pub;
    }),
  });
});

// One assessment's detail — answers only for instructor/admin.
router.get("/:id", requireAuth, requireActiveAccessSelf, (req, res) => {
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Continuous Assessment not found." });
  if (req.user.role === "learner" && !row.published) return res.status(404).json({ error: "Continuous Assessment not found." });
  const includeAnswers = req.user.role !== "learner";
  const pub = toPublicAssessment(row, { includeAnswers });
  if (req.user.role === "learner") {
    const attemptRow = db.prepare("SELECT * FROM ca_attempts WHERE assessment_id = ? AND user_id = ?").get(row.id, req.user.id);
    pub.attempted = !!attemptRow;
    pub.myAttempt = toPublicCaAttempt(attemptRow);
    pub.completedLesson = learnerCompletedLesson(req.user.id, row.course_id, row.note_id);
  }
  res.json(pub);
});

// Instructor/admin: edit questions/title. Editing doesn't touch attempts
// already on file (permanent record), but a re-edit after learners have
// attempted should generally be paired with unpublishing first.
router.patch("/:id", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Continuous Assessment not found." });
  if (req.user.role === "instructor" && !instructorOwnsModule(req.user.id, row.course_id)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  const ownerError = assertCanManageAssessment(req, row);
  if (ownerError) return res.status(403).json({ error: ownerError });
  const { title, questions, closesAt, timedEnabled, durationMinutes } = req.body;
  if (questions) {
    const qError = validateQuestions(questions);
    if (qError) return res.status(400).json({ error: qError });
    saveQuestions(row.id, questions);
  }
  if (closesAt != null && closesAt !== "" && isNaN(new Date(closesAt).getTime())) {
    return res.status(400).json({ error: "closesAt must be a valid date/time." });
  }
  if (timedEnabled && (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) <= 0)) {
    return res.status(400).json({ error: "Set a positive duration (in minutes) when a timed attempt is enabled." });
  }
  const nextClosesAt = closesAt !== undefined ? (closesAt || null) : row.closes_at;
  const nextTimedEnabled = timedEnabled !== undefined ? (timedEnabled ? 1 : 0) : row.timed_enabled;
  const nextDuration = timedEnabled !== undefined ? (timedEnabled ? Number(durationMinutes) : null) : row.duration_minutes;
  db.prepare(
    "UPDATE continuous_assessments SET title = ?, closes_at = ?, timed_enabled = ?, duration_minutes = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title || row.title, nextClosesAt, nextTimedEnabled, nextDuration, row.id);
  res.json({ ok: true });
});

router.post("/:id/publish", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Continuous Assessment not found." });
  if (req.user.role === "instructor" && !instructorOwnsModule(req.user.id, row.course_id)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  const ownerError = assertCanManageAssessment(req, row);
  if (ownerError) return res.status(403).json({ error: ownerError });
  const questionCount = db.prepare("SELECT COUNT(*) as n FROM ca_questions WHERE assessment_id = ?").get(row.id).n;
  if (!questionCount) return res.status(400).json({ error: "Add at least one question before publishing." });
  db.prepare("UPDATE continuous_assessments SET published = 1, updated_at = datetime('now') WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

router.post("/:id/unpublish", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Continuous Assessment not found." });
  if (req.user.role === "instructor" && !instructorOwnsModule(req.user.id, row.course_id)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  const ownerError = assertCanManageAssessment(req, row);
  if (ownerError) return res.status(403).json({ error: ownerError });
  db.prepare("UPDATE continuous_assessments SET published = 0, updated_at = datetime('now') WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

router.delete("/:id", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Continuous Assessment not found." });
  if (req.user.role === "instructor" && !instructorOwnsModule(req.user.id, row.course_id)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  const ownerError = assertCanManageAssessment(req, row);
  if (ownerError) return res.status(403).json({ error: ownerError });
  db.prepare("DELETE FROM continuous_assessments WHERE id = ?").run(row.id); // cascades ca_questions & ca_attempts
  res.json({ ok: true });
});

// Learner: start (or resume) an attempt. Same server-authoritative
// timer/closing-date semantics as exams.js's /:id/start — the deadline is
// computed once at start time and persisted, so it survives refreshes and
// can't be extended by reopening the page.
router.post("/:id/start", requireAuth, requireRole("learner"), requireActiveAccessSelf, (req, res) => {
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row || !row.published) return res.status(404).json({ error: "Continuous Assessment not found." });
  // Root-cause fix (period-payment enforcement): same per-Course
  // period-payment decision routes/modules.js's lessons gate already
  // applies — see utils/periodPayments.js.
  const periodDecision = periodAccessDecisionForCourse(req.user, row.course_id);
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);
  if (!learnerCompletedLesson(req.user.id, row.course_id, row.note_id)) {
    return res.status(403).json({ error: "Finish watching the lesson or reading the note before taking this assessment." });
  }
  if (expiryReason(row, {}) === "closing_date") {
    return res.status(403).json({ error: "This assessment's closing date/time has passed." });
  }
  let attempt = getOrStartCaAttempt(row, req.user.id);
  if (attempt.status === "in_progress") {
    const reason = expiryReason(row, attempt);
    if (reason) {
      finalizeCaAttempt(row, attempt, { answers: JSON.parse(attempt.answers || "[]"), endedReason: reason });
      attempt = db.prepare("SELECT * FROM ca_attempts WHERE id = ?").get(attempt.id);
    }
  } else {
    return res.status(409).json({ error: "You've already completed this assessment.", attempt: toPublicCaAttempt(attempt) });
  }
  res.json({ ok: true, attempt: toPublicCaAttempt(attempt) });
});

// Learner: report a detected loss of visibility/focus on the active
// attempt. First violation -> warning only; second ends the attempt
// immediately. Persisted server-side, same as exams.js.
// Learner: autosave in-progress answers — same rationale as exams.js's
// /:id/answers: keeps the row's answers current so a server-detected
// expiry (rather than a live submit/violation call) doesn't finalize with
// no recorded answers.
router.post("/:id/answers", requireAuth, requireRole("learner"), requireActiveAccessSelf, (req, res) => {
  const { answers } = req.body;
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Continuous Assessment not found." });
  const attempt = db.prepare("SELECT * FROM ca_attempts WHERE assessment_id = ? AND user_id = ?").get(row.id, req.user.id);
  if (!attempt || attempt.status !== "in_progress") return res.status(409).json({ error: "No active attempt to save answers against." });
  if (expiryReason(row, attempt)) return res.status(409).json({ error: "Time's up — answers can no longer be saved." });
  const questions = db.prepare("SELECT * FROM ca_questions WHERE assessment_id = ? ORDER BY sort_order ASC").all(row.id);
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return res.status(400).json({ error: `Expected ${questions.length} answer(s).` });
  }
  db.prepare("UPDATE ca_attempts SET answers = ? WHERE id = ? AND status = 'in_progress'").run(JSON.stringify(answers), attempt.id);
  res.json({ ok: true });
});

router.post("/:id/violation", requireAuth, requireRole("learner"), requireActiveAccessSelf, (req, res) => {
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Continuous Assessment not found." });
  let attempt = db.prepare("SELECT * FROM ca_attempts WHERE assessment_id = ? AND user_id = ?").get(row.id, req.user.id);
  if (!attempt || attempt.status !== "in_progress") {
    return res.status(409).json({ error: "No active attempt to record a violation against." });
  }
  const reason = expiryReason(row, attempt);
  if (reason) {
    finalizeCaAttempt(row, attempt, { answers: JSON.parse(attempt.answers || "[]"), endedReason: reason });
    attempt = db.prepare("SELECT * FROM ca_attempts WHERE id = ?").get(attempt.id);
    return res.json({ ok: true, ended: true, attempt: toPublicCaAttempt(attempt) });
  }
  const info = db.prepare("UPDATE ca_attempts SET violation_count = violation_count + 1 WHERE id = ? AND status = 'in_progress'").run(attempt.id);
  attempt = db.prepare("SELECT * FROM ca_attempts WHERE id = ?").get(attempt.id);
  if (info.changes === 0 || attempt.status !== "in_progress") {
    return res.json({ ok: true, ended: true, attempt: toPublicCaAttempt(attempt) });
  }
  if (attempt.violation_count >= 2) {
    const { answers } = req.body || {};
    finalizeCaAttempt(row, attempt, { answers, endedReason: "violation" });
    attempt = db.prepare("SELECT * FROM ca_attempts WHERE id = ?").get(attempt.id);
    return res.json({ ok: true, ended: true, attempt: toPublicCaAttempt(attempt) });
  }
  res.json({ ok: true, ended: false, attempt: toPublicCaAttempt(attempt) });
});

// Learner: submit answers — fully automatic marking, saved permanently.
// One attempt per assessment (matches how the Examination panel already
// treats attempts), and completely separate storage from AI quiz scores
// (progress.quiz_score) and Examination attempts (examination_attempts).
// Finalizes the attempt row created/resumed by /start (creating one on the
// fly for any older client that calls submit directly, so a non-timed/
// no-deadline assessment keeps working exactly as before).
router.post("/:id/attempt", requireAuth, requireRole("learner"), requireActiveAccessSelf, (req, res) => {
  const { answers } = req.body;
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row || !row.published) return res.status(404).json({ error: "Continuous Assessment not found." });
  // Root-cause fix (period-payment enforcement): same per-Course
  // period-payment decision routes/modules.js's lessons gate already
  // applies — see utils/periodPayments.js.
  const periodDecision = periodAccessDecisionForCourse(req.user, row.course_id);
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);
  if (!learnerCompletedLesson(req.user.id, row.course_id, row.note_id)) {
    return res.status(403).json({ error: "Finish watching the lesson or reading the note before taking this assessment." });
  }
  let attempt = getOrStartCaAttempt(row, req.user.id);
  if (attempt.status !== "in_progress") {
    return res.status(409).json({ error: "You've already completed this assessment." });
  }
  const questions = db.prepare("SELECT * FROM ca_questions WHERE assessment_id = ? ORDER BY sort_order ASC").all(row.id);
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return res.status(400).json({ error: `Expected ${questions.length} answer(s).` });
  }
  const reason = expiryReason(row, attempt);
  const finalized = finalizeCaAttempt(row, attempt, { answers, endedReason: reason || "submitted" });
  if (finalized === null) return res.status(409).json({ error: "You've already completed this assessment." });
  if (reason) {
    return res.status(409).json({
      error: reason === "closing_date" ? "This assessment's closing date/time passed — your attempt was automatically ended." : "Time's up — your attempt was automatically submitted.",
      ...finalized,
    });
  }
  const { correctAnswers } = gradeCa(questions, answers);
  res.json({ ok: true, ...finalized, correctAnswers });
});

// Instructor/admin: every learner's result for one Continuous Assessment.
router.get("/:id/attempts", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const row = db.prepare("SELECT * FROM continuous_assessments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Continuous Assessment not found." });
  if (req.user.role === "instructor" && !instructorOwnsModule(req.user.id, row.course_id)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  const attempts = db
    .prepare(
      `SELECT a.*, u.name as learner_name FROM ca_attempts a
       JOIN users u ON u.id = a.user_id WHERE a.assessment_id = ? ORDER BY a.submitted_at DESC`
    )
    .all(row.id);
  res.json({ attempts: attempts.map((a) => (a.status === "in_progress" ? { ...a, total_marks: null, max_marks: null, percentage: null } : a)) });
});

// Self/parent/staff: one learner's own Continuous Assessment results across
// every assessment — kept separate from AI quiz scores and Examination
// results, same "mine" convention exams.js already uses.
router.get("/mine/:userId", requireAuth, requireSelfParentOrStaff("userId"), requireActiveAccess("userId"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.total_marks, a.max_marks, a.percentage, a.submitted_at, a.status, a.ended_reason, a.violation_count,
              c.id as assessment_id, c.title, c.course_id, c.note_id
       FROM ca_attempts a JOIN continuous_assessments c ON c.id = a.assessment_id
       WHERE a.user_id = ? ORDER BY a.submitted_at DESC`
    )
    .all(req.params.userId);
  // In-progress attempts have no real marks yet — never surface as a completed result.
  res.json({ results: rows.filter((r) => r.status !== "in_progress") });
});

module.exports = router;
