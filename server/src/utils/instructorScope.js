// Constitutional Instructor Assignment authorization (ABRS v2.2 §2.1,
// §8.2, §9, §13). `instructor_assignments` (server/src/db/migrate.js) is
// the single, sole owner of "what may this instructor see/teach" — every
// backend check in this codebase that used to read the legacy
// instructor_classes/instructor_courses tables now goes through the
// functions in this file instead, so there is exactly one place scope is
// computed and one table it is computed from.
//
// A row grants an instructor access to a Programme Run
// (learning_instance_id, always set), optionally narrowed to one Course,
// one Programme Level (`classes`) and/or one Campus. NULL on any of those
// three means "every value of that dimension within this Run" — resolved
// at read time here, never expanded/copied at write time.
const db = require("../db/db");

// True if `instructorId` has been granted `courseId` — either directly
// (an assignment row naming that Course) or via a Run-wide/wildcard row
// whose Programme Run actually offers that Course (its own course_id, or
// the Course belongs to the Run's Programme).
function instructorHasCourseAccess(instructorId, courseId) {
  if (!instructorId || !courseId) return false;
  return !!db
    .prepare(
      `SELECT 1 FROM instructor_assignments ia
       WHERE ia.instructor_id = ?
         AND (
           ia.course_id = ?
           OR (
             ia.course_id IS NULL
             AND EXISTS (
               SELECT 1 FROM learning_instances li
               WHERE li.id = ia.learning_instance_id
                 AND (
                   li.course_id = ?
                   OR li.programme_id = (SELECT programme_id FROM courses WHERE id = ?)
                 )
             )
           )
         )
       LIMIT 1`
    )
    .get(instructorId, courseId, courseId, courseId);
}

// True if `instructorId` has been granted `classId` (a Programme Level) —
// directly, or via a wildcard row whose Run belongs to that Programme
// Level's own Programme.
function instructorHasClassAccess(instructorId, classId) {
  if (!instructorId || !classId) return false;
  return !!db
    .prepare(
      `SELECT 1 FROM instructor_assignments ia
       WHERE ia.instructor_id = ?
         AND (
           ia.class_id = ?
           OR (
             ia.class_id IS NULL
             AND EXISTS (
               SELECT 1 FROM learning_instances li
               WHERE li.id = ia.learning_instance_id
                 AND li.programme_id = (SELECT programme_id FROM classes WHERE id = ?)
             )
           )
         )
       LIMIT 1`
    )
    .get(instructorId, classId, classId);
}

// True if `instructorId` has been granted `campusId` — directly, or via a
// wildcard row (any Run; a Programme Run's own configured campuses aren't
// re-checked here, since an assignment naming no campus is intentionally
// "every campus of whatever Runs this instructor is otherwise scoped to").
function instructorHasCampusAccess(instructorId, campusId) {
  if (!instructorId || !campusId) return false;
  return !!db
    .prepare(`SELECT 1 FROM instructor_assignments WHERE instructor_id = ? AND (campus_id = ? OR campus_id IS NULL) LIMIT 1`)
    .get(instructorId, campusId);
}

// True if `instructorId` has any assignment (of any scope) on this
// Programme Run at all.
function instructorHasInstanceAccess(instructorId, learningInstanceId) {
  if (!instructorId || !learningInstanceId) return false;
  return !!db
    .prepare(`SELECT 1 FROM instructor_assignments WHERE instructor_id = ? AND learning_instance_id = ? LIMIT 1`)
    .get(instructorId, learningInstanceId);
}

// Every concrete Course id `instructorId` may access, across every
// Programme Run they're assigned to — expands wildcard (course_id IS
// NULL) rows into the Run's own activated/offered Courses. Used by
// listing endpoints that need a concrete IN (...) filter rather than a
// single per-row check.
function getInstructorCourseIds(instructorId) {
  if (!instructorId) return [];
  const rows = db.prepare(`SELECT DISTINCT course_id, learning_instance_id FROM instructor_assignments WHERE instructor_id = ?`).all(instructorId);
  const ids = new Set();
  const expandWildcard = db.prepare(
    `SELECT c.id FROM courses c, learning_instances li
     WHERE li.id = ? AND (li.course_id = c.id OR c.programme_id = li.programme_id)`
  );
  rows.forEach((r) => {
    if (r.course_id) {
      ids.add(r.course_id);
    } else {
      expandWildcard.all(r.learning_instance_id).forEach((c) => ids.add(c.id));
    }
  });
  return Array.from(ids);
}

// Every concrete Programme Level (`classes`) id `instructorId` may
// access, expanding wildcard rows the same way getInstructorCourseIds
// does.
function getInstructorClassIds(instructorId) {
  if (!instructorId) return [];
  const rows = db.prepare(`SELECT DISTINCT class_id, learning_instance_id FROM instructor_assignments WHERE instructor_id = ?`).all(instructorId);
  const ids = new Set();
  const expandWildcard = db.prepare(`SELECT cl.id FROM classes cl, learning_instances li WHERE li.id = ? AND cl.programme_id = li.programme_id`);
  rows.forEach((r) => {
    if (r.class_id) {
      ids.add(r.class_id);
    } else {
      expandWildcard.all(r.learning_instance_id).forEach((c) => ids.add(c.id));
    }
  });
  return Array.from(ids);
}

// Every Programme Run id `instructorId` has any assignment on.
function getInstructorInstanceIds(instructorId) {
  if (!instructorId) return [];
  return db
    .prepare(`SELECT DISTINCT learning_instance_id FROM instructor_assignments WHERE instructor_id = ?`)
    .all(instructorId)
    .map((r) => r.learning_instance_id);
}

