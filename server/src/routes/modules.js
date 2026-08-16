const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { getMergedLessons, callerCanAccessCourse } = require("../utils/lessonCatalog");
const { getActiveInstanceIdForCourse, getLearningInstanceById, isTargetActiveInCurrentPeriod, getActivatedCourseForInstance } = require("../utils/learningInstances");
const { getOfferingTypeForProgramme, offeringTypeUsesActivatedCoursesV2 } = require("../utils/offeringTypeSettings");
const { periodAccessDecisionForCourse, sendPeriodAccessDenied } = require("../utils/periodPayments");
const { requireAuth, requireRole, requireActiveAccessSelf } = require("../middleware/auth");
const { createUploadPipeline } = require("../middleware/upload");
const { getInstructorCourseIds, getInstructorEligibleInstancesForCourse, getInstructorCampusIds } = require("../utils/instructorScope");

const router = express.Router();

// Campus image uploads (Public Website CMS — Campuses section). `verifyCampusImage`
// checks real file content (magic bytes) against png/jpeg/webp after upload,
// not just the client-supplied mimetype.
const { upload: campusUpload, verify: verifyCampusImage } = createUploadPipeline("IMAGE", "campuses", 10);

// Attaches { offeringTypeIds } (the Available Learning Offerings for this
// campus) to a row returned from the campuses table.
function withCampusOfferings(row) {
  const offeringTypeIds = db
    .prepare("SELECT offering_type_id FROM campus_offering_types WHERE campus_id = ?")
    .all(row.id)
    .map((r) => r.offering_type_id);
  return { ...row, offeringTypeIds };
}

function toCourse(row) {
  return { id: row.id, title: row.title, blurb: row.blurb, ages: row.ages, weeks: row.weeks, sequence: row.sequence, isOpen: !!row.is_open, programmeId: row.programme_id || null, programmeName: row.programme_name || null, offeringTypeId: row.offering_type_id || null, offeringTypeSlug: row.offering_type_slug || null, offeringTypeName: row.offering_type_name || null, courseGroupId: row.course_group_id || null, courseGroupName: row.course_group_name || null };
}

const COURSE_SELECT_WITH_OFFERING_TYPE = `
  SELECT m.*, p.name AS programme_name, t.id AS offering_type_id, t.slug AS offering_type_slug, t.name AS offering_type_name, cg.name AS course_group_name
  FROM courses m
  LEFT JOIN programmes p ON p.id = m.programme_id
  LEFT JOIN learning_offering_types t ON t.id = p.offering_type_id
  LEFT JOIN course_groups cg ON cg.id = m.course_group_id
`;

// Public: every module that exists (used for display, e.g. transcripts/labels).
// Unfiltered by default — unchanged behavior for existing Kids STEM callers.
// Pass ?programmeId= to scope to one programme (Adult/Corporate use this so
// learners only see modules belonging to their registered programme).
router.get("/", (req, res) => {
  let sql = COURSE_SELECT_WITH_OFFERING_TYPE;
  const params = [];
  if (req.query.programmeId) {
    sql += " WHERE m.programme_id = ?";
    params.push(req.query.programmeId);
  }
  sql += " ORDER BY (m.sequence IS NULL), m.sequence ASC";
  const rows = db.prepare(sql).all(...params);
  res.json({ courses: rows.map(toCourse) });
});

