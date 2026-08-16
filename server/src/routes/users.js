const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { getFullUser, toPublicUser } = require("../utils/userView");
const { requireAuth, requireRole, requireSelfParentOrStaff, requireSuperAdmin, requirePermission, requireInAdminScope } = require("../middleware/auth");
const { getActiveYear } = require("../utils/academicTerm");
const { programmeRequiresParent } = require("../utils/offeringTypeSettings");
const {
  getActiveInstanceIdForProgramme,
  getActiveInstanceIdForCourse,
  getLearningInstanceById,
  isTargetActiveInCurrentPeriod,
  activateEnrollmentCurriculum,
  resolveProgrammeRegistrationOpen,
  deriveEnrollmentOperationalSnapshot,
  resolveActiveInstanceForRegistration,
  getEligibleCoursesForRun,
  isAdultProfessionalEnrollment,
  usesRunScopedCourseCurriculum,
  getOfferingTypeSlugForInstance,
  checkOperationalGroupCapacity,
} = require("../utils/learningInstances");
const { getRoleTemplate, isSuperAdmin, assertSuperAdminActionAllowed, ALL_PERMISSIONS, campusScopeFor, corporateClientScopeFor, isTargetInAdminScope, hasPermission } = require("../utils/rbac");
const { recordAuditLog } = require("../utils/auditLog");
const { isStrongPassword, passwordMessage } = require("../utils/validators");
const { resolveCampusByName } = require("../utils/campusResolution");
const {
  isLearnerAssignedToInstructor,
  getInstructorClassIds,
  getInstructorCourseIds,
  getInstructorInstanceIds,
  getInstructorCampusIds,
  replaceInstructorAssignments,
} = require("../utils/instructorScope");
const pricingEngine = require("../utils/pricingEngine");
const { createUploadPipeline } = require("../middleware/upload");

const router = express.Router();

// `verifyAvatar` checks the real file content (magic bytes) against
// png/jpeg/webp after upload — not just the client-supplied mimetype.
const { upload: avatarUpload, verify: verifyAvatar } = createUploadPipeline("IMAGE", "avatars", 8);

/* ---------------------------------------------------------------------
   Password recovery (public — no auth yet, that's the point)
   --------------------------------------------------------------------- */
router.post("/forgot-password", (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const user = db.prepare("SELECT id, name FROM users WHERE email = ?").get(email);
  // Always respond the same way whether or not the account exists, so this
  // endpoint can't be used to check which emails are registered.
  const generic = { ok: true, message: "If an account exists for that email, a reset link has been generated." };
  if (!user) return res.json(generic);

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare("INSERT INTO password_resets (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)").run(token, user.id, expiresAt);

  // React password-reset route (Group 2, final non-admin migration) —
  // was `/reset-password.html?token=...`. Only the URL target changed
  // here; token generation, expiry, and storage above are untouched.
  const resetLink = `${process.env.APP_URL || ""}/app/reset-password?token=${token}`;
  // TODO(BACKEND): send `resetLink` by email/SMS (e.g. Resend, SendGrid, Twilio)
  // instead of returning it directly. Returning it here is a dev-mode
  // convenience so password reset is testable without an email service.
  console.log(`🔑 Password reset requested for ${email} → ${resetLink}`);
  res.json({ ...generic, devResetLink: process.env.NODE_ENV !== "production" ? resetLink : undefined });
});

router.post("/reset-password", (req, res) => {
  const { token, newPassword, confirmNewPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: "token and newPassword are required." });
  if (newPassword !== confirmNewPassword) return res.status(400).json({ error: "Passwords don't match." });
  if (!isStrongPassword(newPassword)) return res.status(400).json({ error: passwordMessage(newPassword) });

  const row = db.prepare("SELECT * FROM password_resets WHERE token = ?").get(token);
  if (!row || row.used || new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: "This reset link is invalid or has expired." });
  }
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, row.user_id);
  db.prepare("UPDATE password_resets SET used = 1 WHERE token = ?").run(token);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Profile (self-service)
   --------------------------------------------------------------------- */
router.patch("/:userId/profile", requireAuth, requireSelfParentOrStaff("userId"), (req, res) => {
  if (req.user.id !== req.params.userId) return res.status(403).json({ error: "You can only edit your own profile." });
  const { name, phone } = req.body;
  db.prepare("UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?").run(name || null, phone || null, req.params.userId);
  res.json({ ok: true });
});

