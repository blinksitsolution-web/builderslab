const express = require("express");
const db = require("../db/db");
const { getLesson } = require("../data/lessons");
const { isVideoNoteItem, videoNoteId, getMergedLesson, getMergedLessons, getNextMergedLessonId, isLearnerEnrolledInCourse, callerCanAccessCourse } = require("../utils/lessonCatalog");
const { generateQuiz, generateNoteQuiz, getStoredQuiz } = require("../utils/ai");
const { requireAuth, requireSelfParentOrStaff, requireActiveAccess, requireActiveAccessSelf } = require("../middleware/auth");
const { getActiveInstanceIdForCourse } = require("../utils/learningInstances");
const { periodAccessDecisionForLearner, periodAccessDecisionForCourse, sendPeriodAccessDenied } = require("../utils/periodPayments");

const router = express.Router();

// Stage 4E: same ownership gate as routes/modules.js's GET
// /:courseId/lessons, but for the routes below (already scoped to an
// explicit :userId via requireSelfParentOrStaff) — checks that specific
// learner's enrollment rather than "any linked child".
function targetEnrolledInModule(req, targetUserId, courseId) {
  if (req.user.role === "instructor" || req.user.role === "admin") return true;
  return isLearnerEnrolledInCourse(targetUserId, courseId);
}

// Notes/slides use a synthetic lesson_id of "note:<id>" so they can reuse
// the exact same progress/quiz-score columns and plumbing as video lessons
// (this is also why parent/instructor views that read progress.quizScores
// automatically pick these up without any extra wiring).
function noteLessonId(noteId) { return `note:${noteId}`; }
function isNoteItem(itemId) { return typeof itemId === "string" && itemId.startsWith("note:"); }

// Learner: acknowledge they've read a note/slide (the equivalent of
// "finished watching" for text content — there's no natural duration to
// track, so reading it is a one-click mark-as-read).
router.post("/:userId/read/:courseId/:noteId", requireAuth, requireSelfParentOrStaff("userId"), requireActiveAccess("userId"), (req, res) => {
  if (!targetEnrolledInModule(req, req.params.userId, req.params.courseId)) {
    return res.status(403).json({ error: "This learner isn't enrolled in this module." });
  }
  // Root-cause fix (period-payment enforcement): same per-Course
  // period-payment decision routes/modules.js's lessons gate already
  // applies — see utils/periodPayments.js. Scoped to the explicit target
  // learner these :userId routes already resolve, not the caller.
  const periodDecision = periodAccessDecisionForLearner(req.params.userId, req.params.courseId, {
    bypass: req.user.role === "instructor" || req.user.role === "admin",
  });
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);
  const note = db.prepare("SELECT * FROM notes WHERE id = ? AND course_id = ?").get(req.params.noteId, req.params.courseId);
  if (!note) return res.status(404).json({ error: "Note not found." });
  const lessonId = noteLessonId(req.params.noteId);
  const learningInstanceId = getActiveInstanceIdForCourse(req.params.courseId);
  db.prepare(
    `INSERT INTO progress (user_id, course_id, lesson_id, watched_seconds, updated_at, learning_instance_id)
     VALUES (?, ?, ?, 1, datetime('now'), ?)
     ON CONFLICT(user_id, course_id, lesson_id) DO UPDATE SET watched_seconds = 1, updated_at = datetime('now'), learning_instance_id = excluded.learning_instance_id`
  ).run(req.params.userId, req.params.courseId, lessonId, learningInstanceId);
  res.json({ ok: true });
});

/**
 * Record watch progress. The server is authoritative here (not the browser):
 * it clamps the reported time to the lesson's real duration and never lets
 * "watched seconds" move backwards, so clearing local storage or editing
 * requests client-side can't fabricate completion.
 */
