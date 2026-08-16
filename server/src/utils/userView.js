const db = require("../db/db");
const { effectivePermissions, getRoleTemplate, isSuperAdmin } = require("./rbac");
const { accessRestriction } = require("./accessControl");

function toPublicUser(row) {
  if (!row) return null;
  // temp_password_plaintext (Stage 4A — sponsor/coordinator credential
  // visibility) is deliberately never included here, no matter who's
  // asking — it's only ever returned by the one narrow, explicitly-
  // authorized endpoint that needs it (GET /:parentId/children/
  // credentials in routes/users.js), not through this general-purpose
  // shape used by every other user-fetching route.
  const { password_hash, temp_password_plaintext, ...safe } = row;
  if (row.role === "admin") attachRbacFields(safe, row);
  // Computed, read-only flags — lets the frontend show/hide the payment/
  // access restriction notice without re-deriving the status/payment_status/
  // access_override rules itself. Harmless to compute for every role: an
  // instructor/admin/parent's own row is never payment-gated, so this is
  // always false for them.
  const restriction = accessRestriction(row);
  safe.accessRestricted = restriction.restricted;
  safe.accessRestrictedReason = restriction.reason;
  return safe;
}

function attachRbacFields(user, row) {
  const template = getRoleTemplate(row.role_template_id);
  user.roleTemplateId = row.role_template_id || null;
  user.roleTemplateName = template ? template.name : null;
  user.isSuperAdmin = isSuperAdmin(row);
  user.usesCustomPermissions = row.custom_permissions != null;
  user.permissions = Array.from(effectivePermissions(row));
  user.corporateClientId = row.corporate_client_id || null;
}