router.post("/:userId/avatar", requireAuth, avatarUpload.single("avatar"), verifyAvatar, (req, res) => {
  if (req.user.id !== req.params.userId) return res.status(403).json({ error: "You can only edit your own profile." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const avatarPath = `/uploads/avatars/${req.file.filename}`;
  db.prepare("UPDATE users SET avatar_path = ? WHERE id = ?").run(avatarPath, req.params.userId);
  res.json({ ok: true, avatarPath });
});

router.post("/:userId/password", requireAuth, (req, res) => {
  if (req.user.id !== req.params.userId) return res.status(403).json({ error: "You can only change your own password." });
  const { currentPassword, newPassword, confirmNewPassword } = req.body;
  if (newPassword !== confirmNewPassword) return res.status(400).json({ error: "New passwords don't match." });
  if (!isStrongPassword(newPassword)) return res.status(400).json({ error: passwordMessage(newPassword) });
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.params.userId);
  if (!row.password_hash || !bcrypt.compareSync(currentPassword || "", row.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, req.params.userId);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Sponsorship (staff-only — see routes/sponsors.js for the sponsor
   roster itself; this is specifically the "attach/detach a sponsor to
   this one learner" action, so it lives with the rest of a learner's
   account-level mutations rather than under /api/sponsors).
   --------------------------------------------------------------------- */
router.patch("/:userId/sponsor", requireAuth, requirePermission("sponsors.edit"), requireInAdminScope("userId"), (req, res) => {
  const user = db.prepare("SELECT id, role, status, payment_status, sponsor_id FROM users WHERE id = ?").get(req.params.userId);
  if (!user) return res.status(404).json({ error: "Not found." });

  const { sponsorId } = req.body;

  if (sponsorId === null || sponsorId === undefined) {
    // Detach — only ever clears the sponsor_id link itself. payment_status
    // is never touched here: a sponsor is responsible for payment, not a
    // free-access grant, so detaching one was never what put an account
    // into a paid/unpaid state in the first place (see the attach branch
    // below). An admin who wants to actively chase payment after
    // de-sponsoring does so via the existing Payments tools, same as for
    // any other learner.
    db.prepare(`UPDATE users SET sponsor_id = NULL WHERE id = ?`).run(req.params.userId);
    return res.json({ ok: true, sponsorId: null });
  }

  const sponsor = db.prepare("SELECT id, is_active, max_learners, name FROM sponsors WHERE id = ?").get(sponsorId);
  if (!sponsor) return res.status(400).json({ error: "sponsorId does not match a known sponsor." });
  if (!sponsor.is_active) return res.status(400).json({ error: "This sponsor is deactivated — reactivate it first, or choose another sponsor." });
  if (sponsor.max_learners != null && user.sponsor_id !== sponsor.id) {
    // Only counted against the cap for a genuinely new attachment — this
    // also closes the gap where the coordinator-path cap (see
    // POST /:parentId/children) could otherwise be sidestepped by
    // manually attaching learners one at a time here instead.
    const sponsoredCount = db.prepare("SELECT COUNT(*) c FROM users WHERE sponsor_id = ? AND role = 'learner'").get(sponsor.id).c;
    if (sponsoredCount >= sponsor.max_learners) {
      return res.status(400).json({ error: `${sponsor.name} has reached its limit of ${sponsor.max_learners} sponsored learner(s).` });
    }
  }

  // Attaching a sponsor ONLY records who is now responsible for this
  // learner's fees — it is deliberately NOT a payment event. There is no
  // general sponsor-payment waiver: payment_status/status/balance_owed_ghs
  // are left exactly as they were, so a learner whose sponsor hasn't
  // actually paid yet stays exactly as restricted as any other unpaid
  // learner (see utils/accessControl.js — its blocklist has no special
  // case for "has a sponsor"). The sponsor satisfies that requirement the
  // same way anyone else does: a real payment recorded against this
  // learner (Paystack, or an admin manually confirming one via
  // PATCH /api/payments/:userId/status) sets payment_status to
  // 'partial'/'current' from there. The ONLY thing that grants free access
  // without an actual payment is a Hub/admin Access Override
  // (PATCH /:userId/access-override), which stays completely independent
  // of sponsor_id so it's always distinguishable in the data: sponsor_id
  // set + payment_status still unpaid/partial = sponsor payment
  // outstanding; sponsor_id set + payment_status current = sponsor payment
  // satisfied; access_override = 1 = Hub-granted free access regardless of
  // either.
  db.prepare(`UPDATE users SET sponsor_id = ? WHERE id = ?`).run(sponsorId, req.params.userId);
  res.json({ ok: true, sponsorId });
});

/* ---------------------------------------------------------------------
   Fetch / list
   --------------------------------------------------------------------- */
router.get("/:userId", requireAuth, requireSelfParentOrStaff("userId"), requireInAdminScope("userId"), (req, res) => {
  const user = getFullUser(req.params.userId, { viewerRole: req.user.role });
  if (!user) return res.status(404).json({ error: "Not found." });
  res.json({ user });
});

// Admin/instructor: list accounts, filterable by role / campus / name search
// (?role=learner&campus=Woodbridge...&search=elikem) — used by Manage
// Accounts, Grade Projects, and the instructor's "My Learners" screen.
router.get("/", requireAuth, requireRole("admin", "instructor"), (req, res) => {
  const { role, campus, search, class: classId, isAdult, offeringTypeId, programmeId, learningInstanceId, learningInstanceScope, courseId } = req.query;
  let sql = "SELECT * FROM users WHERE 1=1";
  const params = [];
  if (role) { sql += " AND role = ?"; params.push(role); }
  if (campus) { sql += " AND campus = ?"; params.push(campus); }
  if (search) { sql += " AND (name LIKE ? OR email LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
  if (classId) { sql += " AND class_id = ?"; params.push(classId); }
  if (isAdult !== undefined) { sql += " AND is_adult = ?"; params.push(isAdult === "1" || isAdult === "true" ? 1 : 0); }
  // Module scoping — opt-in, added for the Certificate Generator's bulk
  // issuance fix (Learning Instance integration, continuation milestone).
  // Only ever restricts 'learner' rows (same "role != 'learner' OR (...)"
  // carve-out as the Offering Type/Programme/Learning Instance filters
  // below) to learners actually enrolled in this Module, via the existing
  // `enrollments` (user_id, course_id) table — no new table, no new join
  // path. Every other existing caller of GET /api/users sends no
  // `courseId` and is byte-for-byte unaffected.
  if (courseId) {
    sql += " AND (role != 'learner' OR id IN (SELECT user_id FROM enrollments WHERE course_id = ?))";
    params.push(courseId);
  }
  // Audience narrowing — only meaningful alongside courseId, for a Module
  // shared by both Child and Adult learners at once (Stage 3). Opt-in and
  // additive: every existing caller that never sends `audience` keeps
  // seeing the exact same combined roster as before.
  if (courseId && (req.query.audience === "child" || req.query.audience === "adult")) {
    sql += " AND (role != 'learner' OR is_adult = ?)";
    params.push(req.query.audience === "adult" ? 1 : 0);
  }
  // Learning Instance / Programme / Learning Offering Type scoping — added
  // for the Admin Portal's Manage Accounts screen (Learning Instance
  // integration milestone). Entirely opt-in: only applied when the caller
  // explicitly sends one of these four params, so every other existing
  // caller of GET /api/users (bulk promotion, learner progress, defaulters,
  // instructor assignment pickers, etc.) is byte-for-byte unaffected.
  // Only 'learner' rows are actually enrolled in a Programme, so
  // non-learner accounts (parent/instructor/admin) are always still shown
  // when one of these filters is active — this axis only makes sense for
  // learners; "Account Type" (role) is its own independent filter above.
  if (offeringTypeId || programmeId || learningInstanceId || learningInstanceScope) {
    let sub = `EXISTS (
      SELECT 1 FROM programme_enrollments pe
      JOIN programmes pr ON pr.id = pe.programme_id
      WHERE pe.user_id = users.id AND pe.status IN ('active','pending_payment')`;
    const subParams = [];
    if (offeringTypeId) { sub += " AND pr.offering_type_id = ?"; subParams.push(offeringTypeId); }
    if (programmeId) { sub += " AND pe.programme_id = ?"; subParams.push(programmeId); }
    if (learningInstanceId) {
      sub += " AND pe.learning_instance_id = ?";
      subParams.push(learningInstanceId);
    } else if (learningInstanceScope === "active") {
      // Default "current" view: only enrolments tied to a run that's
      // actually active right now — keeps a completed/archived run's
      // learners out of the day-to-day list unless historical data is
      // explicitly requested (learningInstanceScope=consolidated, or no
      // scope param at all, both skip this clause entirely).
      sub += " AND pe.learning_instance_id IN (SELECT id FROM learning_instances WHERE status = 'active')";
    }
    sub += ")";
    sql += ` AND (role != 'learner' OR ${sub})`;
    params.push(...subParams);
  }
  // Instructor eligibility scoping — added for the Programme Run admin
  // UI's instructor selector (Instructor Assignment completion). Opt-in:
  // only applied when the caller explicitly asks for role=instructor
  // together with programmeId and/or offeringTypeId — a combination no
  // existing caller sent before this (the offeringTypeId/programmeId
  // block above deliberately skips non-learner rows), so every other
  // existing caller of GET /api/users is byte-for-byte unaffected.
  // "Eligible" mirrors the single constitutional instructor_assignments
  // table (utils/instructorScope.js) this codebase now uses everywhere
  // else to decide what an instructor can see/do — an instructor already
  // assigned to any Programme Run under the given Programme (or, for
  // offeringTypeId, under any Programme of that Offering Type) is
  // eligible to be considered for further assignment.
  if (role === "instructor" && (programmeId || offeringTypeId)) {
    let eligibleSub = `id IN (
      SELECT ia.instructor_id FROM instructor_assignments ia
        JOIN learning_instances li ON li.id = ia.learning_instance_id
        LEFT JOIN programmes p ON p.id = li.programme_id
      WHERE 1=1`;
    const eligibleParams = [];
    if (programmeId) { eligibleSub += " AND li.programme_id = ?"; eligibleParams.push(programmeId); }
    if (offeringTypeId) { eligibleSub += " AND p.offering_type_id = ?"; eligibleParams.push(offeringTypeId); }
    eligibleSub += ")";
    sql += ` AND ${eligibleSub}`;
    params.push(...eligibleParams);
  }
  // Instructors only ever see learners within their assigned Instructor
  // Assignment scope (Programme Run + optionally Course/Programme
  // Level/Campus) — this is the real security boundary, not just a
  // hidden UI filter. Resolved per-learner via isLearnerAssignedToInstructor
  // (utils/instructorScope.js), the same function every other backend
  // route uses, so this listing can never disagree with what those
  // routes individually allow.
  // Campus Administrator: only their assigned campus, no matter what
  // ?campus= the caller passed. Corporate Coordinator: only learners tied
  // to their one Corporate Client, and never staff/admin accounts at all.
  if (req.user.role === "admin") {
    const scopedCampus = campusScopeFor(req.user);
    if (scopedCampus) { sql += " AND campus = ?"; params.push(scopedCampus); }
    // A Corporate Coordinator only ever sees the participants (learners)
    // tagged to their one Corporate Client — never other clients, other
    // campuses, or any staff/admin account. (Tagging a corporate learner to
    // a client is done via users.corporate_client_id — the same column
    // Corporate Coordinator accounts use — set when the participant is
    // enrolled through POST /users/participants.)
    const scopedClientId = corporateClientScopeFor(req.user);
    if (scopedClientId) {
      return res.json({
        users: db
          .prepare("SELECT * FROM users WHERE role = 'learner' AND corporate_client_id = ?")
          .all(scopedClientId)
          .map(toPublicUser),
      });
    }
  }
  if (req.user.role === "instructor") {
    const myClasses = getInstructorClassIds(req.user.id);
    const myCourses = getInstructorCourseIds(req.user.id);
    const myInstances = getInstructorInstanceIds(req.user.id);
    if (myClasses.length === 0 && myCourses.length === 0 && myInstances.length === 0) {
      return res.json({ users: [] });
    }
    // Candidate set only — deliberately broad. isLearnerAssignedToInstructor()
    // below is the actual authorization boundary (same function every
    // other route in this codebase uses), so this SQL only needs to be a
    // superset that's cheap to compute; it must not be narrower than what
    // that function would allow, or a correctly-scoped learner silently
    // never reaches the post-filter to be included.
    const clauses = [];
    if (myClasses.length) { clauses.push(`class_id IN (${myClasses.map(() => "?").join(",")})`); params.push(...myClasses); }
    if (myCourses.length) {
      clauses.push(`(is_adult = 1 AND id IN (SELECT user_id FROM enrollments WHERE course_id IN (${myCourses.map(() => "?").join(",")})))`);
      params.push(...myCourses);
    }
    if (myInstances.length) {
      // Constitutional path (ABRS v2.2 §17/§8.2): a learner enrolled, via
      // programme_enrollments, into any Learning Instance this instructor
      // is assigned to at all — the exact scope isLearnerAssignedToInstructor
      // narrows precisely (by that assignment's own Course/Programme
      // Level/Campus) in the post-filter below. Without this clause, a
      // learner whose only signal of assignment is programme_enrollments
      // (the normal case for a modern enrollment — legacy `class_id`/
      // `enrollments` rows above are for pre-programme_enrollments/adult
      // learners only) never appeared as a query candidate at all, no
      // matter how correctly Instructor Assignment and Enrollment were
      // configured.
      clauses.push(
        `id IN (SELECT DISTINCT user_id FROM programme_enrollments WHERE learning_instance_id IN (${myInstances.map(() => "?").join(",")}))`
      );
      params.push(...myInstances);
    }
    if (!clauses.length) {
      return res.json({ users: [] });
    }
    sql += ` AND (role != 'learner' OR ${clauses.join(" OR ")})`;
    // Additionally narrow by Campus, but only when every one of the
    // instructor's assignment rows names a specific Campus (no wildcard
    // row) — otherwise the instructor's scope genuinely spans every
    // Campus somewhere and no safe narrowing filter can be built.
    const myCampuses = getInstructorCampusIds(req.user.id);
    if (myCampuses !== null && myCampuses.length) {
      // users.campus stores the campus NAME (e.g. "Woodbridge International
      // School"), while instructor_assignments.campus_id — and therefore
      // myCampuses — stores the campus ID. Comparing them directly (as this
      // used to) can never match, which silently emptied "My Learners" for
      // every instructor with a campus-specific (non-wildcard) assignment,
      // even though the instance/class-based clause above had already
      // correctly identified their learners. Resolve ids -> names first, the
      // same way messages.js/notes.js already do for campus targeting.
      sql += ` AND (role != 'learner' OR campus IN (SELECT name FROM campuses WHERE id IN (${myCampuses.map(() => "?").join(",")})))`;
      params.push(...myCampuses);
    }
  }
  sql += " ORDER BY created_at DESC";
  let rows = db.prepare(sql).all(...params);
  // Authoritative scope check (ABRS v2.2 §8.2/§17) — the SQL above is
  // only a cheap candidate filter; isLearnerAssignedToInstructor is the
  // single source of truth every other route already enforces this
  // through, so the final learner list an instructor sees can never
  // disagree with what those routes individually allow, and can never
  // include a learner outside this instructor's actual assignment scope
  // (Learning Instance + Course + Programme Level + Campus).
  if (req.user.role === "instructor") {
    rows = rows.filter((r) => r.role !== "learner" || isLearnerAssignedToInstructor(req.user.id, r.id));
  }
  const classById = new Map(db.prepare("SELECT id, name FROM classes").all().map((c) => [c.id, c.name]));
  const campusById = new Map(db.prepare("SELECT id, name FROM campuses").all().map((c) => [c.id, c.name]));
  const courseById = new Map(db.prepare("SELECT id, title FROM courses").all().map((c) => [c.id, c.title]));
  const instanceById = new Map(db.prepare("SELECT id, name FROM learning_instances").all().map((li) => [li.id, li.name]));
  const users = rows.map((r) => {
    const u = toPublicUser(r);
    if (r.role === "learner") {
      u.className = r.class_id ? classById.get(r.class_id) || null : null;
    }
    if (r.role === "instructor") {
      u.classIds = getInstructorClassIds(r.id);
      u.classNames = u.classIds.map((cid) => classById.get(cid)).filter(Boolean);
      u.assignedCourseIds = getInstructorCourseIds(r.id);
      u.assignedCourseNames = u.assignedCourseIds.map((cid) => courseById.get(cid)).filter(Boolean);
      u.assignedInstanceIds = getInstructorInstanceIds(r.id);
      u.assignedInstanceNames = u.assignedInstanceIds.map((iid) => instanceById.get(iid)).filter(Boolean);
      // §8.2 Instructor Assignment — Manage Accounts' Campus column used to
      // read users.campus directly, but that column is never set for an
      // instructor (their campus scope lives on instructor_assignments,
      // same as classIds/assignedCourseIds above), so it always showed "—"
      // even for a fully-assigned instructor. getInstructorCampusIds()
      // returns null when the instructor's scope spans every campus
      // (a wildcard assignment row) — surfaced here as an explicit
      // campusNames: null so the frontend can render "All campuses"
      // instead of silently showing nothing.
      const instructorCampusIds = getInstructorCampusIds(r.id);
      u.campusIds = instructorCampusIds;
      u.campusNames = instructorCampusIds === null ? null : instructorCampusIds.map((cid) => campusById.get(cid)).filter(Boolean);
    }
    return u;
  });
  res.json({ users });
});

// Admin-only: create an instructor or admin account (never self-registered).
// For instructors, admin also assigns which class(es) (Foundation/Framework/
// Skyline) and which module(s) they'll teach — instructors only ever see and
// interact with these going forward.
router.post("/staff", requireAuth, requireRole("admin"), (req, res) => {
  const { name, email, password, role, phone, specialty, assignments, roleTemplateId, customPermissions, campus, corporateClientId } = req.body;
  if (!name || !email || !password || !["instructor", "admin"].includes(role)) {
    return res.status(400).json({ error: "name, email, password and a valid role are required." });
  }
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  // Creating an instructor account is an access-granting action of its own
  // and must actually require the instructors.create permission — not just
  // rely on whichever Role Template the caller happens to have, since a
  // template's *default* permissions are a starting point a Super
  // Administrator can customize away (see utils/permissions.js). Real
  // enforcement belongs here, at the route, per the Single Ownership
  // Principle applied to the API surface (§20.2 — exactly one place
  // decides whether this action is allowed).
  if (role === "instructor" && !hasPermission(req.user, "instructors.create")) {
    return res.status(403).json({ error: "You don't have permission to create instructor accounts." });
  }

  // Creating another Administrator account is itself an access-granting
  // action — only a Super Administrator may do it, and (per spec) the new
  // admin never gets automatic full access: the caller must explicitly pick
  // Option 1 (a Role Template) or Option 2 (a Custom Permission Set).
  let template = null;
  let sanitizedCustomPermissions = null;
  if (role === "admin") {
    if (!isSuperAdmin(req.user)) return res.status(403).json({ error: "Only a Super Administrator can create administrator accounts." });
    if (roleTemplateId) {
      template = getRoleTemplate(roleTemplateId);
      if (!template || !template.isActive) return res.status(400).json({ error: "Unknown or inactive Role Template." });
    } else if (Array.isArray(customPermissions)) {
      sanitizedCustomPermissions = customPermissions.filter((p) => ALL_PERMISSIONS.includes(p));
    } else {
      return res.status(400).json({ error: "Assign either a roleTemplateId (Option 1) or a customPermissions[] array (Option 2)." });
    }
    if (template && template.name === "Corporate Coordinator" && !corporateClientId) {
      return res.status(400).json({ error: "corporateClientId is required for the Corporate Coordinator template." });
    }
  }

  const normEmail = String(email).toLowerCase().trim();
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(normEmail)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  const id = uuid();
  const hash = bcrypt.hashSync(password, 12);

  // A Campus Administrator who has been explicitly granted
  // instructors.create (via a Custom Permission Set — it's off the default
  // template now) may only ever produce instructors scoped to their own
  // campus, regardless of what campusId the client sent on each assignment
  // entry — otherwise the campus scope on the account creation form would
  // be purely cosmetic.
  let forcedCampusId = null;
  const actingScope = campusScopeFor(req.user);
  if (role === "instructor" && actingScope != null) {
    const campusRow = db.prepare("SELECT id FROM campuses WHERE name = ?").get(actingScope);
    forcedCampusId = campusRow ? campusRow.id : null;
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, phone, specialty, campus, status, payment_status, joined_date, role_template_id, custom_permissions, corporate_client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'current', date('now'), ?, ?, ?)`
    ).run(
      id, role, name, normEmail, hash, phone || null, specialty || null,
      role === "admin" ? campus || null : null,
      template ? template.id : null,
      sanitizedCustomPermissions ? JSON.stringify(sanitizedCustomPermissions) : null,
      role === "admin" && template && template.name === "Corporate Coordinator" ? corporateClientId : null
    );
    if (role === "instructor" && Array.isArray(assignments) && assignments.length) {
      const effectiveAssignments = forcedCampusId
        ? assignments.map((a) => ({ ...a, campusId: forcedCampusId }))
        : assignments;
      replaceInstructorAssignments(id, effectiveAssignments);
    }
  });
  tx();
  recordAuditLog({
    req,
    action: "create",
    entityType: "users",
    entityId: id,
    entityLabel: name,
    details: { email: normEmail, role, roleTemplate: template ? template.name : undefined, customPermissions: sanitizedCustomPermissions || undefined },
  });
  res.json({ ok: true, id });
});

/* ---------------------------------------------------------------------
   RBAC: assign a predefined Role Template (Option 1) or a Custom
   Permission Set (Option 2) to an existing administrator. Super
   Administrator only — and a Super Administrator can never demote the
   last remaining Super Administrator this way.
   --------------------------------------------------------------------- */
router.patch("/:userId/role-template", requireAuth, requireSuperAdmin, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(req.params.userId);
  if (!target) return res.status(404).json({ error: "Administrator not found." });
  const { roleTemplateId, corporateClientId, campus } = req.body;
  const template = getRoleTemplate(roleTemplateId);
  if (!template || !template.isActive) return res.status(400).json({ error: "Unknown or inactive Role Template." });
  if (template.name === "Corporate Coordinator" && !corporateClientId && !target.corporate_client_id) {
    return res.status(400).json({ error: "corporateClientId is required for the Corporate Coordinator template." });
  }
  // Campus Administrator needs a campus to actually be scoped to (see
  // utils/rbac.js campusScopeFor — no campus means no scope restriction
  // at all, i.e. accidentally unrestricted access). Previously campus
  // could only be set at account-CREATION time (POST /staff); this lets a
  // Super Administrator supply/change it here too, at template-assignment
  // time, closing the gap where switching an existing admin to Campus
  // Administrator had no way to actually attach a campus. An admin
  // already carrying a campus from creation keeps it if none is supplied.
  let resolvedCampusName = target.campus || null;
  if (template.name === "Campus Administrator") {
    const requested = campus !== undefined ? campus : target.campus;
    if (!requested || !String(requested).trim()) {
      return res.status(400).json({ error: "campus is required when assigning the Campus Administrator template." });
    }
    const resolved = resolveCampusByName(requested);
    if (!resolved) return res.status(400).json({ error: `"${String(requested).trim()}" doesn't match any existing campus.` });
    resolvedCampusName = resolved.name;
  } else if (campus !== undefined) {
    // Any other template: campus is meaningless (only Campus Administrator
    // is scoped by it), so clear it rather than leave a stale value that
    // could be misread elsewhere.
    resolvedCampusName = null;
  }
  try {
    assertSuperAdminActionAllowed(target);
  } catch (e) {
    return res.status(e.status || 409).json({ error: e.message });
  }
  db.prepare("UPDATE users SET role_template_id = ?, custom_permissions = NULL, corporate_client_id = ?, campus = ? WHERE id = ?").run(
    template.id,
    template.name === "Corporate Coordinator" ? corporateClientId || target.corporate_client_id : null,
    resolvedCampusName,
    req.params.userId
  );
  recordAuditLog({
    req,
    action: "update",
    entityType: "users",
    entityId: target.id,
    entityLabel: target.name,
    before: { roleTemplate: getRoleTemplate(target.role_template_id)?.name || null, campus: target.campus },
    after: { roleTemplate: template.name, campus: resolvedCampusName },
  });
  res.json({ ok: true });
});

// RBAC: change an existing Campus Administrator's assigned campus WITHOUT
// touching their Role Template/permissions — the counterpart to the
// campus-setting logic above for the common case (an admin is already a
// Campus Administrator and just needs reassigning to a different campus).
// Super Administrator only, per the same protection as role-template
// changes. Kept as its own endpoint rather than folded into the generic
// learner-only PATCH /:userId/campus above, per §20.2 (Single Ownership
// extended to the API surface) — that route explicitly targets
// role='learner' records and a different set of business rules (campus
// scope self-restriction for the acting Campus Administrator) applies to
// learner campus reassignment than to an admin account's own scope.
router.patch("/:userId/campus-assignment", requireAuth, requireSuperAdmin, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(req.params.userId);
  if (!target) return res.status(404).json({ error: "Administrator not found." });
  const template = getRoleTemplate(target.role_template_id);
  if (!template || template.name !== "Campus Administrator") {
    return res.status(400).json({ error: "This account isn't assigned the Campus Administrator template — use the role-template endpoint to assign it (with a campus) first." });
  }
  const { campus } = req.body;
  if (!campus || !String(campus).trim()) return res.status(400).json({ error: "campus is required." });
  const resolved = resolveCampusByName(campus);
  if (!resolved) return res.status(400).json({ error: `"${String(campus).trim()}" doesn't match any existing campus.` });
  db.prepare("UPDATE users SET campus = ? WHERE id = ?").run(resolved.name, req.params.userId);
  recordAuditLog({
    req,
    action: "update",
    entityType: "users",
    entityId: target.id,
    entityLabel: target.name,
    before: { campus: target.campus },
    after: { campus: resolved.name },
  });
  res.json({ ok: true, campus: resolved.name });
});

router.patch("/:userId/permissions", requireAuth, requireSuperAdmin, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(req.params.userId);
  if (!target) return res.status(404).json({ error: "Administrator not found." });
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: "permissions[] is required." });
  try {
    assertSuperAdminActionAllowed(target);
  } catch (e) {
    return res.status(e.status || 409).json({ error: e.message });
  }
  const sanitized = permissions.filter((p) => ALL_PERMISSIONS.includes(p));
  db.prepare("UPDATE users SET custom_permissions = ? WHERE id = ?").run(JSON.stringify(sanitized), req.params.userId);
  recordAuditLog({
    req,
    action: "update",
    entityType: "users",
    entityId: target.id,
    entityLabel: target.name,
    details: { customPermissionsSet: sanitized },
  });
  res.json({ ok: true });
});

