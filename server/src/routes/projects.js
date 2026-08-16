const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requireSelfParentOrStaff } = require("../middleware/auth");
const { getActiveInstanceIdForCourse } = require("../utils/learningInstances");
const { createUploadPipeline } = require("../middleware/upload");
const { instructorHasCourseAccess, isLearnerAssignedToInstructor } = require("../utils/instructorScope");

const router = express.Router();

// Content is verified against real file signatures (not just the
// client-supplied mimetype) by `verify`, mounted right after the upload.
const { upload, verify } = createUploadPipeline("PROJECT_MEDIA", "projects", Number(process.env.MAX_UPLOAD_MB) || 25);

router.post("/:userId", requireAuth, requireSelfParentOrStaff("userId"), upload.single("media"), verify, (req, res) => {
  const { courseId, title, description } = req.body;
  if (!title || !courseId) return res.status(400).json({ error: "Title and module are required." });

  const id = uuid();
  const filePath = req.file ? `/uploads/projects/${req.file.filename}` : null;
  const mediaType = req.file ? (/\.(mp4|m4v|mov|webm)$/i.test(req.file.filename) ? "video" : "image") : "none";
  const learningInstanceId = getActiveInstanceIdForCourse(courseId);

  db.prepare(
    `INSERT INTO projects (id, user_id, course_id, title, description, media_type, file_path, date, learning_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
  ).run(id, req.params.userId, courseId, title, description || null, mediaType, filePath, learningInstanceId);

  res.json({ ok: true, id, filePath });
});

// Instructor/admin: every submission awaiting or already given a grade.
// An instructor only ever sees submissions within their assigned scope
// (ABRS v2.2 §8.2/AUTHORIZATION) — filtered here, not just on the
// frontend.
router.get("/", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  let rows = db
    .prepare(
      `SELECT p.*, u.name as learnerName, u.class_id as learnerClassId FROM projects p JOIN users u ON u.id = p.user_id ORDER BY p.date DESC`
    )
    .all();
  if (req.user.role === "instructor") {
    rows = rows.filter(
      (p) => instructorHasCourseAccess(req.user.id, p.course_id) && isLearnerAssignedToInstructor(req.user.id, p.user_id)
    );
  }
  res.json({ projects: rows });
});

router.patch("/:projectId/grade", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { grade, mark, feedback } = req.body;
  if (mark !== undefined && mark !== null && mark !== "" && Number.isNaN(Number(mark))) {
    return res.status(400).json({ error: "Mark must be a number." });
  }
  if (req.user.role === "instructor") {
    const project = db.prepare("SELECT course_id, user_id FROM projects WHERE id = ?").get(req.params.projectId);
    if (!project) return res.status(404).json({ error: "Project not found." });
    if (!instructorHasCourseAccess(req.user.id, project.course_id) || !isLearnerAssignedToInstructor(req.user.id, project.user_id)) {
      return res.status(403).json({ error: "This project is outside your assigned scope." });
    }
  }
  db.prepare("UPDATE projects SET grade = ?, mark = ?, feedback = ? WHERE id = ?").run(
    grade || null,
    mark !== undefined && mark !== null && mark !== "" ? Number(mark) : null,
    feedback || null,
    req.params.projectId
  );
  res.json({ ok: true });
});

module.exports = router;
