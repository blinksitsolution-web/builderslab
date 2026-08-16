const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requireActiveAccessLearnerOnly } = require("../middleware/auth");
const {
  isLearnerAssignedToInstructor,
  instructorHasCourseAccess,
  instructorHasClassAccess,
  instructorHasCampusAccess,
  instructorHasInstanceAccess,
} = require("../utils/instructorScope");
const { getLearningInstanceById } = require("../utils/learningInstances");

const router = express.Router();

router.get("/thread/:otherUserId", requireAuth, requireActiveAccessLearnerOnly, (req, res) => {
  const me = req.user.id;
  const other = req.params.otherUserId;
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY date ASC`
    )
    .all(me, other, other, me);
  db.prepare("UPDATE messages SET is_read = 1 WHERE to_id = ? AND from_id = ?").run(me, other);
  res.json({ messages: rows });
});

router.get("/inbox", requireAuth, requireActiveAccessLearnerOnly, (req, res) => {
  const rows = db.prepare("SELECT * FROM messages WHERE to_id = ? ORDER BY date DESC").all(req.user.id);
  res.json({ messages: rows });
});

router.post("/", requireAuth, (req, res) => {
  const { to, body, subject } = req.body;
  if (!to || !body) return res.status(400).json({ error: "to and body are required." });
  const recipient = db.prepare("SELECT id, role FROM users WHERE id = ?").get(to);
  if (!recipient) return res.status(404).json({ error: "Recipient not found." });
  // Instructor <-> learner direct messages are only allowed between assigned
  // pairs (same rule as instructor's learner-visibility scope elsewhere).
  if (req.user.role === "instructor" && recipient.role === "learner" && !isLearnerAssignedToInstructor(req.user.id, to)) {
    return res.status(403).json({ error: "You can only message learners assigned to you." });
  }
  if (req.user.role === "learner" && recipient.role === "instructor" && !isLearnerAssignedToInstructor(to, req.user.id)) {
    return res.status(403).json({ error: "You can only message an instructor assigned to you." });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO messages (id, from_id, from_name, to_id, subject, body, date)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(id, req.user.id, req.user.name, to, subject || null, body);
  res.json({ ok: true, id });
});

// Admin: send the same message to every parent in one call
router.post("/broadcast", requireAuth, requireRole("admin"), (req, res) => {
  const { subject, body } = req.body;
  if (!body) return res.status(400).json({ error: "body is required." });
  const parents = db.prepare("SELECT id FROM users WHERE role = 'parent'").all();
  const insert = db.prepare(
    `INSERT INTO messages (id, from_id, from_name, to_id, subject, body, date) VALUES (?, ?, 'Admin', ?, ?, ?, datetime('now'))`
  );
  const tx = db.transaction(() => parents.forEach((p) => insert.run(uuid(), req.user.id, p.id, subject || null, body)));
  tx();
  res.json({ ok: true, sentTo: parents.length });
});

// Instructor/admin: message every learner at once, optionally narrowed to
// one module or one campus (item 7 — "message each learner or all at a go").
// A module may be shared by both Child and Adult learners at once (see
// Stage 3 — same Module used by both, distinguished via class_id vs
// direct module enrollment) — `audience` narrows a module-scoped broadcast
// to just one side, enforced here (not just left to the frontend's
// dropdown), and defaults to "both" so every pre-existing caller that
// never sent it keeps its exact old behavior. Only meaningful together
// with courseId; ignored for the campus/all-learners paths, which have no
// concept of a shared "module audience" to narrow.
//
// Instructor Context Selection (Issue #4): an instructor may be assigned
// to the same Course across several Learning Instances (Programme Runs),
// Programme Levels (classes) and/or Campuses at once — a bare courseId no
// longer identifies which of those the instructor means. learningInstanceId
// and classId let the picker say exactly which one (see
// useMyTeachingContext.js's per-module `eligibleInstances`, the same set
// notes.js/exams.js/continuousAssessments.js already offer); every one of
// them is re-validated here against instructor_assignments — never trusted
// from the request alone — using the same instructorHas*Access functions
// every other instructor-authorization check in this codebase goes through.
//
// The campus-only and all-learners broadcasts have no Course/Learning
// Instance to anchor an instructor_assignments check to (instructor_
// assignments is always Programme-Run-owned — see instructorScope.js), so
// they remain admin-only; an instructor must always broadcast within a
// Course they're actually assigned to.
router.post("/broadcast-learners", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { subject, body, courseId, campus, learningInstanceId, classId } = req.body;
  const audience = ["child", "adult", "both"].includes(req.body.audience) ? req.body.audience : "both";
  if (!body) return res.status(400).json({ error: "body is required." });

  if (req.user.role === "instructor" && !courseId) {
    return res.status(403).json({ error: "Select a module to message its learners — instructors can't broadcast outside their assigned modules." });
  }

  // An instructor may only broadcast to a Course's learners if they're
  // actually assigned to teach that Course (instructor_assignments) — the
  // module dropdown is already scoped to this on the frontend (see
  // useMyTeachingContext.js), but per Stage 3 this must not rely on the
  // frontend alone.
  if (courseId && req.user.role === "instructor") {
    if (!instructorHasCourseAccess(req.user.id, courseId)) {
      return res.status(403).json({ error: "You aren't assigned to teach this module." });
    }
  }

  // Learning Instance: same "explicit pick, validated against the module
  // and the instructor's own assignments" rule notes.js/exams.js/
  // continuousAssessments.js already use for their own context pickers.
  let resolvedInstanceId = null;
  if (learningInstanceId) {
    const instance = getLearningInstanceById(learningInstanceId);
    if (!instance || (courseId && instance.courseId !== courseId)) {
      return res.status(400).json({ error: "learningInstanceId does not belong to this module." });
    }
    if (req.user.role === "instructor" && !instructorHasInstanceAccess(req.user.id, instance.id)) {
      return res.status(403).json({ error: "You haven't been assigned to this Learning Instance." });
    }
    resolvedInstanceId = instance.id;
  }

  if (classId && req.user.role === "instructor" && !instructorHasClassAccess(req.user.id, classId)) {
    return res.status(403).json({ error: "You haven't been assigned to this class." });
  }

  let resolvedCampusId = null;
  if (campus) {
    const campusRow = db.prepare("SELECT id FROM campuses WHERE name = ?").get(campus);
    resolvedCampusId = campusRow ? campusRow.id : null;
    if (req.user.role === "instructor" && (!resolvedCampusId || !instructorHasCampusAccess(req.user.id, resolvedCampusId))) {
      return res.status(403).json({ error: "You haven't been assigned to this campus." });
    }
  }

  let learners;
  if (courseId && (resolvedInstanceId || classId)) {
    // Precise context (an instance and/or class was actually picked): the
    // constitutional Enrollment path only, so recipients resolve to
    // exactly the selected Learning Instance/Programme Level rather than
    // every learner in the Course as a whole (Programme Enrollment §17 is
    // the single owner of a learner's current standing, same source
    // isLearnerAssignedToInstructor above reads from).
    let sql = `SELECT DISTINCT u.id FROM users u
       JOIN programme_enrollments pe ON pe.user_id = u.id
       JOIN learning_instances li ON li.id = pe.learning_instance_id
       WHERE u.role = 'learner' AND pe.status IN ('active', 'completed')
         AND (li.course_id = ? OR li.programme_id = (SELECT programme_id FROM courses WHERE id = ?))`;
    const params = [courseId, courseId];
    if (resolvedInstanceId) { sql += " AND pe.learning_instance_id = ?"; params.push(resolvedInstanceId); }
    if (classId) { sql += " AND pe.class_id = ?"; params.push(classId); }
    if (resolvedCampusId) { sql += " AND (pe.campus_id IS NULL OR pe.campus_id = ?)"; params.push(resolvedCampusId); }
    if (audience === "child") sql += " AND u.is_adult = 0";
    else if (audience === "adult") sql += " AND u.is_adult = 1";
    learners = db.prepare(sql).all(...params);
  } else if (courseId) {
    // No instance/class narrowing requested — the instructor has (or is
    // treating this as) a single applicable context, so this keeps the
    // exact pre-existing course-wide behavior.
    let sql = "SELECT DISTINCT u.id FROM users u JOIN enrollments e ON e.user_id = u.id WHERE u.role='learner' AND e.course_id = ?";
    const params = [courseId];
    if (audience === "child") sql += " AND u.is_adult = 0";
    else if (audience === "adult") sql += " AND u.is_adult = 1";
    if (campus) { sql += " AND u.campus = ?"; params.push(campus); }
    learners = db.prepare(sql).all(...params);
  } else if (campus) {
    learners = db.prepare("SELECT id FROM users WHERE role='learner' AND campus = ?").all(campus);
  } else {
    learners = db.prepare("SELECT id FROM users WHERE role='learner'").all();
  }

  const insert = db.prepare(
    `INSERT INTO messages (id, from_id, from_name, to_id, subject, body, date) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  const tx = db.transaction(() => learners.forEach((l) => insert.run(uuid(), req.user.id, req.user.name, l.id, subject || null, body)));
  tx();
  res.json({ ok: true, sentTo: learners.length });
});

// GET /api/messages/unread-count — powers the Topbar notification bell's
// badge (see layout/Topbar.jsx). The bell used to be a pure static
// placeholder with no data behind it at all; this and /recent below are
// what actually make it work, reusing this existing `messages` table
// rather than building a separate notifications system from scratch.
router.get("/unread-count", requireAuth, (req, res) => {
  const { c } = db.prepare("SELECT COUNT(*) c FROM messages WHERE to_id = ? AND is_read = 0").get(req.user.id);
  res.json({ count: c });
});

// GET /api/messages/recent?limit=5 — most recent inbox messages for the
// bell's dropdown preview. Deliberately does NOT mark anything read
// (matching /inbox's existing behavior) — a message is only marked read
// when its actual thread is opened (GET /thread/:otherUserId above), so
// the badge count stays accurate until the person actually reads it,
// not just glances at the preview.
router.get("/recent", requireAuth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
  const rows = db.prepare("SELECT * FROM messages WHERE to_id = ? ORDER BY date DESC LIMIT ?").all(req.user.id, limit);
  res.json({ messages: rows });
});

module.exports = router;