// Super Administrator only: permanently remove an administrator account.
// Guarded so the last active Super Administrator can never be deleted.
router.delete("/:userId", requireAuth, requireSuperAdmin, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(req.params.userId);
  if (!target) return res.status(404).json({ error: "Administrator not found." });
  try {
    assertSuperAdminActionAllowed(target);
  } catch (e) {
    return res.status(e.status || 409).json({ error: e.message });
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.userId);
  recordAuditLog({
    req,
    action: "delete",
    entityType: "users",
    entityId: target.id,
    entityLabel: target.name,
    details: { email: target.email, role: target.role },
  });
  res.json({ ok: true });
});

// Admin-only: change which Programme Run(s)/Course(s)/Programme Level(s)/
// Campus(es) an existing instructor is assigned to (ABRS v2.2 §8.2 —
// Instructor Assignment). Replaces the full set each time (simplest to
// reason about from the cascading assignment editor on the frontend).
// Body: { assignments: [{ learningInstanceId, courseId?, classId?,
// campusId? }, ...] } — each entry is one grant; a caller wanting "every
// Course of this Run" for an instructor simply omits courseId on that
// entry (NULL = wildcard, see utils/instructorScope.js).
router.patch("/:userId/assignments", requireAuth, requireRole("admin"), (req, res) => {
  if (!hasPermission(req.user, "instructors.edit")) {
    return res.status(403).json({ error: "You don't have permission to edit instructor assignments." });
  }
  const { assignments } = req.body;
  if (!Array.isArray(assignments)) return res.status(400).json({ error: "assignments[] is required." });
  const instructor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'instructor'").get(req.params.userId);
  if (!instructor) return res.status(404).json({ error: "Instructor not found." });
  for (const a of assignments) {
    if (!a || !a.learningInstanceId) {
      return res.status(400).json({ error: "Every assignment requires a learningInstanceId (an Active Learning Instance)." });
    }
    const li = db.prepare("SELECT id FROM learning_instances WHERE id = ?").get(a.learningInstanceId);
    if (!li) return res.status(400).json({ error: `Learning Instance ${a.learningInstanceId} not found.` });
    if (a.courseId && !db.prepare("SELECT 1 FROM courses WHERE id = ?").get(a.courseId)) {
      return res.status(400).json({ error: `Course ${a.courseId} not found.` });
    }
    if (a.classId && !db.prepare("SELECT 1 FROM classes WHERE id = ?").get(a.classId)) {
      return res.status(400).json({ error: `Programme Level ${a.classId} not found.` });
    }
    if (a.campusId && !db.prepare("SELECT 1 FROM campuses WHERE id = ?").get(a.campusId)) {
      return res.status(400).json({ error: `Campus ${a.campusId} not found.` });
    }
  }
  // A Campus Administrator (scoped) may only ever set assignments within
  // their own campus — same rule as instructor creation above.
  const actingScope = campusScopeFor(req.user);
  let effectiveAssignments = assignments;
  if (actingScope != null) {
    const campusRow = db.prepare("SELECT id FROM campuses WHERE name = ?").get(actingScope);
    const forcedCampusId = campusRow ? campusRow.id : null;
    effectiveAssignments = assignments.map((a) => ({ ...a, campusId: forcedCampusId }));
  }
  replaceInstructorAssignments(req.params.userId, effectiveAssignments);
  res.json({ ok: true, assignments: db.prepare("SELECT * FROM instructor_assignments WHERE instructor_id = ?").all(req.params.userId) });
});