// Public: only modules currently open for new enrolment — this is what the
// registration page shows, per "each course has a season" (item 20).
//
// Phase 3 (Kids STEM active-Learning-Instance catalogue filter): a module
// being "in season" (is_open = 1) is necessary but no longer sufficient —
// it must also currently be a target (primary or, via its parent Programme,
// inherited) of an ACTIVE Learning Instance, or there's no run for a
// learner to actually be placed into. This mirrors the exact fallback
// utils/learningInstances.js's getActiveInstanceIdForCourse already uses
// everywhere else a Module's active run is resolved (its own instance,
// else its parent Programme's), so "can this module be registered into"
// and "which run will this enrolment attach to" never disagree. Enforced
// here (server-side) rather than only in the frontend — see also the
// matching final-validation checks in routes/auth.js (POST /register) and
// routes/users.js (POST /:parentId/children).
//
// Phase 8: if that active instance has an academic structure configured,
// the Module must ALSO be one of the current academic period's configured
// targets (utils/learningInstances.js's isTargetActiveInCurrentPeriod) —
// a Module belonging to the run generally but not assigned to the period
// currently underway is not presented as available to register into. A
// run with no structure, or a period with no targets configured yet,
// imposes no extra restriction here (same back-compat rule as everywhere
// else this task touches).
//
// ABRS v2.1 Phase 3 Checkpoint 3b (Appendix A-2) — when the requesting
// Programme's offering type has activatedCoursesV2Enabled switched on,
// this also requires the Course to have an ACTIVE, non-Hidden Activated
// Course row (learning_instance_courses, §8/§9) for the resolved Run,
// instead of relying on the legacy global `courses.is_open` flag. This is
// a deliberate behaviour change, not a transparent read-path swap: a
// Course's openness becomes Run-scoped configuration instead of a single
// global flag — which is the entire point of Appendix A-2 — so a Course
// that's globally is_open=1 but has no Activated Course row yet (or one
// that's Inactive/Hidden) for this Run will correctly stop appearing once
// the flag is on for that offering type. Default is OFF for every offering
// type (see offeringTypeSettings.js DEFAULT_SETTINGS), so nothing changes
// for any existing Programme until an admin deliberately opts it in and has
// first curated that Programme Run's Activated Course rows to match.
router.get("/open", (req, res) => {
  const programmeId = req.query.programmeId || null;
  const offeringType = programmeId ? getOfferingTypeForProgramme(programmeId) : null;
  const useActivatedCoursesV2 = offeringTypeUsesActivatedCoursesV2(offeringType);

  // v2: Run-scoped Activated Course state governs openness, not the global
  // is_open flag, so it's deliberately left out of the base SQL filter
  // here — the per-row Activated Course check below is authoritative.
  let sql = useActivatedCoursesV2 ? `${COURSE_SELECT_WITH_OFFERING_TYPE} WHERE 1=1` : `${COURSE_SELECT_WITH_OFFERING_TYPE} WHERE m.is_open = 1`;
  const params = [];
  if (programmeId) {
    sql += " AND m.programme_id = ?";
    params.push(programmeId);
  }
  sql += " ORDER BY (m.sequence IS NULL), m.sequence ASC";
  const rows = db
    .prepare(sql)
    .all(...params)
    .filter((row) => {
      const instanceId = getActiveInstanceIdForCourse(row.id);
      if (!instanceId) return false;
      const instance = getLearningInstanceById(instanceId);
      if (!isTargetActiveInCurrentPeriod(instance, { courseId: row.id })) return false;
      if (useActivatedCoursesV2) {
        const activated = getActivatedCourseForInstance(instanceId, row.id);
        if (!activated || activated.status !== "active" || activated.isHidden) return false;
      }
      return true;
    });
  res.json({ courses: rows.map(toCourse) });
});

// Instructor: only the module(s) admin has assigned them to teach — the
// dropdowns for Notes/Assignments, Monthly Topics, Attendance and broadcast
// messaging should all be scoped to this instead of every module.
router.get("/mine", requireAuth, requireRole("instructor"), (req, res) => {
  const myCourseIds = getInstructorCourseIds(req.user.id);
  if (!myCourseIds.length) return res.json({ courses: [] });
  const rows = db
    .prepare(
      `${COURSE_SELECT_WITH_OFFERING_TYPE}
       WHERE m.id IN (${myCourseIds.map(() => "?").join(",")}) ORDER BY (m.sequence IS NULL), m.sequence ASC`
    )
    .all(...myCourseIds);
  // ABRS v2.2 amendment (concurrent Programme Runs): only attach
  // eligibleInstances when there's actually a choice to make (2+) — for
  // every course with 0 or 1 currently-Active Run (still the overwhelming
  // majority), this is omitted and every existing consumer of this
  // endpoint is completely unaffected. Frontend "which run?" pickers
  // (exam/continuous-assessment/note authoring) should only render when
  // this is present.
  const courses = rows.map(toCourse).map((course) => {
    const eligible = getInstructorEligibleInstancesForCourse(req.user.id, course.id);
    return eligible.length > 1 ? { ...course, eligibleInstances: eligible.map((i) => ({ id: i.id, name: i.name })) } : course;
  });
  res.json({ courses });
});

router.get("/:courseId/lessons", requireAuth, requireActiveAccessSelf, (req, res) => {
  const moduleRow = db.prepare("SELECT id FROM courses WHERE id = ?").get(req.params.courseId);
  if (!moduleRow) return res.status(404).json({ error: "Course not found." });
  // Stage 4E: the module must actually be part of the caller's (or their
  // child's) enrollment — payment status alone (requireActiveAccessSelf,
  // above) isn't an ownership check. See utils/lessonCatalog.js.
  if (!callerCanAccessCourse(req.user, req.params.courseId)) {
    return res.status(403).json({ error: "You're not enrolled in this module." });
  }

  // Phase 6: the authoritative learning-content access path also enforces
  // this Module's period-specific payment requirement (if its active
  // Learning Instance has an academic structure configured — see
  // utils/periodPayments.js for the exact, backward-compatible rules and
  // for why this is now the same shared decision every other course-scoped
  // learner-content route also uses). Instructors/admins always bypass,
  // same as every other gate here.
  const periodDecision = periodAccessDecisionForCourse(req.user, req.params.courseId);
  if (periodDecision) return sendPeriodAccessDenied(res, periodDecision);

  const viewer = db.prepare("SELECT campus, class_id as classId FROM users WHERE id = ?").get(req.user.id) || {};
  const lessons = getMergedLessons(req.params.courseId, viewer).map(({ id, title, youtubeId, durationSec, resources }) => ({ id, title, youtubeId, durationSec, resources }));
  res.json({ lessons });
});