router.post("/:userId/watch", requireAuth, requireSelfParentOrStaff("userId"), requireActiveAccess("userId"), (req, res) => {
  const { courseId, lessonId, seconds } = req.body;
  if (!targetEnrolledInModule(req, req.params.userId, courseId)) {
    return res.status(403).json({ error: "This learner isn't enrolled in this module." });
  }
  // Root-cause fix (period-payment enforcement): same per-Course
  // period-payment decision routes/modules.js's lessons gate already
  // applies — see utils/periodPayments.js.
  const periodDecision = periodAccessDecisionForLearner(req.params.userId, courseId, {
    bypass: req.user.role === "instructor" || req.user.role === "admin",
  });
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);
  let lesson = getLesson(courseId, lessonId);
  if (!lesson && isVideoNoteItem(lessonId)) {
    const viewer = db.prepare("SELECT campus, class_id as classId FROM users WHERE id = ?").get(req.params.userId) || {};
    lesson = getMergedLesson(courseId, lessonId, viewer);
  }
  if (!lesson) return res.status(404).json({ error: "Lesson not found." });

  const clamped = Math.max(0, Math.min(Number(seconds) || 0, lesson.durationSec));
  const existing = db.prepare("SELECT watched_seconds FROM progress WHERE user_id=? AND course_id=? AND lesson_id=?").get(req.params.userId, courseId, lessonId);
  const newVal = Math.max(existing ? existing.watched_seconds : 0, clamped);
  const learningInstanceId = getActiveInstanceIdForCourse(courseId);

  db.prepare(
    `INSERT INTO progress (user_id, course_id, lesson_id, watched_seconds, updated_at, learning_instance_id)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id, course_id, lesson_id) DO UPDATE SET watched_seconds = excluded.watched_seconds, updated_at = datetime('now'), learning_instance_id = excluded.learning_instance_id`
  ).run(req.params.userId, courseId, lessonId, newVal, learningInstanceId);

  res.json({ ok: true, watchedSeconds: newVal, complete: newVal >= lesson.durationSec });
});

// Quiz questions are sent WITHOUT the answer key — grading happens server-side.
router.get("/quiz/:courseId/:lessonId", requireAuth, requireActiveAccessSelf, async (req, res) => {
  const { courseId, lessonId } = req.params;
  if (!callerCanAccessCourse(req.user, courseId)) {
    return res.status(403).json({ error: "You're not enrolled in this module." });
  }
  // Root-cause fix (period-payment enforcement): same per-Course
  // period-payment decision routes/modules.js's lessons gate already
  // applies — see utils/periodPayments.js.
  const periodDecision = periodAccessDecisionForCourse(req.user, courseId);
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);
  let questions;
  if (isVideoNoteItem(lessonId)) {
    // Instructor-published video lesson: quiz was generated once at publish
    // time. Never call Gemini here — just read what's already stored.
    const noteId = videoNoteId(lessonId);
    const note = db.prepare("SELECT * FROM notes WHERE id = ? AND course_id = ?").get(noteId, courseId);
    if (!note) return res.status(404).json({ error: "Lesson not found." });
    // AI Quiz Behaviour: disabled by default, and a learner should never see
    // this lesson listed as having a quiz at all if the instructor never
    // enabled it — a distinct, clearer message than "still being prepared".
    if (!note.ai_quiz_enabled) return res.status(404).json({ error: "This lesson doesn't have an AI-generated quiz." });
    if (note.ai_status !== "completed") {
      return res.status(409).json({ error: "This lesson's quiz is still being prepared. Please check back shortly.", processingStatus: note.ai_status || "pending" });
    }
    questions = getStoredQuiz(courseId, lessonId) || [];
  } else if (isNoteItem(lessonId)) {
    const noteId = lessonId.slice("note:".length);
    const note = db.prepare("SELECT * FROM notes WHERE id = ? AND course_id = ?").get(noteId, courseId);
    if (!note) return res.status(404).json({ error: "Note not found." });
    if (!note.ai_quiz_enabled) return res.status(404).json({ error: "This note doesn't have an AI-generated quiz." });
    questions = await generateNoteQuiz(courseId, lessonId, note);
  } else {
    questions = await generateQuiz(courseId, lessonId);
  }
  res.json({ questions: questions.map(({ q, options }) => ({ q, options })) });
});