// Admin-only: the instructor's current assignment rows, each enriched
// with display names for the cascading Learning Instance -> Course/
// Programme Level/Campus editor (a null field means "every value of that
// dimension", see utils/instructorScope.js).
router.get("/:userId/assignments", requireAuth, requireRole("admin"), (req, res) => {
  const instructor = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'instructor'").get(req.params.userId);
  if (!instructor) return res.status(404).json({ error: "Instructor not found." });
  const rows = db
    .prepare(
      `SELECT ia.id, ia.learning_instance_id as learningInstanceId, li.name as learningInstanceName,
              ia.course_id as courseId, c.title as courseTitle,
              ia.class_id as classId, cl.name as className,
              ia.campus_id as campusId, cp.name as campusName
       FROM instructor_assignments ia
       JOIN learning_instances li ON li.id = ia.learning_instance_id
       LEFT JOIN courses c ON c.id = ia.course_id
       LEFT JOIN classes cl ON cl.id = ia.class_id
       LEFT JOIN campuses cp ON cp.id = ia.campus_id
       WHERE ia.instructor_id = ?
       ORDER BY li.name ASC`
    )
    .all(req.params.userId);
  res.json({ assignments: rows });
});

// Admin-only: cascading options for one Active Learning Instance —
// the Course(s), Programme Level(s) and Campus(es) available for
// Instructor Assignment within it (ABRS v2.2 §8.2). Kept here (rather
// than routes/learningInstances.js) since it's purely in service of this
// file's assignment endpoints and reads the same catalogs already
// available to this router.
router.get("/learning-instances/:id/assignment-options", requireAuth, requireRole("admin"), (req, res) => {
  const li = db.prepare("SELECT id, programme_id, course_id, campus_ids FROM learning_instances WHERE id = ?").get(req.params.id);
  if (!li) return res.status(404).json({ error: "Learning Instance not found." });

  // Courses: this Run's own single Course (a Course-type Run), plus every
  // Course activated for it (learning_instance_courses, §9) and — for a
  // Programme-type Run with no Activated Course rows configured yet —
  // every Course in that Programme's Course Library, so the picker is
  // never empty just because nobody has activated Courses individually.
  const courseIds = new Set();
  if (li.course_id) courseIds.add(li.course_id);
  db.prepare("SELECT course_id FROM learning_instance_courses WHERE learning_instance_id = ?").all(li.id).forEach((r) => courseIds.add(r.course_id));
  if (li.programme_id && courseIds.size === 0) {
    db.prepare("SELECT id FROM courses WHERE programme_id = ?").all(li.programme_id).forEach((r) => courseIds.add(r.id));
  }
  const courses = courseIds.size
    ? db.prepare(`SELECT id, title FROM courses WHERE id IN (${[...courseIds].map(() => "?").join(",")}) ORDER BY title ASC`).all(...courseIds)
    : [];

  // Programme Levels: every Class belonging to this Run's Programme.
  const classes = li.programme_id
    ? db.prepare("SELECT id, name FROM classes WHERE programme_id = ? ORDER BY sort_order ASC, name ASC").all(li.programme_id)
    : [];

  // Campuses: this Run's own configured campus_ids if set, otherwise
  // every active Campus (so a Run with no campus restriction still lets
  // an admin narrow an individual instructor's assignment by Campus).
  let campusIds = [];
  try {
    campusIds = li.campus_ids ? JSON.parse(li.campus_ids) : [];
  } catch { campusIds = []; }
  const campuses = campusIds.length
    ? db.prepare(`SELECT id, name FROM campuses WHERE id IN (${campusIds.map(() => "?").join(",")}) ORDER BY name ASC`).all(...campusIds)
    : db.prepare("SELECT id, name FROM campuses ORDER BY name ASC").all();

  res.json({ courses, classes, campuses });
});

// Admin-only: create a learner account directly under a non-Kids-STEM
// Learning Offering (Adult Professional, Corporate Training, Bootcamp) —
// these don't go through the parent-led signup flow in routes/auth.js since
// per spec "Parents are not required" outside Kids STEM. The learner is
// immediately placed in the given Learning Group (classId), which resolves
// their programme via classes.programme_id exactly like every other learner
// record — no separate "adult"/"corporate" table needed.
router.post("/participants", requireAuth, requireRole("admin"), (req, res) => {
  const { name, email, phone, campus, classId, programmeId: requestedProgrammeId, password, educationLevel, status: requestedStatus, corporateClientId, learningInstanceId: requestedLearningInstanceId, operationalGroupId: requestedOperationalGroupId, waivePayment } = req.body;
  if (!name || !email || (!classId && !requestedProgrammeId)) {
    return res.status(400).json({ error: "name, email and either classId or programmeId are required." });
  }
  let cls = classId ? db.prepare("SELECT * FROM classes WHERE id = ?").get(classId) : null;
  // If no classId, resolve programmeId from requestedProgrammeId; cls stays null
  // (Bootcamp/Adult offerings may not use a class at all — the programme and run
  // are the authoritative placement, not the class row). classId not required for
  // these offering types — resolveActiveInstanceForRegistration handles it purely
  // from programmeId + optional operationalGroupId + optional learningInstanceId.
  let programmeId = cls ? cls.programme_id : requestedProgrammeId || null;
  if (!programmeId) {
    return res.status(400).json({ error: "Could not resolve programme for registration. Provide classId or programmeId." });
  }

  if (programmeRequiresParent(programmeId)) {
    return res.status(400).json({ error: "This Learning Group's offering type requires a parent account — use the parent-led registration flow instead." });
  }
  const resolvedRun = resolveActiveInstanceForRegistration(programmeId, requestedOperationalGroupId, requestedLearningInstanceId);
  if (resolvedRun.ambiguous) {
    return res.status(409).json({
      error: "This programme currently has more than one active run — specify learningInstanceId (and optionally operationalGroupId) for the intended Run.",
      activeRuns: resolvedRun.options.map((o) => ({ id: o.id, name: o.name })),
    });
  }
  const learningInstanceId = resolvedRun.instance ? resolvedRun.instance.id : null;
  if (!learningInstanceId) {
    return res.status(409).json({ error: "There are currently no available registration opportunities for this programme — an admin has not opened an active registration run yet." });
  }
  if (requestedOperationalGroupId) {
    const group = db.prepare("SELECT id, learning_instance_id, is_active FROM operational_groups WHERE id = ?").get(requestedOperationalGroupId);
    if (!group || group.learning_instance_id !== learningInstanceId || !group.is_active) {
      return res.status(400).json({ error: "operationalGroupId is not a valid, active Operational Group for the selected Programme Run." });
    }
  }
  const normEmail = String(email).toLowerCase().trim();
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(normEmail)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const userStatus = waivePayment ? "active" : requestedStatus || "pending_payment";
  const userPaymentStatus = waivePayment ? "current" : "unpaid";
  const effectiveClassId = cls ? cls.id : null;

  const id = uuid();
  const tempPassword = password || crypto.randomBytes(6).toString("hex");
  const hash = bcrypt.hashSync(tempPassword, 12);
  const tx = db.transaction(() => {
    const capCheck = checkOperationalGroupCapacity(requestedOperationalGroupId, learningInstanceId, 1);
    if (!capCheck.ok) {
      throw Object.assign(new Error(capCheck.error), { status: 409 });
    }
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, phone, campus, status, payment_status, joined_date, class_id, is_adult, education_level, student_code, corporate_client_id)
       VALUES (?, 'learner', ?, ?, ?, ?, ?, ?, ?, date('now'), ?, 1, ?, ?, ?)`
    ).run(id, name, normEmail, hash, phone || null, campus || null, userStatus, userPaymentStatus, effectiveClassId, educationLevel || null, `P-${id.slice(0, 8).toUpperCase()}`, corporateClientId || null);

    const enrollmentId = uuid();
    const operationalSnapshot = deriveEnrollmentOperationalSnapshot({
      classRow: cls || { programme_id: programmeId },
      instanceId: learningInstanceId,
      operationalGroupId: requestedOperationalGroupId || null,
    });
    const pricingSnapshot = pricingEngine.buildPricingSnapshot({
      learningInstanceId,
      classId: effectiveClassId,
      operationalGroupId: operationalSnapshot.operationalGroupId,
      corporateClientId: corporateClientId || null,
    });
    const financialPolicySnapshot = pricingEngine.buildFinancialPolicySnapshot({ learningInstanceId });
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id, delivery_mode, campus_id, academic_period_id, course_group_id, operational_group_id, pricing_snapshot, financial_policy_snapshot)
       VALUES (?, ?, ?, ?, 1, ?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      enrollmentId,
      id,
      programmeId,
      effectiveClassId,
      userStatus,
      userPaymentStatus,
      learningInstanceId,
      operationalSnapshot.deliveryMode,
      operationalSnapshot.campusId,
      operationalSnapshot.academicPeriodId,
      operationalSnapshot.courseGroupId,
      operationalSnapshot.operationalGroupId,
      pricingSnapshot,
      financialPolicySnapshot
    );

    if (waivePayment) {
      activateEnrollmentCurriculum(id, effectiveClassId, [], learningInstanceId);
    }
  });
  try {
    tx();
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    const message = status !== 500 ? e.message : "Failed to create participant. Please try again.";
    return res.status(status).json({ error: message });
  }

  if (waivePayment) {
    recordAuditLog({
      req,
      action: "admin_participant_payment_waived",
      entityType: "users",
      entityId: id,
      entityLabel: name,
      details: { programmeId, learningInstanceId, operationalGroupId: requestedOperationalGroupId || null },
    });
  }

  res.json({ ok: true, id, temporaryPassword: password ? undefined : tempPassword });
});

// Admin-only: create a coordinator account (a "parent" account created BY
// staff, for an NGO/MP/organization representative, rather than
// self-registered by the coordinator). Identity is established at
// issuance — an admin who has already verified who they're handing
// credentials to — rather than verified after the fact once someone has
// already self-registered and claimed an affiliation. See
// db/migrate.js's "Coordinator accounts" section for the caps this sets
// up, and POST /:parentId/children below for how every child this
// account adds is auto-sponsored using sponsorId here.
router.post("/coordinators", requireAuth, requirePermission("sponsors.edit"), (req, res) => {
  const { name, email, phone, password, sponsorId, maxChildren, scope } = req.body;
  if (!name || !email) return res.status(400).json({ error: "name and email are required." });

  const sponsor = db.prepare("SELECT id, is_active FROM sponsors WHERE id = ?").get(sponsorId);
  if (!sponsor) return res.status(400).json({ error: "sponsorId does not match a known sponsor." });
  if (!sponsor.is_active) return res.status(400).json({ error: "This sponsor is deactivated — reactivate it first, or choose another sponsor." });

  if (maxChildren !== undefined && maxChildren !== null && (!Number.isInteger(maxChildren) || maxChildren < 1)) {
    return res.status(400).json({ error: "maxChildren must be a positive whole number, or omitted for no limit." });
  }
  const coordinatorScope = scope || "child";
  if (!["child", "adult", "both"].includes(coordinatorScope)) {
    return res.status(400).json({ error: "scope must be one of: child, adult, both." });
  }

  const normEmail = String(email).toLowerCase().trim();
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(normEmail)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const id = uuid();
  const tempPassword = password || crypto.randomBytes(6).toString("hex");
  const hash = bcrypt.hashSync(tempPassword, 12);
  db.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, phone, status, payment_status, joined_date, sponsor_id, max_children, coordinator_scope)
     VALUES (?, 'parent', ?, ?, ?, ?, 'active', 'current', date('now'), ?, ?, ?)`
  ).run(id, name, normEmail, hash, phone || null, sponsorId, maxChildren ?? null, coordinatorScope);

  res.json({ ok: true, id, temporaryPassword: password ? undefined : tempPassword });
});