// Builds the same nested shape the frontend prototype used to keep locally
// in localStorage: { ...user, courseIds:[], progress:{}, projects:[], grades:{}, childIds:[] }
//
// `opts.viewerRole` is the role of whoever is making the request (omit for
// trusted/internal callers). When the account being fetched is currently
// access-restricted (see utils/accessControl.js) AND the viewer is the
// learner themself or their parent — never an instructor or admin, whose
// permissions this must not change — the academic content embedded here
// (courseIds/progress/projects/grades) is stripped so it can never leak
// through this endpoint even though status/payment_status/accessRestricted
// stay visible (the frontend needs those to show the restriction notice).
function getFullUser(userId, opts = {}) {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!row) return null;
  const user = toPublicUser(row);
  user.avatarPath = row.avatar_path || null;
  // Sponsorship (see routes/sponsors.js, PATCH /api/users/:userId/sponsor
  // in this file) — resolved to a name here, same reasoning as className
  // below: the frontend needs something displayable, not just a raw FK.
  user.sponsorId = row.sponsor_id || null;
  user.sponsorName = row.sponsor_id ? (db.prepare("SELECT name FROM sponsors WHERE id = ?").get(row.sponsor_id) || {}).name || null : null;
  // Registration collects a corporate_client_id for learners registering
  // under a Corporate Training programme (see routes/auth.js), but it was
  // never resolved to a displayable name for the admin — same "raw FK
  // isn't useful to a viewer" reasoning as sponsorName above.
  user.corporateClientName = row.corporate_client_id
    ? (db.prepare("SELECT name FROM corporate_clients WHERE id = ?").get(row.corporate_client_id) || {}).name || null
    : null;
  const shouldRedact = user.accessRestricted && (opts.viewerRole === "learner" || opts.viewerRole === "parent");

  const courseIds = db.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(userId).map((r) => r.course_id);
  user.courseIds = courseIds;

  const progressRows = db.prepare("SELECT * FROM progress WHERE user_id = ?").all(userId);
  const unlockRows = db.prepare("SELECT * FROM unlocks WHERE user_id = ?").all(userId);
  const progress = {};
  courseIds.forEach((mid) => {
    progress[mid] = { watched: {}, quizScores: {}, unlockedLesson: null };
  });
  progressRows.forEach((r) => {
    progress[r.course_id] = progress[r.course_id] || { watched: {}, quizScores: {}, unlockedLesson: null };
    progress[r.course_id].watched[r.lesson_id] = r.watched_seconds;
    if (r.quiz_score != null) progress[r.course_id].quizScores[r.lesson_id] = r.quiz_score;
  });
  unlockRows.forEach((r) => {
    progress[r.course_id] = progress[r.course_id] || { watched: {}, quizScores: {}, unlockedLesson: null };
    progress[r.course_id].unlockedLesson = r.unlocked_lesson_id;
  });
  user.progress = progress;

  user.projects = db
    .prepare("SELECT id, course_id as courseId, title, description, media_type as mediaType, file_path as filePath, grade, mark, feedback, date FROM projects WHERE user_id = ? ORDER BY date DESC")
    .all(userId);

  const gradeRows = db.prepare("SELECT * FROM grades WHERE user_id = ?").all(userId);
  const grades = {};
  courseIds.forEach((mid) => (grades[mid] = { midterm: null, endOfTerm: null }));
  gradeRows.forEach((r) => (grades[r.course_id] = { midterm: r.midterm, endOfTerm: r.end_of_term }));
  user.grades = grades;

  if (row.role === "parent") {
    user.childIds = db.prepare("SELECT id FROM users WHERE parent_id = ?").all(userId).map((r) => r.id);
  }

  // Stage 4H: the admin registration-detail view needs the actual
  // parent/guardian relationship (name), not just the raw parent_id FK
  // already present on the row — same "resolve to something displayable"
  // reasoning as sponsorName/className above. Only meaningful for a
  // learner created under a parent account (an adult learner who
  // self-registered has no parent_id, so this stays null for them).
  if (row.role === "learner" && row.parent_id) {
    const parent = db.prepare("SELECT name FROM users WHERE id = ?").get(row.parent_id);
    user.parentName = parent ? parent.name : null;
  }

  if (row.role === "learner") {
    const cls = row.class_id ? db.prepare("SELECT * FROM classes WHERE id = ?").get(row.class_id) : null;
    user.className = cls ? cls.name : null;
    // Stage 4H: the admin registration-detail view needs to show which
    // Programme and delivery mode this Learning Group belongs to, not
    // just the Learning Group's own name — resolved the same way
    // routes/grades.js's transcript already does for programmeName.
    user.programmeId = cls ? cls.programme_id : null;
    user.programmeName = cls && cls.programme_id ? (db.prepare("SELECT name FROM programmes WHERE id = ?").get(cls.programme_id) || {}).name || null : null;
    user.deliveryMode = cls ? cls.delivery_mode : null;
    // Builders' Lab participation structure (v29) — read off this
    // learner's PRIMARY programme_enrollments row (their overall
    // journey/placement, not any additional secondary programme they may
    // also be enrolled in). Null for every learner registered before this
    // feature shipped, or whose registration simply didn't send one.
    const primaryEnrollment = db
      .prepare("SELECT id, programme_id, participation_structure FROM programme_enrollments WHERE user_id = ? AND is_primary = 1")
      .get(userId);
    user.participationStructure = primaryEnrollment ? primaryEnrollment.participation_structure || null : null;
    user.primaryEnrollmentId = primaryEnrollment ? primaryEnrollment.id : null;

    if (!user.programmeId && primaryEnrollment && primaryEnrollment.programme_id) {
      user.programmeId = primaryEnrollment.programme_id;
      user.programmeName = (db.prepare("SELECT name FROM programmes WHERE id = ?").get(primaryEnrollment.programme_id) || {}).name || null;
    }

    if (user.participationStructure === "individual_course") {
      user.className = null;
    }

    // Course Group(s) this learner is actually on, resolved off their
    // enrolled Modules' course_group_id — same "resolve to something
    // displayable" pattern as programmeName/className above. A learner can
    // be on more than one Course Group (e.g. an elective outside their main
    // track), so this is a list, not a single value — ungrouped/legacy
    // modules with no course_group_id contribute nothing here.
    const courseGroupRows = db
      .prepare(
        `SELECT DISTINCT cg.id, cg.name
         FROM enrollments e
         JOIN courses m ON m.id = e.course_id
         JOIN course_groups cg ON cg.id = m.course_group_id
         WHERE e.user_id = ?
         ORDER BY cg.name ASC`
      )
      .all(userId);
    user.courseGroupIds = courseGroupRows.map((r) => r.id);
    user.courseGroupNames = courseGroupRows.map((r) => r.name);
  }

  if (row.role === "admin") {
    attachRbacFields(user, row);
  }

  if (row.role === "instructor") {
    const { getInstructorClassIds, getInstructorCourseIds, getInstructorInstanceIds } = require("./instructorScope");
    user.classIds = getInstructorClassIds(userId);
    user.assignedCourseIds = getInstructorCourseIds(userId);
    user.assignedInstanceIds = getInstructorInstanceIds(userId);
    const classNames = db
      .prepare(`SELECT name FROM classes WHERE id IN (${user.classIds.map(() => "?").join(",") || "''"})`)
      .all(...user.classIds)
      .map((r) => r.name);
    user.classNames = classNames;
  }

  // Redact last, after every section above has had a chance to run off the
  // real courseIds/progress/projects/grades — this only ever replaces what's
  // shown to a restricted learner/parent viewer, never what staff sees.
  if (shouldRedact) {
    user.courseIds = [];
    user.progress = {};
    user.projects = [];
    user.grades = {};
  }

  return user;
}

module.exports = { toPublicUser, getFullUser };