// ---- admin curriculum management -------------------------------------------
// Validates that a Module's courseGroupId (if given) refers to a real
// Course Group belonging to the SAME programme the Module is being saved
// under — a Module can never sit "under" a Course Group that belongs to a
// different Programme. `programmeId` is the Module's resolved (post-merge)
// programme_id at the time of the write. Returns an error string, or null.
function validateCourseGroupForProgramme(courseGroupId, programmeId) {
  if (!courseGroupId) return null; // ungrouped — always allowed, matches legacy behaviour
  const courseGroup = db.prepare("SELECT id, programme_id FROM course_groups WHERE id = ?").get(courseGroupId);
  if (!courseGroup) return "courseGroupId does not match a known course group.";
  if ((courseGroup.programme_id || null) !== (programmeId || null)) {
    return "courseGroupId must belong to the same programme as this module.";
  }
  return null;
}

router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { id, title, blurb, ages, weeks, sequence, programmeId, courseGroupId } = req.body;
  if (!id || !title) return res.status(400).json({ error: "id and title are required." });
  if (db.prepare("SELECT id FROM courses WHERE id = ?").get(id)) {
    return res.status(409).json({ error: "A module with this ID already exists." });
  }
  if (programmeId && !db.prepare("SELECT id FROM programmes WHERE id = ?").get(programmeId)) {
    return res.status(400).json({ error: "programmeId does not match a known programme." });
  }
  const courseGroupError = validateCourseGroupForProgramme(courseGroupId, programmeId || null);
  if (courseGroupError) return res.status(400).json({ error: courseGroupError });
  db.prepare("INSERT INTO courses (id, title, blurb, ages, weeks, sequence, is_open, programme_id, course_group_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)").run(id, title, blurb || null, ages || null, weeks || null, sequence ?? null, programmeId || null, courseGroupId || null);
  res.json({ ok: true });
});

router.patch("/:courseId", requireAuth, requireRole("admin"), (req, res) => {
  const { title, blurb, ages, weeks, sequence, isOpen, programmeId, courseGroupId } = req.body;
  const existing = db.prepare("SELECT * FROM courses WHERE id = ?").get(req.params.courseId);
  if (!existing) return res.status(404).json({ error: "Course not found." });
  if (programmeId && !db.prepare("SELECT id FROM programmes WHERE id = ?").get(programmeId)) {
    return res.status(400).json({ error: "programmeId does not match a known programme." });
  }
  const nextProgrammeId = programmeId !== undefined ? (programmeId || null) : existing.programme_id;
  const nextCourseGroupId = courseGroupId !== undefined ? (courseGroupId || null) : existing.course_group_id;
  const courseGroupError = validateCourseGroupForProgramme(nextCourseGroupId, nextProgrammeId);
  if (courseGroupError) return res.status(400).json({ error: courseGroupError });
  db.prepare(
    `UPDATE courses SET title=?, blurb=?, ages=?, weeks=?, sequence=?, is_open=?, programme_id=?, course_group_id=? WHERE id=?`
  ).run(
    title ?? existing.title,
    blurb ?? existing.blurb,
    ages ?? existing.ages,
    weeks ?? existing.weeks,
    sequence !== undefined ? sequence : existing.sequence,
    isOpen !== undefined ? (isOpen ? 1 : 0) : existing.is_open,
    nextProgrammeId,
    nextCourseGroupId,
    req.params.courseId
  );
  res.json({ ok: true });
});

router.delete("/:courseId", requireAuth, requireRole("admin"), (req, res) => {
  const inUse = db.prepare("SELECT COUNT(*) as n FROM enrollments WHERE course_id = ?").get(req.params.courseId).n;
  if (inUse > 0) return res.status(409).json({ error: `${inUse} learner(s) are enrolled in this module — remove their enrolments first.` });
  db.prepare("DELETE FROM courses WHERE id = ?").run(req.params.courseId);
  res.json({ ok: true });
});

// ---- campuses ---------------------------------------------------------------
// Public: full campus profile for the landing page's Campuses section
// (name/location/partner school/image/contact/available offerings).
router.get("/campuses/list", (req, res) => {
  const rows = db.prepare("SELECT * FROM campuses WHERE active = 1 ORDER BY name ASC").all();
  res.json({ campuses: rows.map(withCampusOfferings) });
});