// Admin resets a coordinator's password and gets the new plaintext back
// to hand over again — for exactly the situation the earlier credential
// handover flow (POST /coordinators) doesn't cover: the password was
// only ever shown once, and if that got missed or lost there was
// previously no way to recover it (correctly — nothing stores the
// plaintext). This generates a brand new one rather than revealing the
// old one, since the old one was never retrievable in the first place.
// Deliberately scoped to coordinator accounts specifically (role
// 'parent' with a sponsor_id) rather than any account — resetting an
// instructor's or another admin's password and being handed the
// plaintext is a materially more sensitive capability that wasn't asked
// for here and deserves its own separate review if it's ever needed.
router.post("/:userId/reset-credentials", requireAuth, requirePermission("sponsors.edit"), (req, res) => {
  const user = db.prepare("SELECT id, role, sponsor_id FROM users WHERE id = ?").get(req.params.userId);
  if (!user) return res.status(404).json({ error: "Not found." });
  if (user.role !== "parent" || !user.sponsor_id) {
    return res.status(400).json({ error: "This account isn't a coordinator account." });
  }
  const tempPassword = crypto.randomBytes(6).toString("hex");
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(tempPassword, 12), req.params.userId);
  res.json({ ok: true, temporaryPassword: tempPassword });
});

// Admin-only: assign (or reassign) a single learner's class.
router.patch("/:userId/class", requireAuth, requireRole("admin"), requireInAdminScope("userId"), (req, res) => {
  const { classId } = req.body;
  const learner = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'learner'").get(req.params.userId);
  if (!learner) return res.status(404).json({ error: "Learner not found." });
  if (classId) {
    const cls = db.prepare("SELECT id FROM classes WHERE id = ?").get(classId);
    if (!cls) return res.status(400).json({ error: "Unknown class." });
  }
  db.prepare("UPDATE users SET class_id = ? WHERE id = ?").run(classId || null, req.params.userId);
  res.json({ ok: true });
});

// Admin-only: assign/reassign a learner's campus directly. Adult learners'
// campus/class are managed independently of the child promotion workflow —
// this reuses the same users.campus column read everywhere else in the app.
router.patch("/:userId/campus", requireAuth, requireRole("admin"), requireInAdminScope("userId"), (req, res) => {
  const { campus } = req.body;
  const learner = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'learner'").get(req.params.userId);
  if (!learner) return res.status(404).json({ error: "Learner not found." });

  // A Campus Administrator is scoped to exactly one campus (see
  // utils/rbac.js campusScopeFor) — they may reassign a learner's class
  // within that campus, but must never be able to move a learner OUT to a
  // campus outside their own scope, which would otherwise let a
  // campus-restricted admin bypass their own scoping by editing the
  // record instead of viewing it.
  const scope = campusScopeFor(req.user);
  if (scope != null) {
    const normalizedNew = campus ? String(campus).trim() : null;
    if (normalizedNew !== scope) {
      return res.status(403).json({ error: "You can only assign learners to your own campus." });
    }
  }

  // Validate against the canonical campuses table (§3/§2.1) rather than
  // trusting arbitrary free text here either.
  let resolvedCampus = null;
  if (campus && String(campus).trim()) {
    resolvedCampus = resolveCampusByName(campus);
    if (!resolvedCampus) return res.status(400).json({ error: `"${String(campus).trim()}" doesn't match any existing campus.` });
  }

  db.prepare("UPDATE users SET campus = ? WHERE id = ?").run(resolvedCampus ? resolvedCampus.name : null, req.params.userId);
  res.json({ ok: true });
});

// Admin-only: promote one or many learners to the next class in sequence
// (Foundation -> Framework -> Skyline), or to an explicit `toClassId`.
// Also logs to promotion_log and advances each learner into the active
// Academic Year (see utils/academicTerm.js / db/schema.sql's promotion_log)
// — the richer, term-aware Promotion Engine in routes/promotion.js shares
// this same audit trail for its own promote/repeat/transfer/graduate
// actions, so this stays the one place class-sequence advancement happens.
router.post("/promote", requireAuth, requireRole("admin"), (req, res) => {
  const { userIds, toClassId } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: "userIds[] is required." });
  const classes = db.prepare("SELECT * FROM classes ORDER BY sort_order ASC").all();
  const activeYear = getActiveYear();
  const results = [];
  const tx = db.transaction(() => {
    userIds.forEach((uid) => {
      const learner = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'learner'").get(uid);
      if (!learner) { results.push({ id: uid, ok: false, error: "Not found." }); return; }
      if (!isTargetInAdminScope(req.user, learner)) { results.push({ id: uid, ok: false, error: "Not found." }); return; }
      let destId = toClassId || null;
      if (!destId) {
        const idx = classes.findIndex((c) => c.id === learner.class_id);
        const next = classes[idx + 1];
        if (!next) { results.push({ id: uid, ok: false, error: `${learner.name} is already in the highest class.` }); return; }
        destId = next.id;
      }
      const toYearId = activeYear ? activeYear.id : learner.current_academic_year_id;
      db.prepare("UPDATE users SET class_id = ?, current_academic_year_id = ? WHERE id = ?").run(destId, toYearId, uid);
      db.prepare(
        `INSERT INTO promotion_log (id, learner_id, action, from_year_id, to_year_id, details, performed_by)
         VALUES (?, ?, 'promote', ?, ?, ?, ?)`
      ).run(uuid(), uid, learner.current_academic_year_id, toYearId, JSON.stringify({ fromClassId: learner.class_id, toClassId: destId }), req.user.id);
      results.push({ id: uid, ok: true, classId: destId });
    });
  });
  tx();
  res.json({ ok: true, results });
});

// Admin/instructor: look up a learner (or their parent) by the unique
// student ID — used when confirming a Mobile Money payment reference.
// Self/parent/staff: which instructors teach this learner's enrolled
// modules, and which module(s) each one teaches — this is what powers the
// "message your ward's instructors" contact list for parents (and for the
// learner themselves), scoped properly instead of exposing the full
// admin-only staff directory.
// Bug fix: this used to build the contacts list purely from
// instructor_courses, regardless of the learner's class or is_adult
// status — but the actual send-permission check
// (isLearnerAssignedToInstructor, utils/instructorScope.js) only allows
// module-based eligibility for ADULT learners, and otherwise requires
// the instructor to own the learner's class (instructor_classes). That
// mismatch meant a child learner's contact list could show an
// instructor who taught one of their modules but didn't own their
// class — a real instructor they could see but POST /api/messages would
// then reject with "You can only message an instructor assigned to
// you." This now applies the exact same two-part rule
// isLearnerAssignedToInstructor uses, so anyone shown here is always
// actually messageable.
router.get("/instructors-for/:learnerId", requireAuth, requireSelfParentOrStaff("learnerId"), requireInAdminScope("learnerId"), (req, res) => {
  const learner = db.prepare("SELECT id, class_id, is_adult FROM users WHERE id = ? AND role = 'learner'").get(req.params.learnerId);
  if (!learner) return res.status(404).json({ error: "Learner not found." });

  // Built directly from isLearnerAssignedToInstructor (utils/
  // instructorScope.js) — the exact same function POST /api/messages
  // checks before allowing a send — so anyone shown here is always
  // actually messageable, by construction rather than by keeping two
  // rules in sync by hand.
  const instructors = db.prepare("SELECT id, name, email, phone FROM users WHERE role = 'instructor'").all();
  const eligible = instructors.filter((i) => isLearnerAssignedToInstructor(i.id, req.params.learnerId));
  const withCourses = eligible.map((i) => ({ ...i, courseIds: getInstructorCourseIds(i.id) }));

  res.json({ instructors: withCourses });
});

router.get("/lookup/:studentCode", requireAuth, requireRole("admin", "instructor"), (req, res) => {
  const learner = db.prepare("SELECT * FROM users WHERE student_code = ? AND role = 'learner'").get(req.params.studentCode);
  if (!learner) return res.status(404).json({ error: "No learner found with that ID." });
  // No :userId URL param here (lookup is by student code), so the scope
  // check is manual rather than via requireInAdminScope — same rule,
  // same 404-for-out-of-scope behavior as every other per-record route.
  if (req.user.role === "admin" && !isTargetInAdminScope(req.user, learner)) {
    return res.status(404).json({ error: "No learner found with that ID." });
  }
  const parent = learner.parent_id ? db.prepare("SELECT * FROM users WHERE id = ?").get(learner.parent_id) : null;
  res.json({ learner: toPublicUser(learner), parent: parent ? toPublicUser(parent) : null });
});

