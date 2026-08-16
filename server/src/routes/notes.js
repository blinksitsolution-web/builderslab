const express = require("express");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requireActiveAccessSelf } = require("../middleware/auth");
const { processVideoLessonNote, invalidateVideoLessonQuiz } = require("../utils/ai");
const { getActiveInstanceIdForCourse, getLearningInstanceById, instanceBelongsToInstructor, instanceTargetsCourse } = require("../utils/learningInstances");
const { instructorHasCourseAccess, instructorHasClassAccess, instructorHasCampusAccess } = require("../utils/instructorScope");
const { periodAccessDecisionForCourse, sendPeriodAccessDenied } = require("../utils/periodPayments");
const { createUploadPipeline } = require("../middleware/upload");

const router = express.Router();

// Previously had no fileFilter at all — any file type (including
// executable/script content) was accepted and stored under its original
// extension. Now restricted to images/PDF/office-docs/plain text, with
// real content verified after upload by `verify`.
const { upload, verify, uploadDir } = createUploadPipeline("DOCUMENT", "notes", 25);

// Instructor Context Selection (Issue #4): `target` narrows a Note/
// Assignment/Video Lesson to one Campus (or 'all'/unset for every campus).
// Course and Class are already re-validated against instructor_assignments
// above/below — Campus is the third dimension instructor_assignments can
// scope on, so a specific Campus target gets the same treatment: resolved
// to a real campus row and checked with instructorHasCampusAccess, never
// trusted from the request alone. Returns an error message string, or null
// when the target is fine to proceed with.
function invalidCampusTargetError(instructorId, target) {
  if (!target || target === "all") return null;
  const campusRow = db.prepare("SELECT id FROM campuses WHERE name = ?").get(target);
  if (!campusRow || !instructorHasCampusAccess(instructorId, campusRow.id)) {
    return "You haven't been assigned to this campus.";
  }
  return null;
}

router.get("/", requireAuth, requireActiveAccessSelf, (req, res) => {
  const { courseId, learningInstanceId } = req.query;
  // Root-cause fix (period-payment enforcement): scoping to a single
  // Course is the only case this list can be gated on — the same
  // per-Course period-payment decision routes/modules.js's lessons gate
  // already applies (see utils/periodPayments.js). A request with no
  // courseId spans multiple/unknown Courses and is left to the global
  // account-status gate above, same as before.
  const periodDecision = periodAccessDecisionForCourse(req.user, courseId);
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);
  let sql = "SELECT * FROM notes WHERE 1=1";
  const params = [];
  if (courseId) { sql += " AND course_id = ?"; params.push(courseId); }
  if (learningInstanceId) { sql += " AND learning_instance_id = ?"; params.push(learningInstanceId); }
  // Instructor Content Ownership: an instructor's management view only ever
  // shows their own Notes/Video Lessons/Assignments — never another
  // instructor's, even within the same Learning Instance/module. Learners
  // and admin are unaffected (learners get everything published/assigned to
  // them regardless of author; admin manages everyone's).
  if (req.user.role === "instructor") { sql += " AND posted_by = ?"; params.push(req.user.name); }
  // Learners only ever see published posts; instructor/admin see both so
  // they can manage drafts/unpublished content.
  if (req.user.role === "learner" || req.user.role === "parent") { sql += " AND published = 1"; }
  sql += " ORDER BY date DESC";
  const rows = db.prepare(sql).all(...params);
  res.json({ notes: rows });
});