// Returns the array of Campus ids `instructorId` is narrowed to, or null
// if the instructor has at least one assignment row with no Campus
// restriction (campus_id IS NULL) — i.e. "every campus" applies somewhere
// in their scope and no useful narrowing filter can be built. Callers use
// this to additionally narrow a listing by campus only when it's safe to
// do so (never used as the sole/only scope check).
function getInstructorCampusIds(instructorId) {
  if (!instructorId) return [];
  const rows = db.prepare(`SELECT DISTINCT campus_id FROM instructor_assignments WHERE instructor_id = ?`).all(instructorId);
  if (rows.some((r) => r.campus_id === null)) return null;
  return rows.map((r) => r.campus_id);
}

// True if `learnerId` falls within `instructorId`'s assigned operational
// scope. Resolution order:
//   1. Enrollment-based (constitutional, preferred): every active/pending
//      programme_enrollments row for this learner is checked against the
//      instructor's assignments for that row's Programme Run, Programme
//      Level and Campus — this is Enrollment (§17), the constitutional
//      single owner of a learner's current standing, cross-checked
//      against Instructor Assignment (§8.2), the constitutional single
//      owner of instructor scope.
//   2. Legacy fallback for learners with no programme_enrollments row yet
//      (pre-dates that table) or Adult Learners whose only signal is a
//      direct Course enrollment: falls back to the learner's own
//      users.class_id (Programme Level) and/or their `enrollments`
//      (Course access) rows, checked via the same instructorHas*Access
//      functions above — so nobody who was visible before this
//      remediation silently disappears.
function isLearnerAssignedToInstructor(instructorId, learnerId) {
  if (!instructorId || !learnerId) return false;
  const learner = db.prepare("SELECT id, role, class_id, is_adult FROM users WHERE id = ?").get(learnerId);
  if (!learner || learner.role !== "learner") return false;

  const enrollmentRows = db
    .prepare(`SELECT learning_instance_id, class_id, campus_id FROM programme_enrollments WHERE user_id = ?`)
    .all(learnerId);
  for (const row of enrollmentRows) {
    if (!row.learning_instance_id) continue;
    if (!instructorHasInstanceAccess(instructorId, row.learning_instance_id)) continue;
    const classOk = !row.class_id || instructorHasClassAccess(instructorId, row.class_id);
    const campusOk = !row.campus_id || instructorHasCampusAccess(instructorId, row.campus_id);
    if (classOk && campusOk) return true;
  }

  // Legacy fallback (young learner's direct class_id; adult learner's
  // direct Course enrollment) — only reached when Enrollment-based
  // resolution above found nothing.
  if (learner.class_id && instructorHasClassAccess(instructorId, learner.class_id)) return true;
  if (learner.is_adult) {
    const viaCourse = db
      .prepare(`SELECT course_id FROM enrollments WHERE user_id = ?`)
      .all(learnerId)
      .some((r) => instructorHasCourseAccess(instructorId, r.course_id));
    if (viaCourse) return true;
  }
  return false;
}

// Replaces the full set of assignment rows for `instructorId` with
// `assignments` — an array of { learningInstanceId, courseId?, classId?,
// campusId? }. Used by the admin Instructor Assignment screen (a
// checkbox/cascade-style editor that always submits the complete desired
// set, same "replace everything each time" contract the legacy
// classIds/courseIds endpoint used). Rows with no learningInstanceId are
// silently skipped — Instructor Assignment is a Programme Run-owned
// concept (§8.2) and can never be created without one.
function replaceInstructorAssignments(instructorId, assignments) {
  const db2 = require("../db/db");
  const { v4: uuid } = require("uuid");
  const del = db2.prepare("DELETE FROM instructor_assignments WHERE instructor_id = ?");
  const insert = db2.prepare(
    `INSERT OR IGNORE INTO instructor_assignments (id, instructor_id, learning_instance_id, course_id, class_id, campus_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const tx = db2.transaction(() => {
    del.run(instructorId);
    (Array.isArray(assignments) ? assignments : []).forEach((a) => {
      if (!a || !a.learningInstanceId) return;
      insert.run(uuid(), instructorId, a.learningInstanceId, a.courseId || null, a.classId || null, a.campusId || null);
    });
  });
  tx();
}

// ABRS v2.2 amendment (concurrent Programme Runs): when a Course has more
// than one currently-Active Run, an instructor authoring an exam/
// continuous-assessment/note for it needs to say which one — silently
// defaulting to "most recently activated" (the legacy behaviour every
// getActiveInstanceIdForCourse() caller still falls back to when no
// explicit learningInstanceId is given) could attach it to a Run the
// instructor isn't even teaching. This is every currently-Active Run of
// `courseId` this instructor actually has an assignment on — i.e. the
// exact set a "which run?" picker should offer, and the exact set
// exams.js/continuousAssessments.js/notes.js already validate an explicit
// learningInstanceId against (instanceBelongsToInstructor, same
// instructorHasInstanceAccess check reused here).
function getInstructorEligibleInstancesForCourse(instructorId, courseId) {
  if (!instructorId || !courseId) return [];
  const { getActiveInstancesForCourse } = require("./learningInstances");
  return getActiveInstancesForCourse(courseId).filter((instance) => instructorHasInstanceAccess(instructorId, instance.id));
}

module.exports = {
  replaceInstructorAssignments,
  instructorHasCourseAccess,
  instructorHasClassAccess,
  instructorHasCampusAccess,
  instructorHasInstanceAccess,
  getInstructorEligibleInstancesForCourse,
  getInstructorCourseIds,
  getInstructorClassIds,
  getInstructorInstanceIds,
  getInstructorCampusIds,
  isLearnerAssignedToInstructor,
};