// Admin-only: suspend / reactivate an account
router.patch("/:userId/status", requireAuth, requireRole("admin"), requireInAdminScope("userId"), (req, res) => {
  const { status } = req.body;
  if (!["active", "suspended", "pending_payment"].includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  const target = req.targetUser;
  // Only a Super Administrator manages other admin accounts' status, and
  // the last active Super Administrator can never be suspended.
  if (target.role === "admin") {
    if (!isSuperAdmin(req.user)) return res.status(403).json({ error: "Only a Super Administrator can change an administrator's status." });
    if (status === "suspended") {
      try {
        assertSuperAdminActionAllowed(target);
      } catch (e) {
        return res.status(e.status || 409).json({ error: e.message });
      }
    }
  }
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, req.params.userId);
  recordAuditLog({
    req,
    action: "status_change",
    entityType: "users",
    entityId: target.id,
    entityLabel: target.name,
    before: { status: target.status },
    after: { status },
  });
  res.json({ ok: true });
});

// Admin-only: grant/revoke the Access Override (see utils/accessControl.js).
// Bypasses payment/pending-payment restrictions only — never a 'suspended'
// status, which must still be cleared via PATCH /:userId/status above.
// { override: true, reason: "...", expiresAt: "2026-08-01T00:00:00.000Z" | null }
router.patch("/:userId/access-override", requireAuth, requireRole("admin"), requireInAdminScope("userId"), (req, res) => {
  const { override, reason, expiresAt } = req.body;
  const target = req.targetUser;
  if (!target) return res.status(404).json({ error: "Not found." });
  if (!["learner", "parent"].includes(target.role)) {
    return res.status(400).json({ error: "The access override only applies to learner or parent accounts." });
  }
  if (override && !reason) {
    return res.status(400).json({ error: "A reason is required when granting an access override." });
  }
  if (expiresAt !== undefined && expiresAt !== null && Number.isNaN(new Date(expiresAt).getTime())) {
    return res.status(400).json({ error: "expiresAt must be a valid date/time, or null for no expiry." });
  }
  db.prepare(
    "UPDATE users SET access_override = ?, access_override_reason = ?, access_override_expires_at = ? WHERE id = ?"
  ).run(override ? 1 : 0, override ? reason : null, override ? expiresAt || null : null, req.params.userId);
  recordAuditLog({
    req,
    action: "update",
    entityType: "users",
    entityId: target.id,
    entityLabel: target.name,
    before: { accessOverride: !!target.access_override, reason: target.access_override_reason },
    after: { accessOverride: !!override, reason: override ? reason : null, expiresAt: override ? expiresAt || null : null },
  });
  // Enrollment Activation (v30): a Hub-granted fee waiver is, for
  // curriculum purposes, exactly the same "enrollment becomes active"
  // event a successful payment is (see utils/paymentActivation.js) — the
  // learner is meant to have Module access despite never paying. This
  // never runs on revoke (override:false) — access_override's own gating
  // (utils/accessControl.js) is what removes the payment-bypass at that
  // point; nothing here ever un-enrols anyone, matching how every other
  // access change in this codebase works (enforced at the gate, not by
  // deleting data). Only meaningful for a learner (a parent has no
  // class_id/Course of their own to resolve curriculum against).
  if (override && target.role === "learner") {
    let requestedCourseIds = [];
    let learningInstanceId = null;
    if (target.class_id) {
      const primary = db.prepare("SELECT requested_course_ids, learning_instance_id FROM programme_enrollments WHERE user_id=? AND is_primary=1").get(req.params.userId);
      if (primary) {
        learningInstanceId = primary.learning_instance_id;
        try {
          requestedCourseIds = JSON.parse(primary.requested_course_ids || "[]");
        } catch (e) {
          requestedCourseIds = [];
        }
      }
    }
    activateEnrollmentCurriculum(req.params.userId, target.class_id, requestedCourseIds, learningInstanceId);
  }
  res.json({ ok: true });
});

// Admin-only: assign which module(s) a specific learner studies (item 20 —
// courses run in a fixed order and only the modules currently "in season"
// should normally be handed out, but the admin can override here).
router.patch("/:userId/courses", requireAuth, requireRole("admin"), requireInAdminScope("userId"), (req, res) => {
  const { courseIds } = req.body;
  if (!Array.isArray(courseIds)) return res.status(400).json({ error: "courseIds must be an array." });
  const learner = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'learner'").get(req.params.userId);
  if (!learner) return res.status(404).json({ error: "Learner not found." });

  const primaryEnrollment = db
    .prepare("SELECT programme_id, learning_instance_id FROM programme_enrollments WHERE user_id = ? AND is_primary = 1")
    .get(req.params.userId);
  if (
    primaryEnrollment &&
    primaryEnrollment.learning_instance_id &&
    usesRunScopedCourseCurriculum(
      getOfferingTypeSlugForInstance(getLearningInstanceById(primaryEnrollment.learning_instance_id))
    )
  ) {
    const eligible = new Set(getEligibleCoursesForRun(primaryEnrollment.learning_instance_id, primaryEnrollment.programme_id));
    const invalid = courseIds.filter((cid) => !eligible.has(cid));
    if (invalid.length) {
      return res.status(400).json({
        error: "One or more courses are not configured for this learner's Programme Run.",
        invalidCourseIds: invalid,
      });
    }
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM enrollments WHERE user_id = ?").run(req.params.userId);
    const insert = db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)");
    courseIds.forEach((m) => insert.run(req.params.userId, m));
  });
  tx();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Add / remove a child learner AFTER the parent's own registration —
// previously the only way to attach a learner to a parent account was the
// one-time /api/auth/register flow; there was no way to add a second (or
// later) child, or to remove one, once that initial registration was done.
// ---------------------------------------------------------------------
const { nextStudentCode } = require("../utils/studentCode");
const { registrationBreakdown } = require("../utils/fees");
const {
  getOfferingTypeForClass,
  getOfferingTypeForProgramme,
  getDefaultProgrammeForOfferingSlug,
  programmeAllowsSelfRegistration,
  programmeAllowsAudience,
  offeringTypeRequiresCourseSelectionAtRegistration,
} = require("../utils/offeringTypeSettings");

// Mirrors routes/auth.js's own resolveEntryClass (not exported from there,
// so duplicated here rather than reaching across modules for one helper) —
// the Learning Group a new registrant enters by default: this programme's
// lowest sort_order class(es), same rule the original registration flow uses.
function resolveEntryClassForChild(programmeId, preferredClassId) {
  const groups = db.prepare("SELECT * FROM classes WHERE programme_id = ? ORDER BY sort_order ASC, name ASC").all(programmeId);
  if (!groups.length) return null;
  const minSort = groups[0].sort_order;
  const entryGroups = groups.filter((g) => g.sort_order === minSort);
  if (preferredClassId) {
    const match = entryGroups.find((g) => g.id === preferredClassId);
    if (match) return match;
  }
  return entryGroups[0];
}
function generateChildPassword() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

// Adult-learner branch of POST /:parentId/children (see learnerType there)
// — structurally a different registration than Kids STEM: an explicit
// Offering Type → Programme → Batch/Cohort pick (classId is required,
// there's no "default entry class" fallback the way Kids STEM has, since
// there's no single obvious default across Adult Professional/Corporate
// Training/Bootcamp), is_adult=1, the adult's own real email (so they can
// actually use/recover the account themselves — unlike a child, who logs
// in with an auto-generated @learners.* address), and no module-selection
// requirement (mirrors routes/auth.js's own "adult" registration kind).
// Deliberately skips programmeRequiresParent (irrelevant — the calling
// parent/coordinator account satisfies that trivially) and
// programmeAllowsSelfRegistration/resolveProgrammeRegistrationOpen (this
// isn't self-registration — same staff-mediated-bypass reasoning
// POST /participants already uses for admin-added adults).
function addAdultLearnerUnderCoordinator(req, res, parent, sponsor) {
  const { name, email, phone, campus, classId, educationLevel, ownRoboticsKit, courseIds } = req.body;
  if (!name || !email || !classId) return res.status(400).json({ error: "name, email and classId (the programme's Batch/Cohort) are required for an adult learner." });

  const entryClass = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  if (!entryClass) return res.status(400).json({ error: "Unknown classId (Batch/Cohort)." });
  const programme = db.prepare("SELECT * FROM programmes WHERE id = ?").get(entryClass.programme_id);
  if (programme && !programmeAllowsAudience(programme, "adult")) {
    return res.status(400).json({ error: "This programme is only open to child (Kids STEM) registration." });
  }

  const normEmail = String(email).toLowerCase().trim();
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(normEmail)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const learnerId = uuid();
  const learnerPassword = generateChildPassword();
  const learnerHash = bcrypt.hashSync(learnerPassword, 12);
  const studentCode = nextStudentCode();
  const eduLevel = ["Senior High", "Tertiary", "None"].includes(educationLevel) ? educationLevel : "None";
  const resolvedEntryRun = resolveActiveInstanceForRegistration(entryClass.programme_id, req.body.operationalGroupId, req.body.learningInstanceId);
  if (resolvedEntryRun.ambiguous) {
    return res.status(409).json({
      error: "This programme currently has more than one active run — choose which one to register into.",
      activeRuns: resolvedEntryRun.options.map((o) => ({ id: o.id, name: o.name })),
    });
  }
  const entryLearningInstanceId = resolvedEntryRun.instance ? resolvedEntryRun.instance : null;
  if (!entryLearningInstanceId) {
    return res.status(409).json({ error: "There are currently no available registration opportunities for this programme — an admin has not opened an active registration run yet." });
  }
  if (req.body.operationalGroupId) {
    const group = db.prepare("SELECT id, learning_instance_id, is_active FROM operational_groups WHERE id = ?").get(req.body.operationalGroupId);
    if (!group || group.learning_instance_id !== entryLearningInstanceId.id || !group.is_active) {
      return res.status(400).json({ error: "operationalGroupId is not a valid, active Operational Group for this programme's current Programme Run." });
    }
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, phone, campus, school_name, parent_id, status, payment_status, joined_date, class_id, student_code, own_robotics_kit, education_level, is_adult, sponsor_id, balance_owed_ghs, temp_password_plaintext)
       VALUES (@id, 'learner', @name, @email, @password_hash, @phone, @campus, NULL, @parent_id, @status, @payment_status, date('now'), @class_id, @student_code, @own_robotics_kit, @education_level, 1, @sponsor_id, 0, @temp_password_plaintext)`
    ).run({
      id: learnerId, name, email: normEmail, password_hash: learnerHash, phone: phone || parent.phone || null,
      campus: campus ? String(campus).trim() : "Adult / self-paced", parent_id: parent.id,
      class_id: entryClass.id, student_code: studentCode, own_robotics_kit: ownRoboticsKit ? 1 : 0, education_level: eduLevel,
      sponsor_id: sponsor ? sponsor.id : null,
      // A sponsor being attached is not a payment event — see the comment
      // on PATCH /:userId/sponsor above. The account starts out exactly
      // as pending/unpaid as it would for anyone else; the sponsor (or an
      // admin recording the sponsor's payment) is what moves it forward.
      status: "pending_payment",
      payment_status: "unpaid",
      temp_password_plaintext: learnerPassword,
    });
    // Enrollment Activation pipeline (v30): registration/account-creation
    // only expresses intent — see routes/auth.js's matching comment.
    // classId is required for this branch, so there's always a
    // programme_enrollments row to defer the requested module ids onto
    // (no "no foundation" fallback needed here, unlike routes/auth.js).
    const requestedModuleIdsJSON = Array.isArray(courseIds) && courseIds.length ? JSON.stringify(courseIds) : null;
    // §17/§20.2 — same canonical operational-context resolver every other
    // Enrollment-writing path uses (see utils/sponsorBulkRegistration.js's
    // matching comment); a coordinator adding one adult learner must
    // produce an Enrollment record indistinguishable in shape from any
    // other registration path into the same Batch/Cohort.
    const operationalSnapshot = deriveEnrollmentOperationalSnapshot({
      classRow: entryClass,
      instanceId: entryLearningInstanceId.id,
      courseIds,
      operationalGroupId: req.body.operationalGroupId || null,
    });
    const sponsoredPricingSnapshot = pricingEngine.buildPricingSnapshot({
      learningInstanceId: entryLearningInstanceId.id,
      classId: entryClass.id,
      operationalGroupId: operationalSnapshot.operationalGroupId,
      userId: learnerId,
      legacyAdjustmentContext: { campus: campus ? String(campus).trim() : "Adult / self-paced", school_name: null, own_robotics_kit: ownRoboticsKit },
    });
    const sponsoredFinancialPolicySnapshot = pricingEngine.buildFinancialPolicySnapshot({ learningInstanceId: entryLearningInstanceId.id });
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id, sponsor_id, requested_course_ids, delivery_mode, campus_id, academic_period_id, course_group_id, operational_group_id, pricing_snapshot, financial_policy_snapshot)
       VALUES (?, ?, ?, ?, 1, 'pending_payment', 'unpaid', date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      learnerId,
      entryClass.programme_id,
      entryClass.id,
      entryLearningInstanceId.id,
      sponsor ? sponsor.id : null,
      requestedModuleIdsJSON,
      operationalSnapshot.deliveryMode,
      operationalSnapshot.campusId,
      operationalSnapshot.academicPeriodId,
      operationalSnapshot.courseGroupId,
      operationalSnapshot.operationalGroupId,
      sponsoredPricingSnapshot,
      sponsoredFinancialPolicySnapshot
    );
  });
  tx();

  const { breakdown, totalGHS } = registrationBreakdown([{ name, campus, schoolName: null, ownRoboticsKit, classId: entryClass.id, sponsored: !!sponsor }]);
  res.json({
    ok: true,
    learnerId,
    learnerLoginEmail: normEmail,
    learnerPassword,
    studentCode,
    registrationBreakdown: breakdown,
    registrationTotalGHS: totalGHS,
    message: sponsor
      ? `${name} has been added and linked to sponsor ${sponsor.name}. Their access stays pending until ${sponsor.name}'s payment is made or confirmed by an administrator. Their student ID is ${studentCode}. Sign in with the credentials shown.`
      : `${name} has been added. Their student ID is ${studentCode}. Pay to activate their access, then sign in with the credentials shown.`,
  });
}