// target: 'all' (every campus), or an exact campus name — item 5.
// file: optional attachment (assignment sheet, worksheet, etc.) — item 3.
router.post("/", requireAuth, requireRole("instructor", "admin"), upload.single("file"), verify, async (req, res) => {
  const { courseId, classId, title, body, target, kind, videoUrl, topic, learningInstanceId, aiQuizEnabled } = req.body;
  if (!courseId || !classId || !title || !body) return res.status(400).json({ error: "module, class, title and body are required." });
  // Instructors may only post into modules/classes admin has assigned them to.
  if (req.user.role === "instructor") {
    const ownsModule = instructorHasCourseAccess(req.user.id, courseId);
    if (!ownsModule) return res.status(403).json({ error: "You haven't been assigned to this module." });
    const ownsClass = instructorHasClassAccess(req.user.id, classId);
    if (!ownsClass) return res.status(403).json({ error: "You haven't been assigned to this class." });
    const campusError = invalidCampusTargetError(req.user.id, target);
    if (campusError) return res.status(403).json({ error: campusError });
  }
  if (kind === "video_lesson" && !videoUrl) return res.status(400).json({ error: "A video URL is required for a video lesson." });

  // Learning Instance: an instructor may explicitly pick one of their
  // Module's runs (Instructor Portal's Learning Instance selector); if none
  // is sent, this falls back to the Module's single active run, exactly
  // like every other write path in this codebase. Either way, a client-
  // supplied id is never trusted blindly — it must resolve to a real
  // Learning Instance that actually belongs to this Module, which also
  // structurally prevents an instructor from ever attaching a record to a
  // Learning Instance belonging to a different Programme/Module.
  let resolvedInstanceId = null;
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
  const filePath = req.file ? `/uploads/notes/${req.file.filename}` : null;
  // AI Quiz Behaviour: OFF by default — only stored as enabled when the
  // instructor explicitly checks the box while posting/editing a Note or
  // Video Lesson.
  const quizEnabled = aiQuizEnabled === "true" || aiQuizEnabled === true ? 1 : 0;
  db.prepare(
    `INSERT INTO notes (id, course_id, class_id, title, body, posted_by, target, date, file_path, kind, video_url, topic, learning_instance_id, ai_quiz_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`
  ).run(id, courseId, classId, title, body, req.user.name, target || "all", filePath, kind || "note", videoUrl || null, topic || null, resolvedInstanceId, quizEnabled);

  // AI processing happens exactly once, right here at publish time — never
  // on a learner's request — and only when the instructor opted in. The
  // lesson is already saved regardless of the outcome; failures are
  // recorded on the note (ai_status/ai_error) so an instructor/admin can
  // retry.
  if (kind === "video_lesson" && quizEnabled) await processVideoLessonNote(id);

  res.json({ ok: true, id });
});

// Instructor/admin: edit an existing note/assignment/video lesson. Instructors
// may only edit their own posts (matched by posted_by); admin can edit any.
router.patch("/:id", requireAuth, requireRole("instructor", "admin"), upload.single("file"), verify, async (req, res) => {
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
  if (!note) return res.status(404).json({ error: "Not found." });
  if (req.user.role === "instructor" && note.posted_by !== req.user.name) {
    return res.status(403).json({ error: "You can only edit your own posts." });
  }
  const { courseId, classId, title, body, target, kind, videoUrl, topic, learningInstanceId, aiQuizEnabled } = req.body;
  const finalModuleId = courseId || note.course_id;
  const finalClassId = classId || note.class_id;
  if (req.user.role === "instructor") {
    const ownsModule = instructorHasCourseAccess(req.user.id, finalModuleId);
    if (!ownsModule) return res.status(403).json({ error: "You haven't been assigned to this module." });
    const ownsClass = instructorHasClassAccess(req.user.id, finalClassId);
    if (!ownsClass) return res.status(403).json({ error: "You haven't been assigned to this class." });
    // Only re-check Campus when this edit actually changes target — an
    // existing note's stored target predates this check and must remain
    // editable for its other fields without being retroactively blocked.
    if (target !== undefined) {
      const campusError = invalidCampusTargetError(req.user.id, target);
      if (campusError) return res.status(403).json({ error: campusError });
    }
  }
  const finalKind = kind || note.kind;
  if (finalKind === "video_lesson" && !(videoUrl || note.video_url)) {
    return res.status(400).json({ error: "A video URL is required for a video lesson." });
  }

  // Learning Instance, same "explicit pick, else keep/re-resolve" rule as
  // POST — validated against the (possibly changed) module either way.
  let resolvedInstanceId = note.learning_instance_id;
  if (learningInstanceId !== undefined) {
    if (!learningInstanceId) {
      resolvedInstanceId = null;
    } else {
      const instance = getLearningInstanceById(learningInstanceId);
      if (!instance || (instance.courseId !== finalModuleId && !instanceTargetsCourse(instance.id, finalModuleId))) {
        return res.status(400).json({ error: "learningInstanceId does not belong to this module." });
      }
      if (req.user.role === "instructor" && !instanceBelongsToInstructor(req.user.id, instance)) {
        return res.status(403).json({ error: "You haven't been assigned to this Learning Instance." });
      }
      resolvedInstanceId = instance.id;
    }
  }

  let filePath = note.file_path;
  if (req.file) {
    if (note.file_path) {
      const oldPath = path.join(uploadDir, path.basename(note.file_path));
      fs.unlink(oldPath, () => {});
    }
    filePath = `/uploads/notes/${req.file.filename}`;
  }
  // Video, transcript-source, or Lesson Summary changed -> the previously
  // generated quiz no longer matches the content and must be invalidated.
  const finalVideoUrl = finalKind === "video_lesson" ? videoUrl || note.video_url : null;
  const videoChanged = finalKind === "video_lesson" && videoUrl && videoUrl !== note.video_url;
  const summaryChanged = finalKind === "video_lesson" && body && body !== note.body;
  // AI Quiz Behaviour: only changed when the instructor explicitly sends
  // the field (the edit form always sends it, checked or not — this just
  // guards a raw API caller that omits it entirely from wiping the
  // existing setting).
  const finalQuizEnabled = aiQuizEnabled === undefined ? note.ai_quiz_enabled : (aiQuizEnabled === "true" || aiQuizEnabled === true ? 1 : 0);
  const quizWasEnabled = !!note.ai_quiz_enabled;
  const quizJustDisabled = quizWasEnabled && !finalQuizEnabled;

  db.prepare(
    `UPDATE notes SET course_id = ?, class_id = ?, title = ?, body = ?, target = ?, kind = ?, video_url = ?, topic = ?, file_path = ?, learning_instance_id = ?, ai_quiz_enabled = ? WHERE id = ?`
  ).run(
    finalModuleId,
    finalClassId,
    title || note.title,
    body || note.body,
    target || note.target,
    finalKind,
    finalVideoUrl,
    topic || note.topic,
    filePath,
    resolvedInstanceId,
    finalQuizEnabled,
    req.params.id
  );

  if (finalKind === "video_lesson" && quizJustDisabled) {
    // Turned off: no AI quiz should be generated or served for this lesson
    // anymore — clear whatever was cached instead of leaving a stale one
    // reachable if the instructor re-enables it later without editing
    // anything else first.
    invalidateVideoLessonQuiz(note);
  } else if (finalKind === "video_lesson" && finalQuizEnabled && (videoChanged || summaryChanged || !quizWasEnabled)) {
    const updated = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
    if (videoChanged) db.prepare("UPDATE notes SET ai_transcript = NULL WHERE id = ?").run(req.params.id); // force a fresh transcript attempt
    if (summaryChanged) db.prepare("UPDATE notes SET summary_version = summary_version + 1 WHERE id = ?").run(req.params.id);
    invalidateVideoLessonQuiz(updated);
    await processVideoLessonNote(req.params.id); // reprocess now — the edit (or the enabling) is the republish
  }

  res.json({ ok: true });
});

