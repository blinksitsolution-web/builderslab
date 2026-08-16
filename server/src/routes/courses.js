// ============================================================
// Course Groups — an optional cross-level grouping/tagging layer over
// Modules (Programme -> Course Group -> Module -> Lesson is NOT part of
// the required academic hierarchy; this is purely an admin-organisation
// convenience, e.g. tagging "Foundation Robotics"/"Framework Robotics"/
// "Skyline Robotics" as all part of the same "Robotics Engineering" track
// for display/curriculum-by-level purposes). Nothing about enrolment,
// Learning Instances, payments, assessments, grades, transcripts,
// certificates, or instructor assignment changes meaning because a Module
// now optionally belongs to a Course Group — all of those still key off
// course_id directly, exactly as before. (Formerly named `courses`; renamed
// to `course_groups` to free up the "Course" name for the primary
// curriculum unit itself, per the Institution -> Learning Offering Type ->
// Programme -> Programme Level -> Programme Run -> Academic Structure ->
// Academic Period -> Course -> Lesson hierarchy.)
// ============================================================
const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function toCourseGroup(row) {
  return {
    id: row.id,
    programmeId: row.programme_id,
    programmeName: row.programme_name || null,
    name: row.name,
    description: row.description || null,
    sortOrder: row.sort_order,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COURSE_GROUP_SELECT = `
  SELECT cg.*, p.name AS programme_name
  FROM course_groups cg
  JOIN programmes p ON p.id = cg.programme_id
`;

// GET /api/course-groups — every course group, optionally scoped to one programme.
router.get("/", (req, res) => {
  let sql = COURSE_GROUP_SELECT;
  const params = [];
  if (req.query.programmeId) {
    sql += " WHERE cg.programme_id = ?";
    params.push(req.query.programmeId);
  }
  sql += " ORDER BY cg.sort_order ASC, cg.name ASC";
  const rows = db.prepare(sql).all(...params);
  res.json({ courseGroups: rows.map(toCourseGroup) });
});

// GET /api/course-groups/:id — one course group plus its Modules (grouped
// by Class/level via course_group_courses where configured, otherwise the
// group's full Module list is returned ungrouped so an admin still sees them).
router.get("/:id", (req, res) => {
  const row = db.prepare(`${COURSE_GROUP_SELECT} WHERE cg.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "Course group not found." });

  const courses = db
    .prepare("SELECT id, title, blurb, ages, weeks, sequence, is_open FROM courses WHERE course_group_id = ? ORDER BY (sequence IS NULL), sequence ASC, title ASC")
    .all(req.params.id)
    .map((m) => ({ id: m.id, title: m.title, blurb: m.blurb, ages: m.ages, weeks: m.weeks, sequence: m.sequence, isOpen: !!m.is_open }));

  // Phase 1: include academic_period_sequence so admin UIs can display and
  // configure the Level × Period matrix without a separate endpoint.
  const classCurriculum = db
    .prepare(
      `SELECT cgc.class_id, cl.name AS class_name, cl.sort_order AS class_sort_order,
              cgc.course_id, m.title AS course_title, cgc.sort_order,
              cgc.academic_period_sequence
       FROM course_group_courses cgc
       JOIN classes cl ON cl.id = cgc.class_id
       JOIN courses m ON m.id = cgc.course_id
       WHERE cgc.course_group_id = ?
       ORDER BY cl.sort_order ASC, cgc.academic_period_sequence ASC, cgc.sort_order ASC`
    )
    .all(req.params.id);

  // Group by class, then by academic_period_sequence within each class.
  const byClass = new Map();
  for (const r of classCurriculum) {
    if (!byClass.has(r.class_id)) {
      byClass.set(r.class_id, {
        classId: r.class_id,
        className: r.class_name,
        sortOrder: r.class_sort_order,
        // courses: legacy flat list (backward compat — clients expecting old shape still work)
        courses: [],
        // curriculumByPeriod: new structured shape
        curriculumByPeriod: new Map(),
      });
    }
    const entry = byClass.get(r.class_id);
    entry.courses.push({ id: r.course_id, title: r.course_title, academicPeriodSequence: r.academic_period_sequence });
    const seq = r.academic_period_sequence;
    if (!entry.curriculumByPeriod.has(seq)) entry.curriculumByPeriod.set(seq, []);
    entry.curriculumByPeriod.get(seq).push({ id: r.course_id, title: r.course_title, sortOrder: r.sort_order });
  }

  const curriculumByClass = Array.from(byClass.values()).map((entry) => ({
    classId: entry.classId,
    className: entry.className,
    sortOrder: entry.sortOrder,
    courses: entry.courses,
    curriculumByPeriod: Array.from(entry.curriculumByPeriod.entries())
      .sort(([a], [b]) => a - b)
      .map(([seq, cs]) => ({ academicPeriodSequence: seq, courses: cs })),
  }));

  res.json({ ...toCourseGroup(row), courses, curriculumByClass });
});

router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { programmeId, name, description, sortOrder } = req.body;
  if (!programmeId || !name || !String(name).trim()) {
    return res.status(400).json({ error: "programmeId and name are required." });
  }
  if (!db.prepare("SELECT id FROM programmes WHERE id = ?").get(programmeId)) {
    return res.status(400).json({ error: "programmeId does not match a known programme." });
  }
  const id = uuid();
  try {
    db.prepare(
      "INSERT INTO course_groups (id, programme_id, name, description, sort_order) VALUES (?, ?, ?, ?, ?)"
    ).run(id, programmeId, String(name).trim(), description || null, sortOrder ?? 0);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e.message)) {
      return res.status(409).json({ error: "A course group with this name already exists under this programme." });
    }
    throw e;
  }
  res.json(toCourseGroup(db.prepare(`${COURSE_GROUP_SELECT} WHERE cg.id = ?`).get(id)));
});

router.patch("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const existing = db.prepare("SELECT * FROM course_groups WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Course group not found." });
  const { name, description, sortOrder, isActive } = req.body;
  try {
    db.prepare(
      `UPDATE course_groups SET name=?, description=?, sort_order=?, is_active=?, updated_at=datetime('now') WHERE id=?`
    ).run(
      name !== undefined ? String(name).trim() : existing.name,
      description !== undefined ? (description || null) : existing.description,
      sortOrder !== undefined ? sortOrder : existing.sort_order,
      isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active,
      req.params.id
    );
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e.message)) {
      return res.status(409).json({ error: "A course group with this name already exists under this programme." });
    }
    throw e;
  }
  res.json(toCourseGroup(db.prepare(`${COURSE_GROUP_SELECT} WHERE cg.id = ?`).get(req.params.id)));
});

// DELETE is blocked while any Module still points at this course group,
// exactly the same "don't destroy something still referenced" guard
// modules.js applies to enrolments — a course group must be emptied
// (modules re-grouped or set back to ungrouped) before it can be removed.
router.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const inUse = db.prepare("SELECT COUNT(*) as n FROM courses WHERE course_group_id = ?").get(req.params.id).n;
  if (inUse > 0) {
    return res.status(409).json({ error: `${inUse} module(s) still belong to this course group — move or ungroup them first.` });
  }
  db.prepare("DELETE FROM course_group_courses WHERE course_group_id = ?").run(req.params.id);
  db.prepare("DELETE FROM course_groups WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- per-Class(level) curriculum mapping -----------------------------------
// "A Course Group may run through multiple Builders' Lab classes and have a
// different set of Courses at each class" — e.g. Robotics Engineering has
// Course A/B at Foundation, Course C/D at Framework, Course E/F at Skyline.

// GET /api/course-groups/:id/classes/:classId/courses — the Course set
// configured for this Course Group at this Class/level, grouped by
// Academic Period sequence (Phase 1).
// Legacy clients receive a flat `courses` array (sorted by period then
// sort_order) containing the new `academicPeriodSequence` field.
// Modern clients use the `curriculumByPeriod` grouped structure.
router.get("/:id/classes/:classId/courses", (req, res) => {
  const rows = db
    .prepare(
      `SELECT cgc.course_id, m.title, cgc.sort_order, cgc.academic_period_sequence
       FROM course_group_courses cgc
       JOIN courses m ON m.id = cgc.course_id
       WHERE cgc.course_group_id = ? AND cgc.class_id = ?
       ORDER BY cgc.academic_period_sequence ASC, cgc.sort_order ASC`
    )
    .all(req.params.id, req.params.classId);

  const courses = rows.map((r) => ({
    id: r.course_id,
    title: r.title,
    sortOrder: r.sort_order,
    academicPeriodSequence: r.academic_period_sequence,
  }));

  // Group by period for structured clients.
  const byPeriod = new Map();
  for (const r of rows) {
    const seq = r.academic_period_sequence;
    if (!byPeriod.has(seq)) byPeriod.set(seq, []);
    byPeriod.get(seq).push({ id: r.course_id, title: r.title, sortOrder: r.sort_order });
  }
  const curriculumByPeriod = Array.from(byPeriod.entries())
    .sort(([a], [b]) => a - b)
    .map(([seq, cs]) => ({ academicPeriodSequence: seq, courses: cs }));

  res.json({ courses, curriculumByPeriod });
});

// PUT /api/course-groups/:id/classes/:classId/courses — replace the Course
// set for this Course Group at this Class/level with the given ordered
// list of course entries. Each entry must include:
//   courseId             — must belong to this Course Group
//   academicPeriodSequence — positive integer (1=Term 1, 2=Term 2, etc.)
//   sortOrder            — optional integer (defaults to position in array)
//
// Legacy callers may still pass a flat `courseIds` string array; those are
// treated as all belonging to academic_period_sequence=1 so existing
// non-structured integrations continue to work unchanged.
router.put("/:id/classes/:classId/courses", requireAuth, requireRole("admin"), (req, res) => {
  const courseGroup = db.prepare("SELECT id FROM course_groups WHERE id = ?").get(req.params.id);
  if (!courseGroup) return res.status(404).json({ error: "Course group not found." });
  const cls = db.prepare("SELECT id FROM classes WHERE id = ?").get(req.params.classId);
  if (!cls) return res.status(404).json({ error: "Class not found." });

  // Normalise input: support both the new {courseId, academicPeriodSequence}
  // shape and the legacy flat courseIds string array.
  let entries = [];
  if (Array.isArray(req.body.courses)) {
    entries = req.body.courses;
  } else if (Array.isArray(req.body.courseIds)) {
    // Legacy callers: assign everything to period 1.
    entries = req.body.courseIds.map((courseId, idx) => ({ courseId, academicPeriodSequence: 1, sortOrder: idx }));
  }

  // Validate all entries before touching the database.
  for (const entry of entries) {
    const { courseId, academicPeriodSequence } = entry;
    if (!courseId) return res.status(400).json({ error: "Each entry must include courseId." });
    const m = db.prepare("SELECT id, course_group_id FROM courses WHERE id = ?").get(courseId);
    if (!m) return res.status(400).json({ error: `Unknown courseId: ${courseId}` });
    if (m.course_group_id !== req.params.id) {
      return res.status(400).json({ error: `Course ${courseId} does not belong to this course group.` });
    }
    const seq = academicPeriodSequence ?? 1;
    if (!Number.isInteger(seq) || seq < 1) {
      return res.status(400).json({ error: `academicPeriodSequence must be a positive integer (got ${seq} for course ${courseId}).` });
    }
  }

  const txn = db.transaction(() => {
    // Replace ALL entries for this course group + class (across all periods).
    db.prepare("DELETE FROM course_group_courses WHERE course_group_id = ? AND class_id = ?").run(req.params.id, req.params.classId);
    const insert = db.prepare(
      "INSERT INTO course_group_courses (id, course_group_id, class_id, course_id, academic_period_sequence, sort_order) VALUES (?, ?, ?, ?, ?, ?)"
    );
    entries.forEach((entry, idx) => {
      const seq = entry.academicPeriodSequence ?? 1;
      const sortOrder = entry.sortOrder !== undefined ? entry.sortOrder : idx;
      insert.run(uuid(), req.params.id, req.params.classId, entry.courseId, seq, sortOrder);
    });
  });
  txn();

  res.json({ ok: true, count: entries.length });
});

module.exports = router;