// Parent (or admin, on a parent's behalf) adds another child learner to an
// existing parent account. Deliberately reuses the exact same fields/rules
// as /api/auth/register's parent-learner path (age range, module-selection
// requirement for Kids STEM only, Batch/Cohort resolution, primary
// programme_enrollments row, Active Learning Instance tagging) — this is
// that same flow, just for a parent who already has an account. The new
// learner is created with status='pending_payment' exactly like at initial
// registration, so the existing combined-charge payment flow
// (POST /api/payments/:userId/initiate) picks it up automatically the next
// time the parent pays — no separate payment path needed.
router.post("/:parentId/children", requireAuth, requireSelfParentOrStaff("parentId"), (req, res) => {
  const parent = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'parent'").get(req.params.parentId);
  if (!parent) return res.status(404).json({ error: "Parent account not found." });

  // Coordinator caps (see db/migrate.js's "Coordinator accounts" section).
  // Checked before any validation below so a capped-out coordinator gets
  // a clear, specific error rather than getting all the way through the
  // form first.
  if (parent.max_children != null) {
    const currentCount = db.prepare("SELECT COUNT(*) c FROM users WHERE parent_id = ? AND status != 'inactive'").get(parent.id).c;
    if (currentCount >= parent.max_children) {
      return res.status(400).json({ error: `This account is limited to ${parent.max_children} learner(s) — contact an administrator to raise the limit.` });
    }
  }
  let sponsor = null;
  if (parent.sponsor_id) {
    sponsor = db.prepare("SELECT * FROM sponsors WHERE id = ?").get(parent.sponsor_id);
    if (sponsor && !sponsor.is_active) {
      return res.status(400).json({ error: "This account's sponsor has been deactivated — contact an administrator before adding more learners." });
    }
    if (sponsor && sponsor.max_learners != null) {
      const sponsoredCount = db.prepare("SELECT COUNT(*) c FROM users WHERE sponsor_id = ? AND role = 'learner'").get(sponsor.id).c;
      if (sponsoredCount >= sponsor.max_learners) {
        return res.status(400).json({ error: `${sponsor.name} has reached its limit of ${sponsor.max_learners} sponsored learner(s) — contact an administrator.` });
      }
    }
  }

  const learnerType = req.body.learnerType === "adult" ? "adult" : "child";
  // Scope gate (see db/migrate.js's "Coordinator scope" section). An
  // ordinary parent (no sponsor_id) has no coordinator_scope at all and
  // can only ever add a child — 'adult' is unreachable for them no
  // matter what's sent. A coordinator's scope explicitly decides which
  // type(s) they're allowed to register; 'both' lets them pick per
  // learner, which is the whole point of this parameter existing.
  const scope = parent.sponsor_id ? parent.coordinator_scope || "child" : "child";
  if (learnerType === "adult" && !["adult", "both"].includes(scope)) {
    return res.status(400).json({ error: "This account isn't authorized to register adult learners." });
  }
  if (learnerType === "child" && !["child", "both"].includes(scope)) {
    return res.status(400).json({ error: "This account is only authorized to register adult learners, not children." });
  }

  if (learnerType === "adult") {
    return addAdultLearnerUnderCoordinator(req, res, parent, sponsor);
  }

  const { name, age, campus, schoolName, ownRoboticsKit, programmeId, classId, courseIds } = req.body;
  if (!name) return res.status(400).json({ error: "The child's name is required." });
  if (age !== undefined && age !== null && age !== "") {
    const ageNum = Number(age);
    if (!Number.isInteger(ageNum) || ageNum < 3 || ageNum > 21) {
      return res.status(400).json({ error: "Age must be a whole number between 3 and 21." });
    }
  }
  if (programmeId && !db.prepare("SELECT id FROM programmes WHERE id = ?").get(programmeId)) {
    return res.status(400).json({ error: "programmeId does not match a known programme." });
  }

  let entryClass = null;
  if (classId) {
    entryClass = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
    if (!entryClass) return res.status(400).json({ error: "Unknown classId (Batch/Cohort)." });
    if (programmeId && entryClass.programme_id !== programmeId) {
      return res.status(400).json({ error: "That Batch/Cohort doesn't belong to the selected programme." });
    }
    if (!programmeAllowsSelfRegistration(entryClass.programme_id)) {
      return res.status(400).json({ error: "Self-registration isn't open for this programme — contact the admin to add this child." });
    }
    const prog = db.prepare("SELECT * FROM programmes WHERE id = ?").get(entryClass.programme_id);
    if (prog && !programmeAllowsAudience(prog, "parent-learner")) {
      return res.status(400).json({ error: "This programme is only open to adult self-registration." });
    }
    if (prog && !resolveProgrammeRegistrationOpen(prog, req.body.operationalGroupId)) {
      return res.status(409).json({ error: "Registration for this programme is currently closed — contact the admin." });
    }
    // ABRS v2.2 amendment (concurrent Programme Runs) — same disambiguation
    // guard applied to routes/auth.js and routes/enrolments.js; this
    // "Add another child" flow is an equally-real registration path and
    // was missed when those were fixed.
    if (prog) {
      const resolvedRun = resolveActiveInstanceForRegistration(prog.id, req.body.operationalGroupId, req.body.learningInstanceId);
      if (resolvedRun.ambiguous) {
        return res.status(409).json({
          error: "This programme currently has more than one active run — choose which one to register into.",
          activeRuns: resolvedRun.options.map((o) => ({ id: o.id, name: o.name })),
        });
      }
    }
  } else if (programmeId) {
    // Same bypass closed in routes/auth.js's parent-learner path: a bare
    // programmeId must be checked exactly as if its resolved entry class
    // had been sent explicitly as classId, not silently skipped.
    entryClass = resolveEntryClassForChild(programmeId);
    if (entryClass) {
      if (!programmeAllowsSelfRegistration(entryClass.programme_id)) {
        return res.status(400).json({ error: "Self-registration isn't open for this programme — contact the admin to add this child." });
      }
      const prog = db.prepare("SELECT * FROM programmes WHERE id = ?").get(entryClass.programme_id);
      if (prog && !programmeAllowsAudience(prog, "parent-learner")) {
        return res.status(400).json({ error: "This programme is only open to adult self-registration." });
      }
      if (prog && !resolveProgrammeRegistrationOpen(prog, req.body.operationalGroupId)) {
        return res.status(409).json({ error: "Registration for this programme is currently closed — contact the admin." });
      }
      if (prog) {
        const resolvedRun = resolveActiveInstanceForRegistration(prog.id, req.body.operationalGroupId, req.body.learningInstanceId);
        if (resolvedRun.ambiguous) {
          return res.status(409).json({
            error: "This programme currently has more than one active run — choose which one to register into.",
            activeRuns: resolvedRun.options.map((o) => ({ id: o.id, name: o.name })),
          });
        }
      }
    }
  } else {
    const kidsStemProgramme = getDefaultProgrammeForOfferingSlug("kids_stem");
    entryClass = kidsStemProgramme ? resolveEntryClassForChild(kidsStemProgramme.id) : null;
  }
  if (programmeId && !entryClass) {
    return res.status(400).json({ error: "That programme has no Learning Group configured yet — contact the admin." });
  }

  const targetOfferingType = entryClass ? getOfferingTypeForClass(entryClass.id) : null;
  // ABRS v2.1 Phase 1 audit, Category 1: was `!targetOfferingType ||
  // targetOfferingType.slug === "kids_stem"` — the `!targetOfferingType`
  // fallback (no offering type resolved yet) is preserved unchanged; only
  // the literal slug comparison is replaced with the config-driven flag.
  const requiresCourseSelection = !targetOfferingType || offeringTypeRequiresCourseSelectionAtRegistration(targetOfferingType);
  if (requiresCourseSelection) {
    if (!Array.isArray(courseIds) || courseIds.length === 0) {
      return res.status(400).json({ error: "Choose at least one module." });
    }
    // Phase 3 — same active-Learning-Instance rule as routes/auth.js's
    // POST /register and routes/modules.js's GET /open: is_open alone is no
    // longer sufficient, the module must also currently be a target of an
    // ACTIVE Learning Instance (own, or inherited from its parent Programme).
    // Phase 8 — AND, if that instance has an academic structure configured,
    // one of the CURRENT period's configured targets (same rule everywhere
    // else in this task; a run with no structure, or a period with no
    // targets configured yet, is never restricted further by this).
    const openIds = db.prepare("SELECT id FROM courses WHERE is_open = 1").all().map((r) => r.id);
    const invalid = courseIds.filter((m) => {
      if (!openIds.includes(m)) return true;
      const instanceId = getActiveInstanceIdForCourse(m);
      if (!instanceId) return true;
      const instance = getLearningInstanceById(instanceId);
      return !isTargetActiveInCurrentPeriod(instance, { courseId: m });
    });
    if (invalid.length) {
      return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${invalid.join(", ")}.` });
    }
  }

  const learnerId = uuid();
  const learnerPassword = generateChildPassword();
  const learnerHash = bcrypt.hashSync(learnerPassword, 12);
  const studentCode = nextStudentCode();
  const firstName = (String(name).split(" ")[0] || "learner").toLowerCase().replace(/[^a-z0-9]/g, "") || "learner";
  const codeDigits = studentCode.replace(/^DTL-\d\d/, "").replace(/-/g, "");
  const learnerEmail = `${firstName}${codeDigits}@learners.dalijaytechhub.online`;
  const learnerAge = age !== undefined && age !== null && age !== "" ? Number(age) : null;
  let entryLearningInstanceId = null;
  if (entryClass) {
    const resolvedEntryRun = resolveActiveInstanceForRegistration(entryClass.programme_id, req.body.operationalGroupId, req.body.learningInstanceId);
    if (resolvedEntryRun.ambiguous) {
      return res.status(409).json({
        error: "This programme currently has more than one active run — choose which one to register into.",
        activeRuns: resolvedEntryRun.options.map((o) => ({ id: o.id, name: o.name })),
      });
    }
    entryLearningInstanceId = resolvedEntryRun.instance ? resolvedEntryRun.instance.id : null;
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, phone, phone_network, campus, school_name, parent_id, status, payment_status, joined_date, class_id, student_code, own_robotics_kit, age, sponsor_id, balance_owed_ghs, temp_password_plaintext)
       VALUES (@id, 'learner', @name, @email, @password_hash, @phone, @phone_network, @campus, @school_name, @parent_id, @status, @payment_status, date('now'), @class_id, @student_code, @own_robotics_kit, @age, @sponsor_id, 0, @temp_password_plaintext)`
    ).run({
      id: learnerId, name, email: learnerEmail, password_hash: learnerHash, phone: parent.phone, phone_network: parent.phone_network || null,
      campus: campus || null, school_name: schoolName ? String(schoolName).trim() : null, parent_id: parent.id,
      class_id: entryClass ? entryClass.id : null, student_code: studentCode, own_robotics_kit: ownRoboticsKit ? 1 : 0, age: learnerAge,
      // Auto-sponsorship: a coordinator's own sponsor_id (set once, at
      // account creation — see POST /coordinators) flows onto every child
      // they add, so staff never has to manually attach a sponsor per
      // child. A non-coordinator parent has no sponsor_id, so this is a
      // no-op for every ordinary registration — falls through to the
      // exact same pending_payment/unpaid state as before.
      // Auto-sponsorship: a coordinator's own sponsor_id (set once, at
      // account creation — see POST /coordinators) flows onto every child
      // they add, so staff never has to manually attach a sponsor per
      // child. Attaching a sponsor is not a payment event (see the
      // comment on PATCH /:userId/sponsor) — it only records who's
      // responsible for the fee. The account starts out exactly as
      // pending/unpaid as any other new learner's; a non-coordinator
      // parent has no sponsor_id, so this is a no-op there either way.
      sponsor_id: sponsor ? sponsor.id : null,
      status: "pending_payment",
      payment_status: "unpaid",
      temp_password_plaintext: learnerPassword,
    });
    // Enrollment Activation pipeline (v30): registration/account-creation
    // only expresses intent — see routes/auth.js's matching comment. When
    // there's no entryClass to attach a programme_enrollments row to
    // (same rare edge case routes/auth.js handles), fall back to the
    // historical immediate-enrol behaviour rather than silently dropping
    // the selection with no way to ever grant it.
    const requestedModuleIdsJSON = Array.isArray(courseIds) && courseIds.length ? JSON.stringify(courseIds) : null;
    if (entryClass) {
      // §17/§20.2 — same canonical operational-context resolver every
      // other Enrollment-writing path uses (see
      // utils/sponsorBulkRegistration.js's matching comment).
      const operationalSnapshot = deriveEnrollmentOperationalSnapshot({
        classRow: entryClass,
        instanceId: entryLearningInstanceId,
        courseIds,
      });
      const coordChildPricingSnapshot = pricingEngine.buildPricingSnapshot({
        learningInstanceId: entryLearningInstanceId,
        classId: entryClass.id,
        operationalGroupId: operationalSnapshot.operationalGroupId,
        userId: learnerId,
        legacyAdjustmentContext: { campus, school_name: schoolName, own_robotics_kit: ownRoboticsKit },
      });
      const coordChildFinancialPolicySnapshot = pricingEngine.buildFinancialPolicySnapshot({ learningInstanceId: entryLearningInstanceId });
      db.prepare(
        `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id, sponsor_id, requested_course_ids, delivery_mode, campus_id, academic_period_id, course_group_id, operational_group_id, pricing_snapshot, financial_policy_snapshot)
         VALUES (?, ?, ?, ?, 1, 'pending_payment', 'unpaid', date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        learnerId,
        entryClass.programme_id,
        entryClass.id,
        entryLearningInstanceId,
        sponsor ? sponsor.id : null,
        requestedModuleIdsJSON,
        operationalSnapshot.deliveryMode,
        operationalSnapshot.campusId,
        operationalSnapshot.academicPeriodId,
        operationalSnapshot.courseGroupId,
        operationalSnapshot.operationalGroupId,
        coordChildPricingSnapshot,
        coordChildFinancialPolicySnapshot
      );
    } else {
      (courseIds || []).forEach((m) => db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(learnerId, m));
    }
  });
  tx();

  const { breakdown, totalGHS } = registrationBreakdown([{ name, campus, schoolName, ownRoboticsKit, classId: entryClass ? entryClass.id : null, sponsored: !!sponsor }]);
  res.json({
    ok: true,
    learnerId,
    learnerLoginEmail: learnerEmail,
    learnerPassword,
    studentCode,
    registrationBreakdown: breakdown,
    registrationTotalGHS: totalGHS,
    message: sponsor
      ? `${name} has been added and linked to sponsor ${sponsor.name}. Their access stays pending until ${sponsor.name}'s payment is made or confirmed by an administrator. Their student ID is ${studentCode}. Sign in with the credentials shown.`
      : `${name} has been added. Their student ID is ${studentCode}. Pay to activate their access, then sign in with the credentials shown.`,
  });
});

// GET /:parentId/children/credentials — the persistent, authorized view
// Stage 4A asks for: every learner this parent/coordinator account
// created, with login credentials that survive a page refresh (unlike
// the one-shot POST /:parentId/children response above) up until the
// learner's own first login clears temp_password_plaintext (see
// routes/auth.js's /login handler). Once cleared, `password` comes back
// null — the sponsor/coordinator can no longer see it (same as before
// this column existed), and an admin has to reset it via the existing
// reset-credentials flow if it's genuinely needed again.
router.get("/:parentId/children/credentials", requireAuth, requireSelfParentOrStaff("parentId"), (req, res) => {
  const parent = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'parent'").get(req.params.parentId);
  if (!parent) return res.status(404).json({ error: "Parent account not found." });

  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.student_code, u.status, u.payment_status, u.is_adult, u.temp_password_plaintext, u.class_id, u.created_at,
              u.sponsor_id, u.access_override,
              c.name AS class_name, p.name AS programme_name, s.name AS sponsor_name
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
       LEFT JOIN programmes p ON p.id = c.programme_id
       LEFT JOIN sponsors s ON s.id = u.sponsor_id
       WHERE u.parent_id = ? AND u.role = 'learner'
       ORDER BY u.created_at DESC`
    )
    .all(parent.id);

  res.json({
    learners: rows.map((r) => ({
      id: r.id,
      name: r.name,
      username: r.email,
      studentCode: r.student_code,
      status: r.status,
      paymentStatus: r.payment_status,
      isAdult: !!r.is_adult,
      className: r.class_name,
      programmeName: r.programme_name,
      createdAt: r.created_at,
      password: r.temp_password_plaintext || null,
      credentialsAvailable: !!r.temp_password_plaintext,
      // Distinguish how a learner's access is funded — a sponsor
      // responsible for fees (sponsor_id set — this no longer implies
      // payment_status is 'current'; sponsorPaymentSatisfied below tells
      // you whether the sponsor has actually paid) vs a Hub/admin Access
      // Override grant (access_override, set independently via
      // PATCH /:userId/access-override above, and never implied merely by
      // having a sponsor) vs an ordinary self/parent-paid learner. Derived
      // rather than a new stored column since every source fact already
      // exists on the row.
      sponsorName: r.sponsor_name || null,
      accessOverride: !!r.access_override,
      accessType: r.sponsor_id ? "sponsor" : r.access_override ? "admin_free_access" : "self_paid",
      sponsorPaymentSatisfied: r.payment_status === "current" || r.payment_status === "waived",
    })),
  });
});

// Parent (or admin) removes a child from their account. This is
// deliberately a soft removal — a learner already carries grades,
// attendance, payment and certificate history that must not silently
// disappear from the Admin Portal's records — so it unlinks the child from
// this parent (parent_id → NULL) and deactivates their login (status →
// 'inactive') rather than deleting the row. An admin can always look the
// account up directly (e.g. by student code) and re-link/reactivate it if
// a removal was a mistake. Only a learner with NO successful payment on
// record can be removed by the parent themselves — once a payment has gone
// through, removal needs an admin (same "don't lose paid-for history behind
// a self-service click" principle as everywhere else in this codebase).
router.delete("/:parentId/children/:learnerId", requireAuth, requireSelfParentOrStaff("parentId"), (req, res) => {
  const parent = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'parent'").get(req.params.parentId);
  if (!parent) return res.status(404).json({ error: "Parent account not found." });
  const learner = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'learner' AND parent_id = ?").get(req.params.learnerId, parent.id);
  if (!learner) return res.status(404).json({ error: "That child isn't linked to this parent account." });

  if (req.user.role === "parent") {
    const hasPaid = db.prepare("SELECT 1 FROM payments WHERE user_id = ? AND status = 'successful' LIMIT 1").get(learner.id);
    if (hasPaid) {
      return res.status(403).json({ error: "This child has an existing payment on record — contact the admin to remove them." });
    }
  }

  db.prepare("UPDATE users SET parent_id = NULL, status = 'inactive' WHERE id = ?").run(learner.id);
  res.json({ ok: true });
});

// Additive, read-only exports (no behavioural change to this router) so
// utils/sponsorBulkRegistration.js can reuse the exact same entry-class
// resolution and learner-password generation this file already uses for
// individual coordinator registration — per §2.1 (Single Ownership),
// neither of these may be reimplemented a second time for the bulk path.
module.exports = router;
module.exports.resolveEntryClassForChild = resolveEntryClassForChild;
module.exports.generateChildPassword = generateChildPassword;
