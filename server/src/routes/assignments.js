const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requireSelfParentOrStaff, requireActiveAccessSelf, requireActiveAccess } = require("../middleware/auth");
const { getActiveInstanceIdForCourse, resolveConstitutionalTermId } = require("../utils/learningInstances");
const { instructorHasCourseAccess } = require("../utils/instructorScope");
const { periodAccessDecisionForCourse, sendPeriodAccessDenied } = require("../utils/periodPayments");
const { createUploadPipeline } = require("../middleware/upload");

const router = express.Router();

// Previously had no fileFilter at all — any file type (including
// executable/script content) was accepted. Learner submissions can
// reasonably be an image or a common office/document format, so this uses
// the same DOCUMENT profile as note attachments; real content is verified
// against its extension by `verify` after upload.
const { upload, verify } = createUploadPipeline("DOCUMENT", "assignments", 25);

function instructorOwnsNote(instructorId, note) {
  return instructorHasCourseAccess(instructorId, note.course_id);
}

// Learner: submit an assignment — either a file upload OR text typed into
// the portal's embedded editor (mirrors how project submission already
// works, just for instructor-assigned work instead of open-ended projects).
router.post("/:noteId/submit", requireAuth, requireActiveAccessSelf, upload.single("file"), verify, (req, res) => {
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.noteId);
  if (!note || note.kind !== "assignment") return res.status(404).json({ error: "Assignment not found." });
  if (req.user.role !== "learner") return res.status(403).json({ error: "Only learners can submit assignments." });
  // Root-cause fix (period-payment enforcement): same per-Course
  // period-payment decision routes/modules.js's lessons gate already
  // applies — see utils/periodPayments.js.
  const periodDecision = periodAccessDecisionForCourse(req.user, note.course_id);
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);
  const { textContent } = req.body;
  if (!textContent && !req.file) return res.status(400).json({ error: "Write something or attach a file before submitting." });

  const filePath = req.file ? `/uploads/assignments/${req.file.filename}` : null;
  // ABRS v2.2 Compliance Remediation: term_id derives from this module's
  // own Active Programme Run -> Academic Period -> Academic Term (§8.2/
  // §19) — resolved from the SAME learningInstanceId below, never from an
  // independently-selected institution-wide active term.
  const learningInstanceId = getActiveInstanceIdForCourse(note.course_id);
  const activeTermId = resolveConstitutionalTermId(learningInstanceId);
  const existing = db.prepare("SELECT id FROM assignment_submissions WHERE note_id = ? AND user_id = ?").get(note.id, req.user.id);
  if (existing) {
    db.prepare("UPDATE assignment_submissions SET text_content = ?, file_path = ?, submitted_at = datetime('now'), grade = NULL, feedback = NULL, mark = NULL, term_id = ?, learning_instance_id = ? WHERE id = ?")
      .run(textContent || null, filePath || null, activeTermId, learningInstanceId, existing.id);
    return res.json({ ok: true, id: existing.id, resubmitted: true });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO assignment_submissions (id, note_id, user_id, text_content, file_path, submitted_at, term_id, learning_instance_id)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)`
  ).run(id, note.id, req.user.id, textContent || null, filePath, activeTermId, learningInstanceId);
  res.json({ ok: true, id });
});

// Learner/parent/staff: every submission a given learner has made, with the
// assignment title alongside so it reads like a report card.
router.get("/mine/:userId", requireAuth, requireSelfParentOrStaff("userId"), requireActiveAccess("userId"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, n.title as assignment_title, n.course_id
       FROM assignment_submissions s JOIN notes n ON n.id = s.note_id
       WHERE s.user_id = ? ORDER BY s.submitted_at DESC`
    )
    .all(req.params.userId);
  res.json({ submissions: rows });
});

// Instructor/admin: every submission for one assignment, for grading.
router.get("/:noteId", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.noteId);
  if (!note) return res.status(404).json({ error: "Assignment not found." });
  if (req.user.role === "instructor" && !instructorOwnsNote(req.user.id, note)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  const rows = db
    .prepare(
      `SELECT s.*, u.name as learner_name FROM assignment_submissions s
       JOIN users u ON u.id = s.user_id WHERE s.note_id = ? ORDER BY s.submitted_at DESC`
    )
    .all(req.params.noteId);
  res.json({ submissions: rows });
});

// Instructor/admin: grade a submission.
router.patch("/submission/:id/grade", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { grade, feedback, mark } = req.body;
  const submission = db.prepare("SELECT * FROM assignment_submissions WHERE id = ?").get(req.params.id);
  if (!submission) return res.status(404).json({ error: "Submission not found." });
  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(submission.note_id);
  if (req.user.role === "instructor" && note && !instructorOwnsNote(req.user.id, note)) {
    return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  db.prepare("UPDATE assignment_submissions SET grade = ?, feedback = ?, mark = ? WHERE id = ?").run(
    grade ?? null,
    feedback ?? null,
    mark != null ? Number(mark) : null,
    req.params.id
  );
  res.json({ ok: true });
});

module.exports = router;
