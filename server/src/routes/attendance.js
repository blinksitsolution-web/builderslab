const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requireSelfParentOrStaff } = require("../middleware/auth");
const { getActiveInstanceIdForCourse, getLearningInstanceById, instanceBelongsToInstructor, instanceTargetsCourse, resolveConstitutionalTermId } = require("../utils/learningInstances");
const { instructorHasCourseAccess } = require("../utils/instructorScope");

const router = express.Router();

// Instructor/admin: mark attendance for a whole class session at once.
// body: { courseId, date: 'YYYY-MM-DD', records: [{ learnerId, status, note }] }
router.post("/", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { courseId, date, records, learningInstanceId } = req.body;
  if (!courseId || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: "courseId, date and records[] are required." });
  }
  if (req.user.role === "instructor") {
    const owns = instructorHasCourseAccess(req.user.id, courseId);
    if (!owns) return res.status(403).json({ error: "You haven't been assigned to this module." });
  }

  // Resolved once per session (not per learner) — every record in this
  // batch is for the same module/date, so they all belong to the same run.
  // Same "explicit pick, validated against the module and the
  // instructor's own assignments; else fall back to the module's active
  // run" rule as notes.js/exams.js/continuousAssessments.js/topics.js —
  // needed once a Course has more than one concurrent Run an instructor
  // is assigned to, so a session isn't silently attached to whichever Run
  // happens to be "the" active one. On a re-mark (ON CONFLICT), this
  // re-resolves and overwrites too, so a correction made after a new run
  // went active reflects the current run rather than staying pinned to
  // whichever run was active the first time this session was marked.
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
  // ABRS v2.2 Compliance Remediation: term_id must derive from this
  // Course's own Active Programme Run's Academic Period -> Academic Term
  // (§8.2/§19), never from an institution-wide "active term" resolved
  // independently of the Run — that was the previous, now-removed
  // getActiveTermId() call, which could silently disagree with the Run's
  // own calendar. Null here means the Run's current Academic Period isn't
  // linked to an Academic Term yet (or no academic structure/current
  // period is configured at all) — the row is still written (attendance
  // must never be blocked on calendar configuration), simply unscoped by
  // term until an admin finishes that configuration, same "resolve once
  // per session" reasoning as learningInstanceId above.
  const termId = resolveConstitutionalTermId(resolvedInstanceId);

  const upsert = db.prepare(
    `INSERT INTO attendance (id, course_id, instructor_id, learner_id, date, status, note, learning_instance_id, term_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(course_id, learner_id, date) DO UPDATE SET status = excluded.status, note = excluded.note, instructor_id = excluded.instructor_id, learning_instance_id = excluded.learning_instance_id, term_id = excluded.term_id`
  );
  const notify = db.prepare(
    `INSERT INTO messages (id, from_id, from_name, to_id, subject, body, date) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  );

  const tx = db.transaction(() => {
    records.forEach((r) => {
      upsert.run(uuid(), courseId, req.user.id, r.learnerId, date, r.status, r.note || null, resolvedInstanceId, termId);
      if (r.status === "absent" || r.status === "late") {
        const learner = db.prepare("SELECT name, parent_id FROM users WHERE id = ?").get(r.learnerId);
        if (learner && learner.parent_id) {
          const label = r.status === "absent" ? "was marked absent" : "arrived late";
          notify.run(
            uuid(),
            req.user.id,
            req.user.name,
            learner.parent_id,
            `Attendance: ${learner.name}`,
            `${learner.name} ${label} for the ${courseId} session on ${date}.${r.note ? " Note: " + r.note : ""}`
          );
        }
      }
    });
  });
  tx();

  res.json({ ok: true });
});

// Instructor/admin: existing attendance for a session, to prefill the register UI.
router.get("/:courseId", requireAuth, requireRole("instructor", "admin"), (req, res) => {
  const { date, audience } = req.query;
  if (!date) return res.status(400).json({ error: "?date=YYYY-MM-DD is required." });
  if (req.user.role === "instructor") {
    const owns = instructorHasCourseAccess(req.user.id, req.params.courseId);
    if (!owns) return res.status(403).json({ error: "You haven't been assigned to this module." });
  }
  // Mirrors GET /api/users' opt-in ?audience= narrowing for a Module shared
  // by Child and Adult learners at once (Stage 3) — only applied when sent.
  let sql = "SELECT a.* FROM attendance a WHERE a.course_id = ? AND a.date = ?";
  const params = [req.params.courseId, date];
  if (audience === "child" || audience === "adult") {
    sql += " AND a.learner_id IN (SELECT id FROM users WHERE is_adult = ?)";
    params.push(audience === "adult" ? 1 : 0);
  }
  const rows = db.prepare(sql).all(...params);
  res.json({ attendance: rows });
});

// Learner/parent/staff: a learner's full attendance history.
router.get("/learner/:learnerId", requireAuth, requireSelfParentOrStaff("learnerId"), (req, res) => {
  const rows = db.prepare("SELECT * FROM attendance WHERE learner_id = ? ORDER BY date DESC").all(req.params.learnerId);
  res.json({ attendance: rows });
});

module.exports = router;
