const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getActiveInstanceIdForCourse, getLearningInstanceById, instanceBelongsToInstructor, instanceTargetsCourse } = require("../utils/learningInstances");
const { instructorHasCourseAccess, instructorHasClassAccess, getInstructorCourseIds } = require("../utils/instructorScope");

const router = express.Router();

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads", "topics");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Admin: instructor topic-progress monitor — for every instructor/Course
// assignment (from instructor_assignments, expanded via
// getInstructorCourseIds — see utils/instructorScope.js), how many topics
// exist for that Course and how many are marked completed. Declared
// before the /:courseId route below so this fixed path isn't swallowed by
// it.
router.get("/admin/progress-summary", requireAuth, requireRole("admin"), (req, res) => {
  const instructors = db.prepare("SELECT id, name FROM users WHERE role = 'instructor'").all();
  const courseMeta = db.prepare(
    `SELECT m.id, m.title, p.id as programmeId, p.name as programmeName, t.id as offeringTypeId
     FROM courses m LEFT JOIN programmes p ON p.id = m.programme_id LEFT JOIN learning_offering_types t ON t.id = p.offering_type_id
     WHERE m.id = ?`
  );
  const topicCounts = db.prepare(
    `SELECT COUNT(id) as totalTopics, SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completedTopics FROM course_topics WHERE course_id = ?`
  );
  const rows = [];
  instructors.forEach((instructor) => {
    getInstructorCourseIds(instructor.id).forEach((courseId) => {
      const course = courseMeta.get(courseId);
      if (!course) return;
      const counts = topicCounts.get(courseId);
      const total = counts.totalTopics || 0;
      const completed = counts.completedTopics || 0;
      rows.push({
        instructorId: instructor.id,
        instructorName: instructor.name,
        courseId,
        courseTitle: course.title,
        programmeId: course.programmeId,
        programmeName: course.programmeName,
        offeringTypeId: course.offeringTypeId,
        totalTopics: total,
        completedTopics: completed,
        remainingTopics: total - completed,
        completionPct: total ? Math.round((completed / total) * 100) : 0,
      });
    });
  });
  rows.sort((a, b) => (a.instructorName || "").localeCompare(b.instructorName || "") || (a.courseTitle || "").localeCompare(b.courseTitle || ""));
  res.json({ progress: rows });
});

router.get("/:courseId", requireAuth, (req, res) => {
  let sql = "SELECT * FROM course_topics WHERE course_id = ?";
  const params = [req.params.courseId];
  // A topic with no class_id/learning_instance_id applies to every class/
  // run studying this Course (same "NULL means every value of that
  // dimension" convention instructor_assignments uses) — so filtering by
  // a specific class/run includes both that class/run's own topics AND
  // the unscoped ones, rather than hiding general topics the moment a
  // narrower view is requested.
  if (req.query.classId) {
    sql += " AND (class_id IS NULL OR class_id = ?)";
    params.push(req.query.classId);
  }
  if (req.query.learningInstanceId) {
    sql += " AND (learning_instance_id IS NULL OR learning_instance_id = ?)";
    params.push(req.query.learningInstanceId);
  }
  sql += " ORDER BY date DESC";
  const rows = db.prepare(sql).all(...params);
  res.json({ topics: rows });
});

router.post("/", requireAuth, requireRole("instructor", "admin"), upload.single("file"), (req, res) => {
  const { courseId, monthLabel, title, body, classId, learningInstanceId } = req.body;
  if (!courseId || !monthLabel || !title) return res.status(400).json({ error: "courseId, monthLabel and title are required." });
  if (req.user.role === "instructor") {
    const owns = instructorHasCourseAccess(req.user.id, courseId);
    if (!owns) return res.status(403).json({ error: "You haven't been assigned to this module." });
    if (classId && !instructorHasClassAccess(req.user.id, classId)) {
      return res.status(403).json({ error: "You haven't been assigned to this class." });
    }
  }
  // Same "explicit pick, validated against the module and the
  // instructor's own assignments; else fall back to the module's active
  // run" rule as notes.js/exams.js/continuousAssessments.js.
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
  const filePath = req.file ? `/uploads/topics/${req.file.filename}` : null;
  db.prepare(
    `INSERT INTO course_topics (id, course_id, month_label, title, body, file_path, posted_by, date, learning_instance_id, class_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`
  ).run(uuid(), courseId, monthLabel, title, body || null, filePath, req.user.name, resolvedInstanceId, classId || null);
  res.json({ ok: true });
});

// Instructor/admin: mark a topic completed (or not), with the date — visible
// to parents, learners and admin.
router.patch("/:id/complete", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { completed } = req.body;
  const topicRow = db.prepare("SELECT * FROM course_topics WHERE id = ?").get(req.params.id);
  if (!topicRow) return res.status(404).json({ error: "Topic not found." });
  if (req.user.role === "instructor") {
    const owns = instructorHasCourseAccess(req.user.id, topicRow.course_id);
    if (!owns) return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  db.prepare("UPDATE course_topics SET completed = ?, completed_date = ? WHERE id = ?").run(
    completed ? 1 : 0,
    completed ? new Date().toISOString().slice(0, 10) : null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete("/:id", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  db.prepare("DELETE FROM course_topics WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