// Instructor/admin: delete a note/assignment/video lesson (and its attached
// file, if any). Instructors may only delete their own posts.
router.delete("/:id", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
  if (!note) return res.status(404).json({ error: "Not found." });
  if (req.user.role === "instructor" && note.posted_by !== req.user.name) {
    return res.status(403).json({ error: "You can only delete your own posts." });
  }
  if (note.file_path) {
    fs.unlink(path.join(uploadDir, path.basename(note.file_path)), () => {});
  }
  db.prepare("DELETE FROM notes WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Instructor/admin: explicitly retry AI processing for one video lesson
// (covers Failed lessons, and legacy/Pending lessons that predate this
// feature). Never runs automatically for learners; overwrites, not
// duplicates, the stored quiz (INSERT OR REPLACE keyed by module+lesson).
router.post("/:id/reprocess", requireAuth, requireRole("instructor", "admin"), async (req, res) => {
  const note = db.prepare("SELECT * FROM notes WHERE id = ? AND kind = 'video_lesson'").get(req.params.id);
  if (!note) return res.status(404).json({ error: "Video lesson not found." });
  if (req.user.role === "instructor" && note.posted_by !== req.user.name) {
    return res.status(403).json({ error: "You can only reprocess your own posts." });
  }
  const result = await processVideoLessonNote(note.id);
  res.json(result);
});

// Instructor/admin: publish/unpublish a Note, Video Lesson, or Assignment.
// Unpublishing hides it from learners immediately (see the learner-facing
// GET below) without deleting it — the instructor's own management view
// still shows it either way, badged with its state. Instructors may only
// toggle their own posts; admin can toggle any.
router.post("/:id/publish", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
  if (!note) return res.status(404).json({ error: "Not found." });
  if (req.user.role === "instructor" && note.posted_by !== req.user.name) {
    return res.status(403).json({ error: "You can only publish your own posts." });
  }
  db.prepare("UPDATE notes SET published = 1 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
router.post("/:id/unpublish", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
  if (!note) return res.status(404).json({ error: "Not found." });
  if (req.user.role === "instructor" && note.posted_by !== req.user.name) {
    return res.status(403).json({ error: "You can only unpublish your own posts." });
  }
  db.prepare("UPDATE notes SET published = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