router.post("/:userId/quiz/:courseId/:lessonId/submit", requireAuth, requireSelfParentOrStaff("userId"), requireActiveAccess("userId"), async (req, res) => {
  const { userId, courseId, lessonId } = req.params;
  const { answers } = req.body; // array of chosen option indices
  if (!targetEnrolledInModule(req, userId, courseId)) {
    return res.status(403).json({ error: "This learner isn't enrolled in this module." });
  }
  // Root-cause fix (period-payment enforcement): same per-Course
  // period-payment decision routes/modules.js's lessons gate already
  // applies — see utils/periodPayments.js.
  const periodDecision = periodAccessDecisionForLearner(userId, courseId, {
    bypass: req.user.role === "instructor" || req.user.role === "admin",
  });
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);

  let questions, requiredSeconds;
  if (isVideoNoteItem(lessonId)) {
    const noteId = videoNoteId(lessonId);
    const note = db.prepare("SELECT * FROM notes WHERE id = ? AND course_id = ?").get(noteId, courseId);
    if (!note) return res.status(404).json({ error: "Lesson not found." });
    if (!note.ai_quiz_enabled) return res.status(404).json({ error: "This lesson doesn't have an AI-generated quiz." });
    if (note.ai_status !== "completed") {
      return res.status(409).json({ error: "This lesson's quiz is still being prepared. Please check back shortly.", processingStatus: note.ai_status || "pending" });
    }
    questions = getStoredQuiz(courseId, lessonId) || [];
    const viewer = db.prepare("SELECT campus, class_id as classId FROM users WHERE id = ?").get(userId) || {};
    const vLesson = getMergedLesson(courseId, lessonId, viewer);
    requiredSeconds = vLesson ? vLesson.durationSec : 1;
  } else if (isNoteItem(lessonId)) {
    const noteId = lessonId.slice("note:".length);
    const note = db.prepare("SELECT * FROM notes WHERE id = ? AND course_id = ?").get(noteId, courseId);
    if (!note) return res.status(404).json({ error: "Note not found." });
    if (!note.ai_quiz_enabled) return res.status(404).json({ error: "This note doesn't have an AI-generated quiz." });
    questions = await generateNoteQuiz(courseId, lessonId, note);
    requiredSeconds = 1;
  } else {
    const lesson = getLesson(courseId, lessonId);
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });
    questions = await generateQuiz(courseId, lessonId);
    requiredSeconds = lesson.durationSec;
  }

  const watched = db.prepare("SELECT watched_seconds FROM progress WHERE user_id=? AND course_id=? AND lesson_id=?").get(userId, courseId, lessonId);
  if (!watched || watched.watched_seconds < requiredSeconds) {
    return res.status(403).json({ error: isNoteItem(lessonId) ? "Mark the note as read before taking the quiz." : "Finish watching the lesson before taking the quiz." });
  }

  let correct = 0;
  questions.forEach((q, i) => {
    if (Number(answers?.[i]) === Number(q.answer)) correct++;
  });
  const pct = Math.round((correct / questions.length) * 100);

  db.prepare("UPDATE progress SET quiz_score = ? WHERE user_id=? AND course_id=? AND lesson_id=?").run(pct, userId, courseId, lessonId);

  let unlocked = false;
  if (!isNoteItem(lessonId) && pct >= 60) {
    const viewer = db.prepare("SELECT campus, class_id as classId FROM users WHERE id = ?").get(userId) || {};
    const next = getNextMergedLessonId(courseId, lessonId, viewer);
    db.prepare(
      `INSERT INTO unlocks (user_id, course_id, unlocked_lesson_id) VALUES (?, ?, ?)
       ON CONFLICT(user_id, course_id) DO UPDATE SET unlocked_lesson_id = excluded.unlocked_lesson_id`
    ).run(userId, courseId, next);
    unlocked = true;
  }

  // Reveal the correct answers now that grading is done, so the UI can show right/wrong.
  res.json({ ok: true, score: pct, unlocked, correctAnswers: questions.map((q) => q.answer) });
});

// Per-month completion breakdown for a learner's enrolled modules, e.g.
// { "2026-06": 40, "2026-07": 80 } plus a term total across all months.
// "Complete" here means lessons finished (watched_seconds >= duration)
// whose progress row was last updated in that month.
router.get("/:userId/monthly", requireAuth, requireSelfParentOrStaff("userId"), requireActiveAccess("userId"), (req, res) => {
  const viewer = db.prepare("SELECT campus, class_id as classId FROM users WHERE id = ?").get(req.params.userId) || {};
  const enrolled = db.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(req.params.userId).map((r) => r.course_id);
  const totalLessons = enrolled.reduce((sum, mid) => sum + getMergedLessons(mid, viewer).length, 0) || 1;

  const rows = db.prepare("SELECT * FROM progress WHERE user_id = ?").all(req.params.userId);
  const byMonth = {};
  rows.forEach((r) => {
    const lesson = getLesson(r.course_id, r.lesson_id) || (isVideoNoteItem(r.lesson_id) ? getMergedLesson(r.course_id, r.lesson_id, viewer) : null);
    if (!lesson || r.watched_seconds < lesson.durationSec) return;
    const month = (r.updated_at || "").slice(0, 7); // 'YYYY-MM'
    byMonth[month] = (byMonth[month] || 0) + 1;
  });

  const monthly = {};
  Object.keys(byMonth).forEach((m) => {
    monthly[m] = Math.round((byMonth[m] / totalLessons) * 100);
  });
  const totalCompleted = Object.values(byMonth).reduce((a, b) => a + b, 0);
  const termTotalPct = Math.round((totalCompleted / totalLessons) * 100);

  res.json({ monthly, termTotalPct });
});

module.exports = router;