// Instructor-scoped: only the Campuses this instructor actually has an
// assignment on (see instructorScope.js's getInstructorCampusIds — null
// means at least one of their assignment rows is a genuine campus-wide
// wildcard, in which case every active Campus legitimately applies to
// them). Used anywhere an instructor is picking a target/audience Campus
// (Notes, Messages broadcast) — the public /campuses/list above is for
// the marketing site and was never meant to be reused for this.
router.get("/campuses/mine", requireAuth, requireRole("instructor"), (req, res) => {
  const campusIds = getInstructorCampusIds(req.user.id);
  const rows =
    campusIds === null
      ? db.prepare("SELECT id, name FROM campuses WHERE active = 1 ORDER BY name ASC").all()
      : campusIds.length
      ? db.prepare(`SELECT id, name FROM campuses WHERE id IN (${campusIds.map(() => "?").join(",")}) AND active = 1 ORDER BY name ASC`).all(...campusIds)
      : [];
  res.json({ campuses: rows });
});

router.post("/campuses", requireAuth, requireRole("admin"), campusUpload.single("image"), verifyCampusImage, (req, res) => {
  const { name, isPartner, location, partnerSchoolName, contactPhone, contactEmail, contactAddress } = req.body;
  if (!name) return res.status(400).json({ error: "name is required." });
  if (db.prepare("SELECT id FROM campuses WHERE name = ?").get(name)) {
    return res.status(409).json({ error: "A campus with this name already exists." });
  }
  const id = uuid();
  const imagePath = req.file ? `/uploads/campuses/${req.file.filename}` : null;
  db.prepare(
    `INSERT INTO campuses (id, name, active, is_partner, location, partner_school_name, image_path, contact_phone, contact_email, contact_address)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, isPartner ? 1 : 0, location || null, partnerSchoolName || null, imagePath, contactPhone || null, contactEmail || null, contactAddress || null);
  res.json(withCampusOfferings(db.prepare("SELECT * FROM campuses WHERE id = ?").get(id)));
});

// Full campus profile edit (location/partner school/image/contact), plus the
// existing partner-fee-rate toggle — unchanged behavior for callers that
// only ever sent { isPartner }.
router.patch("/campuses/:id", requireAuth, requireRole("admin"), campusUpload.single("image"), verifyCampusImage, (req, res) => {
  const existing = db.prepare("SELECT * FROM campuses WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Campus not found." });
  const { isPartner, location, partnerSchoolName, contactPhone, contactEmail, contactAddress } = req.body;
  const imagePath = req.file ? `/uploads/campuses/${req.file.filename}` : existing.image_path;
  db.prepare(
    `UPDATE campuses SET is_partner=?, location=?, partner_school_name=?, image_path=?, contact_phone=?, contact_email=?, contact_address=? WHERE id=?`
  ).run(
    isPartner !== undefined ? (isPartner ? 1 : 0) : existing.is_partner,
    location !== undefined ? location : existing.location,
    partnerSchoolName !== undefined ? partnerSchoolName : existing.partner_school_name,
    imagePath,
    contactPhone !== undefined ? contactPhone : existing.contact_phone,
    contactEmail !== undefined ? contactEmail : existing.contact_email,
    contactAddress !== undefined ? contactAddress : existing.contact_address,
    req.params.id
  );
  res.json(withCampusOfferings(db.prepare("SELECT * FROM campuses WHERE id = ?").get(req.params.id)));
});

// Replaces the full set of Learning Offering Types available at this campus
// (the landing page's "Available Learning Offerings" per campus).
router.put("/campuses/:id/offerings", requireAuth, requireRole("admin"), (req, res) => {
  const existing = db.prepare("SELECT id FROM campuses WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Campus not found." });
  const offeringTypeIds = Array.isArray(req.body.offeringTypeIds) ? req.body.offeringTypeIds : [];
  const tx = db.transaction((ids) => {
    db.prepare("DELETE FROM campus_offering_types WHERE campus_id = ?").run(req.params.id);
    const insert = db.prepare("INSERT INTO campus_offering_types (campus_id, offering_type_id) VALUES (?, ?)");
    ids.forEach((offeringTypeId) => insert.run(req.params.id, offeringTypeId));
  });
  tx(offeringTypeIds);
  res.json(withCampusOfferings(db.prepare("SELECT * FROM campuses WHERE id = ?").get(req.params.id)));
});

router.delete("/campuses/:id", requireAuth, requireRole("admin"), (req, res) => {
  // Soft-delete: keeps historical learner records referencing the campus name intact.
  db.prepare("UPDATE campuses SET active = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
