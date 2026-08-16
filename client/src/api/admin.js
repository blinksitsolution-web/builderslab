/* ==========================================================================
   Admin dashboard API methods (Phase 8). Reporting (§21) reads only from
   this document's constitutional owners — GET /api/learning-instances/
   dashboard-stats aggregates server-side, scoped, from Programme Run/
   Enrollment/Payments. The legacy adminOverview() renderer's client-side
   fetchAllUsers()/fetchAllPayments() shadow aggregation (unscoped
   all-time headcounts/revenue, bypassing campus/Corporate-Client scoping)
   has been removed as a §2.1/§21 Single Ownership violation — dashboard-
   stats was already computing the equivalent, correctly-scoped figures.

   Backend boundaries, unchanged and not re-derived here:
     - GET /api/learning-instances/dashboard-stats: gated by
       requirePermission("dashboard.view") — genuinely permission-driven,
       not every admin necessarily has it (depends on their role
       template). A 403 here means "this admin's role template doesn't
       grant this," not "no data" — callers must treat it as a distinct,
       expected state (see useAdminDashboard.js).
   ========================================================================== */
import { apiGet, apiPatch, apiPost, apiPut, apiDelete } from "./client";

// GET /api/learning-instances/dashboard-stats?offeringTypeId=&programmeId=&
//   learningInstanceId=&learningInstanceScope= — same "Learning Instance
// scope" filter trio as fetchAccounts()/fetchLearningInstances() below
// (see server/src/routes/learningInstances.js's dashboard-stats comment).
// The caller is responsible for sending learningInstanceScope=active
// explicitly for the default "Active runs only" state; this function
// itself has no default and just forwards whatever filters it's given.
export async function fetchDashboardStats(filters = {}) {
  const params = {};
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params[key] = value;
  });
  const qs = new URLSearchParams(params).toString();
  return apiGet(`/api/learning-instances/dashboard-stats${qs ? `?${qs}` : ""}`);
}

/* ==========================================================================
   Account Management (Phase 17). Migrates legacy adminAccounts() /
   renderAcctTable() (dashboard.html) — same GET /api/users query-param
   contract (role/campus/search/offeringTypeId/programmeId/
   learningInstanceId/learningInstanceScope, see Phase 1 analysis and
   server/src/routes/users.js), same row actions (suspend/reactivate,
   delete admin, promote, class/module/instructor-assignment edits).

   Deliberately NOT included here (see Phase 17 scope notes in
   AccountManagementPage.jsx):
     - staff/participant account creation — migrated in Phase 20, see
       createStaffAccount() below and CreateAccountModal.jsx.
     - the access-override (payment-restriction bypass) mutation —
       Payments & Access Restrictions, reserved for Phase 18. Restriction
       state is still *displayed*, read-only, from fields GET /api/users
       already returns (accessRestricted/accessRestrictedReason).
   ========================================================================== */

// GET /api/users?role=&campus=&search=&offeringTypeId=&programmeId=&
//   learningInstanceId=&learningInstanceScope= — every param optional and
// dropped from the query string when empty, matching DTL.allUsers(filters)
// exactly (see api.js).
export async function fetchAccounts(filters = {}) {
  const params = {};
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params[key] = value;
  });
  const qs = new URLSearchParams(params).toString();
  const { users } = await apiGet(`/api/users${qs ? `?${qs}` : ""}`);
  return users;
}

// GET /api/users?role=instructor&search=&programmeId=&offeringTypeId= —
// reuses the existing GET /api/users listing/search endpoint (no new
// endpoint needed) with the additive eligibility filter added for the
// Programme Run admin UI's instructor selector (see
// server/src/routes/users.js). Only instructors already assigned
// (instructor_classes/instructor_modules) to the given Programme, or to
// any Programme of the given Offering Type, come back.
export async function fetchEligibleInstructors({ search, programmeId, offeringTypeId } = {}) {
  return fetchAccounts({ role: "instructor", search, programmeId, offeringTypeId });
}

export async function fetchCampuses() {
  const { campuses } = await apiGet("/api/modules/campuses/list");
  return campuses;
}

export async function fetchOfferingTypes() {
  const { offeringTypes } = await apiGet("/api/learning-offerings/types?all=true");
  return offeringTypes;
}

export async function fetchProgrammes() {
  const { programmes } = await apiGet("/api/learning-offerings/programmes?all=true");
  return programmes;
}

// ABRS v2.1 Phase 4 (Category 3 audit fix) — a Programme's own configured
// Participation Structures (Section 10.2), replacing
// AccountDetailDrawer.jsx's hardcoded three-option list/label lookup.
// Returns [] for a Programme with none configured — callers should treat
// that as "not applicable," not as an error.
export async function fetchProgrammeParticipationStructures(programmeId) {
  const { participationStructures } = await apiGet(`/api/learning-offerings/programmes/${encodeURIComponent(programmeId)}/participation-structures`);
  return participationStructures;
}

// Admin Workflow Redesign checkpoint, Part 2 — the authenticated management
// surface for Participation Structure definitions (every status, full
// detail), separate from fetchProgrammeParticipationStructures() above
// (active-only, no auth) which every registration/enrolment/account-editing
// consumer already depends on and which stays untouched.
export async function fetchProgrammeParticipationStructuresForAdmin(programmeId) {
  const { participationStructures } = await apiGet(
    `/api/learning-offerings/programmes/${encodeURIComponent(programmeId)}/participation-structures/manage`
  );
  return participationStructures;
}

export async function createParticipationStructure(programmeId, payload) {
  return apiPost(`/api/learning-offerings/programmes/${encodeURIComponent(programmeId)}/participation-structures`, payload);
}

export async function updateParticipationStructure(id, payload) {
  return apiPatch(`/api/learning-offerings/participation-structures/${encodeURIComponent(id)}`, payload);
}

export async function activateParticipationStructure(id) {
  return apiPost(`/api/learning-offerings/participation-structures/${encodeURIComponent(id)}/activate`);
}

export async function deactivateParticipationStructure(id) {
  return apiPost(`/api/learning-offerings/participation-structures/${encodeURIComponent(id)}/deactivate`);
}

// Terminal — see migrate.js v37 for why this is distinct from deactivate.
export async function retireParticipationStructure(id) {
  return apiPost(`/api/learning-offerings/participation-structures/${encodeURIComponent(id)}/retire`);
}

// Permission-gated for admins (requirePermission("learningInstances.view"))
// unlike everything else in this file — an admin whose role template
// doesn't include it gets a real 403 here, not empty data. Callers must
// treat that as its own state (see useAccountManagement.js), same
// "forbidden ≠ empty" distinction useAdminDashboard.js already established
// for the dashboard-stats endpoint.
//
// `filters` may include offeringTypeId, programmeId, courseId, status —
// same GET /api/learning-instances query contract as legacy's
// DTL.learningInstances(filters) (see api.js). All optional and dropped
// from the query string when empty, same pattern as fetchAccounts() above.
export async function fetchLearningInstances(filters = {}) {
  const params = {};
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params[key] = value;
  });
  const qs = new URLSearchParams(params).toString();
  const { learningInstances } = await apiGet(`/api/learning-instances${qs ? `?${qs}` : ""}`);
  return learningInstances;
}

export async function fetchClasses() {
  const { classes } = await apiGet("/api/classes");
  return classes;
}

// GET /api/learning-offerings/programmes?offeringTypeId=... — used by the
// Add Participant modal's Offering Type -> Programme cascade, matching
// legacy DTL.programmes(false, { offeringTypeId }) exactly (only active
// programmes, scoped to one Offering Type).
export async function fetchProgrammesForOfferingType(offeringTypeId) {
  const { programmes } = await apiGet(`/api/learning-offerings/programmes?offeringTypeId=${encodeURIComponent(offeringTypeId)}`);
  return programmes;
}

// GET /api/classes?programmeId=... — used by the Add Participant modal's
// Programme -> Batch/Cohort cascade, matching legacy DTL.classes(programmeId)
// exactly.
export async function fetchClassesForProgramme(programmeId) {
  const { classes } = await apiGet(`/api/classes?programmeId=${encodeURIComponent(programmeId)}`);
  return classes;
}

export async function fetchModules() {
  const { courses } = await apiGet("/api/modules");
  return courses;
}

/* ==========================================================================
   Admin Certificates & Transcripts (Phase 26). Migrates legacy
   adminCertificates()/generateOneCertificate()/generateBulkCertificates()
   and adminTranscripts()/renderAdminTranscript()/generateBulkTranscripts()
   (dashboard.html) — same endpoints/contracts as api.js's DTL.transcript,
   DTL.certificateTemplates, DTL.issueCertificate.
   ========================================================================== */

// GET /api/certificate-templates?type=&activeOnly= — same params as
// DTL.certificateTemplates(params).
export async function fetchCertificateTemplates(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const { templates } = await apiGet(`/api/certificate-templates${qs ? `?${qs}` : ""}`);
  return templates;
}

// POST /api/certificates/issue — { templateId, courseId, learnerIds } (or
// campusName/campusNames — not used by this admin UI, which always
// resolves an explicit learnerIds list first, same as legacy). classId
// targeting was removed server-side (§22/§11.4 remediation) — Operational
// Group must never gate certificate eligibility.
export async function issueCertificate(payload) {
  return apiPost("/api/certificates/issue", payload);
}

// GET /api/grades/:userId/transcript — requireSelfParentOrStaff and
// requireActiveAccess both bypass for role:"admin" (see
// server/src/middleware/auth.js) — same endpoint fetchTranscript() in
// api/parent.js wraps for the parent portal.
//
// Phase 10 — `termId` stays a plain second argument for back-compat with
// every existing caller; pass an options object as the third argument to
// additionally request a period-scoped transcript ({ learningInstanceId,
// academicPeriodId }, both required together by the backend).
export async function fetchAdminTranscript(userId, termId, { learningInstanceId, academicPeriodId } = {}) {
  const params = {};
  if (termId) params.termId = termId;
  if (learningInstanceId) params.learningInstanceId = learningInstanceId;
  if (academicPeriodId) params.academicPeriodId = academicPeriodId;
  const qs = new URLSearchParams(params).toString();
  return apiGet(`/api/grades/${userId}/transcript${qs ? `?${qs}` : ""}`);
}

/* ==========================================================================
   Account creation (Phase 20). Migrates legacy createStaff() (dashboard.html)
   — same POST /api/users/staff endpoint, request body, and validation
   contract (see server/src/routes/users.js's "/staff" route):
     - { name, email, password, role, phone, classIds?, courseIds?,
         roleTemplateId?, customPermissions?, campus?, corporateClientId? }
     - role must be "instructor" or "admin"; creating an "admin" account is
       itself Super Administrator-only server-side (a plain admin gets a
       403 from the backend even if this were called with role:"admin" —
       not re-derived client-side, matching every other RBAC boundary in
       this app).
     - classIds/courseIds are only meaningful for role:"instructor".
     - roleTemplateId (Option 1) or customPermissions[] (Option 2) is
       required for role:"admin" — never both, matching
       ManageAccessModal's own mode split for reassigning an existing
       administrator's access.
   ========================================================================== */
export async function createStaffAccount(payload) {
  return apiPost("/api/users/staff", payload);
}

// Admin-only; a 403 is possible when the target is itself an admin account
// and the caller isn't a Super Administrator (server/src/routes/users.js).
export async function setAccountStatus(userId, status) {
  return apiPatch(`/api/users/${userId}/status`, { status });
}

// Super Administrator only — permanently removes an administrator account.
export async function deleteAdminAccount(userId) {
  return apiDelete(`/api/users/${userId}`);
}

export async function promoteLearners(userIds, toClassId) {
  const payload = { userIds };
  if (toClassId) payload.toClassId = toClassId;
  return apiPost("/api/users/promote", payload);
}

export async function setLearnerClass(userId, classId) {
  return apiPatch(`/api/users/${userId}/class`, { classId });
}

export async function setLearnerModules(userId, courseIds) {
  return apiPatch(`/api/users/${userId}/courses`, { courseIds });
}

// PATCH /api/users/:userId/assignments — replaces this instructor's full
// Instructor Assignment set (ABRS v2.2 §8.2). `assignments` is an array
// of { learningInstanceId, courseId?, classId?, campusId? } — an entry
// with a field omitted means "every value of that dimension within this
// Run" (see server/src/utils/instructorScope.js).
export async function updateInstructorAssignments(userId, assignments) {
  return apiPatch(`/api/users/${userId}/assignments`, { assignments });
}

// GET /api/users/:userId/assignments — this instructor's current
// assignment rows, each already enriched with display names, for the
// cascading Learning Instance -> Course/Programme Level/Campus editor.
export async function fetchInstructorAssignments(userId) {
  const { assignments } = await apiGet(`/api/users/${userId}/assignments`);
  return assignments;
}

// GET /api/users/learning-instances/:id/assignment-options — the
// Course(s)/Programme Level(s)/Campus(es) available for Instructor
// Assignment within one specific Active Learning Instance, used to
// cascade the assignment editor's later dropdowns off the first
// (Learning Instance) selection.
export async function fetchInstructorAssignmentOptions(learningInstanceId) {
  return apiGet(`/api/users/learning-instances/${learningInstanceId}/assignment-options`);
}

/* ==========================================================================
   Participants / Adult Learners (final admin migration pass). Migrates
   legacy adminAdultLearners()/openParticipantModal()/createParticipant()/
   editLearnerCampus()/viewAdultInstructors() (dashboard.html) — same
   GET /api/users?role=learner&isAdult=1, POST /api/users/participants,
   PATCH /api/users/:userId/campus, GET /api/users/instructors-for/:id
   contracts as legacy (see server/src/routes/users.js). Class and module
   edits reuse setLearnerClass()/setLearnerModules() above (same endpoints
   Manage Accounts already uses).
   ========================================================================== */

// GET /api/users/:userId — single full user record (modules, progress,
// className, etc.), matching legacy DTL.getUser(id) exactly. Used to
// prefill the Campus modal with the learner's current campus.
export async function fetchUser(userId) {
  const { user } = await apiGet(`/api/users/${userId}`);
  return user;
}

export async function setLearnerCampus(userId, campus) {
  return apiPatch(`/api/users/${userId}/campus`, { campus });
}

// GET /api/users/instructors-for/:learnerId — every instructor currently
// teaching one of this learner's enrolled modules, matching legacy
// DTL.instructorsForLearner() exactly.
export async function fetchInstructorsForLearner(learnerId) {
  const { instructors } = await apiGet(`/api/users/instructors-for/${learnerId}`);
  return instructors;
}

// POST /api/users/participants — creates a learner account directly under
// a non-Kids-STEM offering (Adult Professional / Corporate Training /
// Bootcamp), no parent account required, matching legacy
// DTL.createParticipant() exactly. Returns { user, temporaryPassword }.
export async function createParticipant(payload) {
  return apiPost("/api/users/participants", payload);
}

/* ==========================================================================
   Bulk Promotion (final admin migration pass). Migrates legacy
   adminBulkPromotion()/previewBulkPromotion()/confirmBulkPromotion()/
   viewPromotionLog() (dashboard.html). "Promote to next class" reuses
   promoteLearners() above (POST /api/users/promote, same endpoint Manage
   Accounts' single-row Promote action uses) — repeat/transfer/graduate use
   the richer Promotion Engine (server/src/routes/promotion.js), same as
   legacy.
   ========================================================================== */

// GET /api/promotion/log/:learnerId — a learner's full promote/repeat/
// transfer/graduate history, matching legacy DTL.promotionLog() exactly.
export async function fetchPromotionLog(learnerId) {
  const { history } = await apiGet(`/api/promotion/log/${learnerId}`);
  return history;
}

export async function repeatLearners(payload) {
  return apiPost("/api/promotion/repeat", payload);
}

export async function transferClass(payload) {
  return apiPost("/api/promotion/transfer-class", payload);
}

export async function transferCampus(payload) {
  return apiPost("/api/promotion/transfer-campus", payload);
}

export async function graduateLearners(payload) {
  return apiPost("/api/promotion/graduate", payload);
}

/* ==========================================================================
   Promotion Subsystem — constitutional core (ABRS v2.1 §12). Distinct from
   the legacy bulk actions above: these are policy-driven, eligibility-
   evaluated, and change Programme Level only (never campus, Academic Year,
   or enrollment/financial status). See server/src/routes/promotion.js and
   server/src/utils/promotionEngine.js.
   ========================================================================== */

export async function fetchPromotionPolicy(programmeId) {
  const { policy } = await apiGet(`/api/promotion/policy/${programmeId}`);
  return policy;
}

export async function savePromotionPolicy(programmeId, payload) {
  const { policy } = await apiPut(`/api/promotion/policy/${programmeId}`, payload);
  return policy;
}

export async function submitPromotionRecommendation(payload) {
  return apiPost("/api/promotion/recommend", payload);
}

export async function fetchLearnerEligibility(learnerId) {
  return apiGet(`/api/promotion/eligibility/${learnerId}`);
}

export async function fetchClassEligibility(classId) {
  const { results } = await apiGet(`/api/promotion/eligibility?classId=${encodeURIComponent(classId)}`);
  return results;
}

export async function applyManualPromotion(payload) {
  return apiPost("/api/promotion/manual", payload);
}

export async function applyAutoPromotion(classId) {
  return apiPost("/api/promotion/auto-promote", { classId });
}

export async function reversePromotionLog(logId) {
  return apiPost("/api/promotion/reverse", { logId });
}

/* ==========================================================================
   Learner Progress (final admin migration pass). Migrates legacy
   adminLearnerProgress() (dashboard.html). No dedicated report endpoint
   exists for this — legacy assembles it client-side from GET /api/users,
   GET /api/users/:id (modules + progress), and GET /api/modules/:id/lessons
   per module; this reproduces that exact data flow rather than inventing a
   new backend endpoint.
   ========================================================================== */

// GET /api/modules/:courseId/lessons — matching legacy DTL.lessonsFor()
// exactly. Used per-module to compute a learner's completion percentage.
export async function fetchLessonsForModule(courseId) {
  const { lessons } = await apiGet(`/api/modules/${courseId}/lessons`);
  return lessons;
}

/* ==========================================================================
   Instructor Progress (final admin migration pass). Migrates legacy
   adminInstructorProgress() (dashboard.html) — same
   GET /api/topics/admin/progress-summary contract (see
   server/src/routes/topics.js), which already assembles instructor/module
   topic-completion rows server-side; no new backend endpoint needed.
   ========================================================================== */

export async function fetchInstructorTopicProgress() {
  const { progress } = await apiGet("/api/topics/admin/progress-summary");
  return progress;
}

/* ==========================================================================
   Broadcast Messages (final admin migration pass). Migrates legacy
   adminBroadcast()/sendBroadcast() and the Defaulters panel's
   messageOwingParents() (dashboard.html) — same
   POST /api/messages/broadcast and GET /api/payments/owing-parents +
   POST /api/messages contracts (see server/src/routes/messages.js,
   payments.js). No new messaging infrastructure introduced.
   ========================================================================== */

// POST /api/messages/broadcast — admin-only, sends the same message to
// every parent in one call. Matching legacy DTL.broadcast() exactly.
export async function broadcastToParents({ subject, body }) {
  return apiPost("/api/messages/broadcast", { subject, body });
}

// GET /api/payments/owing-parents — every parent with at least one learner
// in arrears, matching legacy DTL.owingParents() exactly. Used by the
// Defaulters page's "Message parents who owe" panel.
export async function fetchOwingParents() {
  const { parents } = await apiGet("/api/payments/owing-parents");
  return parents;
}

// POST /api/messages — direct message to one recipient, matching legacy
// DTL.sendMessage() exactly. The Defaulters page fans this out to every
// owing parent, one call per recipient, same as legacy's
// Promise.all(parents.map(...)).
export async function sendMessage({ to, subject, body }) {
  return apiPost("/api/messages", { to, subject, body });
}

/* ==========================================================================
   Payments & Access Restrictions (Phase 18). Migrates legacy adminPayments()
   / adminDefaulters() (dashboard.html) — same GET /api/payments,
   GET /api/payments/overview, GET /api/payments/defaulters,
   GET /api/payments/:userId/summary, PATCH /api/payments/:userId/status
   contracts (see Phase 1 analysis and server/src/routes/payments.js), plus
   the Access Override action (PATCH /api/users/:userId/access-override,
   server/src/routes/users.js) that legacy dashboard.html never exposed but
   the current backend already implements in full (see
   server/src/utils/accessControl.js) — restriction state itself was already
   surfaced read-only in Phase 17's AccountDetailDrawer via
   accessRestricted/accessRestrictedReason.

   Deliberately NOT included here (see Phase 18 scope notes in
   PaymentsPage.jsx):
     - "Message parents who owe" (legacy Defaulters panel's broadcast
       action) — a messaging/broadcast workflow, not a payments/access
       action; left for whichever phase migrates Broadcast Messages.
   ========================================================================== */

// GET /api/payments?learnerId=&classId=&campus=&month=&type=&offeringTypeId=&
//   programmeId=&learningInstanceId=&learningInstanceScope= — every param
// optional, matching DTL.allPayments(filters) exactly (see api.js).
export async function fetchPaymentsLedger(filters = {}) {
  const params = {};
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params[key] = value;
  });
  const qs = new URLSearchParams(params).toString();
  const { payments } = await apiGet(`/api/payments${qs ? `?${qs}` : ""}`);
  return payments;
}

// GET /api/payments/overview?classId=&campus=&offeringTypeId=&programmeId=&
//   learningInstanceId=&learningInstanceScope= — one row per learner with
// amount paid/owed and last-payment info, matching DTL.paymentsOverview
// exactly (see api.js).
export async function fetchPaymentsOverview(filters = {}) {
  const params = {};
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params[key] = value;
  });
  const qs = new URLSearchParams(params).toString();
  const { learners } = await apiGet(`/api/payments/overview${qs ? `?${qs}` : ""}`);
  return learners;
}

// GET /api/payments/defaulters — every learner not current on fees, plus
// the estimated arrears total, matching DTL.defaulters() exactly.
export async function fetchDefaulters() {
  return apiGet("/api/payments/defaulters");
}

// GET /api/payments/:userId/summary — running total paid, current balance,
// and full payment history for one learner, matching DTL.paymentSummary()
// exactly. Used to prefill the "Update payment status" modal.
export async function fetchPaymentSummary(userId) {
  return apiGet(`/api/payments/${userId}/summary`);
}

// GET /api/payments/:userId/period-status — Phase 10. Same endpoint
// api/parent.js's fetchPeriodPaymentStatus wraps for the learner/parent
// Payments UI; requireSelfParentOrStaff already bypasses for role:"admin",
// so this works unmodified for any learner id.
export async function fetchPeriodPaymentStatus(userId) {
  const { periodPayments } = await apiGet(`/api/payments/${userId}/period-status`);
  return periodPayments;
}

// PATCH /api/payments/:userId/status — the same manual accounting update
// legacy savePaymentStatus() performs, matching DTL.setPaymentStatus()
// exactly (status/type/amountPaid/balanceOwed/method/paymentMonth).
export async function setPaymentStatus(userId, payload) {
  return apiPatch(`/api/payments/${userId}/status`, payload);
}

// GET /api/users/lookup/:studentCode — matching DTL.lookupByStudentCode(),
// used by the "Look up by student ID" panel legacy adminPayments() offers
// for confirming a Mobile Money payment before updating status.
export async function lookupByStudentCode(code) {
  return apiGet(`/api/users/lookup/${encodeURIComponent(code)}`);
}

// PATCH /api/users/:userId/access-override — grant or revoke the backend's
// Access Override (server/src/utils/accessControl.js): bypasses a
// payment/pending-payment restriction only, never a 'suspended' status.
// Only ever valid for learner/parent accounts — enforced server-side, not
// re-derived here. { override: boolean, reason?: string, expiresAt?: string|null }
export async function setAccessOverride(userId, payload) {
  return apiPatch(`/api/users/${userId}/access-override`, payload);
}

/* ==========================================================================
   Site Settings / System Configuration (Phase 27). Migrates legacy
   adminSettings() and its tab renderers (dashboard.html) — same endpoints/
   contracts as api.js's DTL methods of the same name. Covers every tab in
   legacy's #settings workflow: Fees & Payment Accounts, Branding, Campuses,
   Modules & Seasons, Academic Calendar, Certificate Settings, Campus
   Branding, and (Super Administrator-only) API Keys.

   NOT included — Landing Page CMS (hero/contact/about/home/footer/enrol
   button/how-it-works/faqs/gallery/partners/success stories/blog) is a
   separate legacy tab bar (#cms) driven by a different renderer map, not
   part of adminSettings() at all — reserved for Phase 28 per scope.

   Also NOT included — an "assessment weights" endpoint already exists on
   the backend (GET/PATCH /api/settings/assessment-weights) but is not
   called anywhere in legacy dashboard.html — adminSettings() has no tab
   for it. Left unmigrated: this phase covers the existing legacy
   workflow, not every backend endpoint that happens to exist.

   Fee amounts, branding (logo/signature paths), and payment accounts are
   read via api/public.js's fetchPublicSettings() (GET /api/settings/public)
   — the same unauthenticated endpoint legacy's settingsFees()/
   settingsBranding() call — rather than duplicated here.
   ========================================================================== */

// ---- Fees & Payment Accounts ---------------------------------------------
// PATCH /api/settings/fees — requirePermission("siteSettings.edit").
export async function updateFees(payload) {
  return apiPatch("/api/settings/fees", payload);
}

export async function addPaymentAccount(payload) {
  return apiPost("/api/settings/payment-accounts", payload);
}

export async function deletePaymentAccount(id) {
  return apiDelete(`/api/settings/payment-accounts/${id}`);
}

// ---- Branding --------------------------------------------------------------
export async function uploadLogo(file) {
  const fd = new FormData();
  fd.append("logo", file);
  return apiPost("/api/settings/branding/logo", fd, { isForm: true });
}

export async function uploadSignature(file) {
  const fd = new FormData();
  fd.append("signature", file);
  return apiPost("/api/settings/branding/signature", fd, { isForm: true });
}

// Only the admin-signature display name — the image itself goes through
// uploadSignature() above. Matches legacy saveSignature()'s separate PATCH.
export async function updateBranding(payload) {
  return apiPatch("/api/settings/branding", payload);
}

// ---- Campuses ----------------------------------------------------------
// fetchCampuses() above (GET /api/modules/campuses/list) already covers the
// list read for this tab too — reused, not duplicated.

// POST /api/modules/campuses — multipart when an image is included (same
// upload field name, "image"), JSON otherwise, matching DTL.addCampus().
export async function createCampus({ name, isPartner, location, partnerSchoolName, contactPhone, contactEmail, contactAddress, image } = {}) {
  if (image) {
    const fd = new FormData();
    fd.append("name", name);
    fd.append("isPartner", isPartner ? "true" : "false");
    if (location) fd.append("location", location);
    if (partnerSchoolName) fd.append("partnerSchoolName", partnerSchoolName);
    if (contactPhone) fd.append("contactPhone", contactPhone);
    if (contactEmail) fd.append("contactEmail", contactEmail);
    if (contactAddress) fd.append("contactAddress", contactAddress);
    fd.append("image", image);
    return apiPost("/api/modules/campuses", fd, { isForm: true });
  }
  return apiPost("/api/modules/campuses", { name, isPartner: !!isPartner, location, partnerSchoolName, contactPhone, contactEmail, contactAddress });
}

// PATCH /api/modules/campuses/:id — same shape as createCampus, used both
// for the quick "partner school" toggle (single field) and the full
// profile editor modal.
export async function updateCampus(id, { isPartner, location, partnerSchoolName, contactPhone, contactEmail, contactAddress, image } = {}) {
  if (image) {
    const fd = new FormData();
    if (isPartner !== undefined) fd.append("isPartner", isPartner ? "true" : "false");
    if (location !== undefined) fd.append("location", location);
    if (partnerSchoolName !== undefined) fd.append("partnerSchoolName", partnerSchoolName);
    if (contactPhone !== undefined) fd.append("contactPhone", contactPhone);
    if (contactEmail !== undefined) fd.append("contactEmail", contactEmail);
    if (contactAddress !== undefined) fd.append("contactAddress", contactAddress);
    fd.append("image", image);
    return apiPatch(`/api/modules/campuses/${id}`, fd, { isForm: true });
  }
  return apiPatch(`/api/modules/campuses/${id}`, { isPartner, location, partnerSchoolName, contactPhone, contactEmail, contactAddress });
}

export async function setCampusOfferings(id, offeringTypeIds) {
  return apiPut(`/api/modules/campuses/${id}/offerings`, { offeringTypeIds });
}

export async function deleteCampus(id) {
  return apiDelete(`/api/modules/campuses/${id}`);
}

// ---- Modules & Seasons -----------------------------------------------------
// fetchModules() above (GET /api/modules) already covers the list read.
export async function createModule(payload) {
  return apiPost("/api/modules", payload);
}

export async function updateModule(courseId, payload) {
  return apiPatch(`/api/modules/${courseId}`, payload);
}

// Backend rejects with 409 (course in use) — surfaced to the caller as an
// ApiError, same as legacy's try/catch around DTL.deleteModule().
export async function deleteModule(courseId) {
  return apiDelete(`/api/modules/${courseId}`);
}

// ---- Course Groups (an optional cross-level grouping/tag over Modules —
// NOT part of the required academic hierarchy; formerly called "Courses"
// before that name was freed up for the primary curriculum unit itself) --
export async function fetchCourseGroups(programmeId) {
  const qs = programmeId ? `?programmeId=${encodeURIComponent(programmeId)}` : "";
  const { courseGroups } = await apiGet(`/api/course-groups${qs}`);
  return courseGroups;
}

export async function fetchCourseGroup(courseGroupId) {
  return apiGet(`/api/course-groups/${courseGroupId}`);
}

export async function createCourseGroup(payload) {
  return apiPost("/api/course-groups", payload);
}

export async function updateCourseGroup(courseGroupId, payload) {
  return apiPatch(`/api/course-groups/${courseGroupId}`, payload);
}

// Backend rejects with 409 while any module still belongs to this course group.
export async function deleteCourseGroup(courseGroupId) {
  return apiDelete(`/api/course-groups/${courseGroupId}`);
}

// Replace the ordered Module set a Course Group presents at a given
// Class/level (e.g. Foundation vs Framework vs Skyline) — every courseId
// must already belong to this course group.
export async function setCourseGroupClassModules(courseGroupId, classId, courseIds) {
  return apiPut(`/api/course-groups/${courseGroupId}/classes/${classId}/courses`, { courseIds });
}

// ---- Academic Calendar ------------------------------------------------
export async function fetchAcademicYears() {
  return apiGet("/api/academic-calendar/years");
}

export async function createAcademicYear(payload) {
  return apiPost("/api/academic-calendar/years", payload);
}

export async function activateAcademicYear(id) {
  return apiPost(`/api/academic-calendar/years/${id}/activate`);
}

export async function fetchAcademicTerms(yearId) {
  return apiGet(`/api/academic-calendar/terms${yearId ? `?yearId=${yearId}` : ""}`);
}

export async function createAcademicTerm(payload) {
  return apiPost("/api/academic-calendar/terms", payload);
}

export async function activateAcademicTerm(id) {
  return apiPost(`/api/academic-calendar/terms/${id}/activate`);
}

export async function fetchCalendarPeriods({ termId, type } = {}) {
  const params = {};
  if (termId) params.termId = termId;
  if (type) params.type = type;
  const qs = new URLSearchParams(params).toString();
  const { periods } = await apiGet(`/api/academic-calendar/periods${qs ? `?${qs}` : ""}`);
  return periods;
}

export async function createCalendarPeriod(payload) {
  return apiPost("/api/academic-calendar/periods", payload);
}

export async function deleteCalendarPeriod(id) {
  return apiDelete(`/api/academic-calendar/periods/${id}`);
}

// ---- Certificate Settings (org settings, signatures, templates) -----------
// fetchCertificateTemplates(params) above (GET /api/certificate-templates)
// already covers the template-list read for this tab too.
export async function fetchCertificateOrgSettings() {
  return apiGet("/api/certificate-templates/org-settings");
}

export async function updateCertificateOrgSettings(payload) {
  return apiPatch("/api/certificate-templates/org-settings", payload);
}

export async function uploadCertificateSignature(slot, file) {
  const fd = new FormData();
  fd.append("signature", file);
  return apiPost(`/api/certificate-templates/org-settings/signature/${slot}`, fd, { isForm: true });
}

export async function createCertificateTemplate(payload) {
  return apiPost("/api/certificate-templates", payload);
}

export async function updateCertificateTemplate(id, payload) {
  return apiPatch(`/api/certificate-templates/${id}`, payload);
}

export async function duplicateCertificateTemplate(id) {
  return apiPost(`/api/certificate-templates/${id}/duplicate`);
}

export async function setCertificateTemplateActive(id, active) {
  return apiPost(`/api/certificate-templates/${id}/${active ? "activate" : "deactivate"}`);
}

// ---- Campus Branding (per-campus cert branding profile) -------------------
export async function fetchCampusBrandingProfiles() {
  const { profiles } = await apiGet("/api/campus-branding");
  return profiles;
}

export async function createCampusBranding(payload) {
  return apiPost("/api/campus-branding", payload);
}

export async function updateCampusBranding(campusName, payload) {
  return apiPatch(`/api/campus-branding/${encodeURIComponent(campusName)}`, payload);
}

// slot is one of: institution-logo | partner-logo | signature | background
export async function uploadCampusBrandingImage(campusName, slot, file) {
  const fd = new FormData();
  fd.append("image", file);
  return apiPost(`/api/campus-branding/${encodeURIComponent(campusName)}/${slot}`, fd, { isForm: true });
}

// ---- API Keys (Super Administrator only, backend-enforced via
// requireSuperAdmin regardless of what the UI shows) ------------------------
export async function fetchApiKeys() {
  const { apiKeys } = await apiGet("/api/settings/api-keys");
  return apiKeys;
}

export async function updateApiKeys(payload) {
  return apiPatch("/api/settings/api-keys", payload);
}

export async function testAiConnection(provider) {
  return apiPost("/api/settings/api-keys/test-connection", { provider });
}

/* ==========================================================================
   Landing Page CMS (Phase 28). Migrates legacy adminCms()/switchCmsTab()
   (dashboard.html) — same /api/settings/... endpoints and request/response
   contracts as the settings.js routes already used above; nothing about
   how this content is stored or served changes. Every endpoint here is
   requireAuth + requirePermission("siteSettings.edit") on the backend
   (list reads also accept "siteSettings.view"), same as the rest of
   settings.js — not re-derived here, just called.
   ========================================================================== */

// ---- Hero & Contact (reuses fetchPublicSettings() for the read) -----------
export async function updateHero(payload) {
  return apiPatch("/api/settings/hero", payload);
}

export async function updateContact(payload) {
  return apiPatch("/api/settings/contact", payload);
}

// ---- About Us ---------------------------------------------------------
export async function updateAbout({ eyebrow, title, body, image } = {}) {
  if (image) {
    const fd = new FormData();
    if (eyebrow !== undefined) fd.append("eyebrow", eyebrow);
    if (title !== undefined) fd.append("title", title);
    if (body !== undefined) fd.append("body", body);
    fd.append("image", image);
    return apiPatch("/api/settings/about", fd, { isForm: true });
  }
  return apiPatch("/api/settings/about", { eyebrow, title, body });
}

// ---- Home Page Copy -----------------------------------------------------
export async function updateHome({ howItWorksImage, ...fields } = {}) {
  if (howItWorksImage) {
    const fd = new FormData();
    Object.entries(fields).forEach(([key, value]) => {
      if (value !== undefined) fd.append(key, value);
    });
    fd.append("howItWorksImage", howItWorksImage);
    return apiPatch("/api/settings/home", fd, { isForm: true });
  }
  return apiPatch("/api/settings/home", fields);
}

// ---- Footer -------------------------------------------------------------
export async function updateFooter(payload) {
  return apiPatch("/api/settings/footer", payload);
}

// ---- Enrol Button (global — header/hero/CTA) -----------------------------
export async function updateEnrolButton(payload) {
  return apiPatch("/api/settings/enrol-button", payload);
}

// ---- How It Works steps --------------------------------------------------
export async function fetchHowItWorksSteps() {
  const { steps } = await apiGet("/api/settings/how-it-works/all");
  return steps;
}

export async function createHowItWorksStep({ icon, title, description, sortOrder, image }) {
  const fd = new FormData();
  if (icon) fd.append("icon", icon);
  fd.append("title", title);
  if (description) fd.append("description", description);
  if (sortOrder != null) fd.append("sortOrder", sortOrder);
  if (image) fd.append("image", image);
  return apiPost("/api/settings/how-it-works", fd, { isForm: true });
}

export async function updateHowItWorksStep(id, { icon, title, description, sortOrder, active, image }) {
  const fd = new FormData();
  if (icon !== undefined) fd.append("icon", icon);
  if (title !== undefined) fd.append("title", title);
  if (description !== undefined) fd.append("description", description);
  if (sortOrder != null) fd.append("sortOrder", sortOrder);
  if (active !== undefined) fd.append("active", active ? "true" : "false");
  if (image) fd.append("image", image);
  return apiPatch(`/api/settings/how-it-works/${id}`, fd, { isForm: true });
}

export async function deleteHowItWorksStep(id) {
  return apiDelete(`/api/settings/how-it-works/${id}`);
}

// ---- FAQs ------------------------------------------------------------
export async function fetchFaqs() {
  const { faqs } = await apiGet("/api/settings/faqs/all");
  return faqs;
}

export async function createFaq(payload) {
  return apiPost("/api/settings/faqs", payload);
}

export async function updateFaq(id, payload) {
  return apiPatch(`/api/settings/faqs/${id}`, payload);
}

export async function deleteFaq(id) {
  return apiDelete(`/api/settings/faqs/${id}`);
}

// ---- Gallery ---------------------------------------------------------
export async function fetchGalleryImages() {
  const { images } = await apiGet("/api/settings/gallery/all");
  return images;
}

export async function createGalleryImage({ caption, sortOrder, image }) {
  const fd = new FormData();
  if (caption) fd.append("caption", caption);
  if (sortOrder != null) fd.append("sortOrder", sortOrder);
  fd.append("image", image);
  return apiPost("/api/settings/gallery", fd, { isForm: true });
}

export async function updateGalleryImage(id, { caption, sortOrder, active, image }) {
  const fd = new FormData();
  if (caption !== undefined) fd.append("caption", caption);
  if (sortOrder != null) fd.append("sortOrder", sortOrder);
  if (active !== undefined) fd.append("active", active ? "true" : "false");
  if (image) fd.append("image", image);
  return apiPatch(`/api/settings/gallery/${id}`, fd, { isForm: true });
}

export async function deleteGalleryImage(id) {
  return apiDelete(`/api/settings/gallery/${id}`);
}

// ---- Partners ----------------------------------------------------------
export async function fetchPartners() {
  const { partners } = await apiGet("/api/settings/partners/all");
  return partners;
}

export async function createPartner({ name, url, sortOrder, logo }) {
  const fd = new FormData();
  fd.append("name", name);
  if (url) fd.append("url", url);
  if (sortOrder != null) fd.append("sortOrder", sortOrder);
  if (logo) fd.append("logo", logo);
  return apiPost("/api/settings/partners", fd, { isForm: true });
}

export async function updatePartner(id, { name, url, sortOrder, active, logo }) {
  const fd = new FormData();
  if (name !== undefined) fd.append("name", name);
  if (url !== undefined) fd.append("url", url);
  if (sortOrder != null) fd.append("sortOrder", sortOrder);
  if (active !== undefined) fd.append("active", active ? "true" : "false");
  if (logo) fd.append("logo", logo);
  return apiPatch(`/api/settings/partners/${id}`, fd, { isForm: true });
}

export async function deletePartner(id) {
  return apiDelete(`/api/settings/partners/${id}`);
}

// ---- Success Stories (list reuses fetchPublicSettings().stories, same as
// legacy's loadStoriesList()) ---------------------------------------------
export async function createSuccessStory({ name, role, quote, highlighted, sortOrder, avatar }) {
  const fd = new FormData();
  fd.append("name", name);
  if (role) fd.append("role", role);
  fd.append("quote", quote);
  fd.append("highlighted", highlighted ? "true" : "false");
  if (sortOrder != null) fd.append("sortOrder", sortOrder);
  if (avatar) fd.append("avatar", avatar);
  return apiPost("/api/settings/success-stories", fd, { isForm: true });
}

export async function deleteSuccessStory(id) {
  return apiDelete(`/api/settings/success-stories/${id}`);
}

// ---- Blog / News -------------------------------------------------------
export async function fetchBlogPosts() {
  const { posts } = await apiGet("/api/settings/blog/all");
  return posts;
}

export async function createBlogPost({ title, body, published, cover, featured, category, author, videoUrl }) {
  const fd = new FormData();
  fd.append("title", title);
  fd.append("body", body);
  fd.append("published", published === false ? "false" : "true");
  if (cover) fd.append("cover", cover);
  if (featured !== undefined) fd.append("featured", featured ? "true" : "false");
  if (category) fd.append("category", category);
  if (author) fd.append("author", author);
  if (videoUrl) fd.append("videoUrl", videoUrl);
  return apiPost("/api/settings/blog", fd, { isForm: true });
}

export async function updateBlogPost(id, { title, body, published, cover, featured, category, author, videoUrl }) {
  const fd = new FormData();
  if (title !== undefined) fd.append("title", title);
  if (body !== undefined) fd.append("body", body);
  if (published !== undefined) fd.append("published", published ? "true" : "false");
  if (cover) fd.append("cover", cover);
  if (featured !== undefined) fd.append("featured", featured ? "true" : "false");
  if (category !== undefined) fd.append("category", category);
  if (author !== undefined) fd.append("author", author);
  if (videoUrl !== undefined) fd.append("videoUrl", videoUrl);
  return apiPatch(`/api/settings/blog/${id}`, fd, { isForm: true });
}

export async function deleteBlogPost(id) {
  return apiDelete(`/api/settings/blog/${id}`);
}

/* ==========================================================================
   Learning Offering Types (Phase 30). Migrates legacy adminOfferingTypes()/
   loadOfferingTypesList()/openOfferingTypeModal()/saveOfferingType()/
   toggleOfferingTypeActive() (dashboard.html) — same
   /api/learning-offerings/types... contracts. The root entity for the
   Programmes → Learning Instances chain (later phases); field names and
   the `settings` shape are consumed exactly as the backend defines them
   (server/src/utils/offeringTypeSettings.js), not re-derived here.
   ========================================================================== */

// GET /api/learning-offerings/types?all=true is already wrapped by
// fetchOfferingTypes() above (used elsewhere, e.g. account-management
// filters) — reused as-is here, same contract as DTL.offeringTypes(true).

// GET /api/learning-offerings/types/settings-schema — requireAuth +
// requirePermission("offeringTypes.view"|"offeringTypes.create"|"offeringTypes.edit").
// Returns the full default settings object so the form can render every
// section for a brand-new type without hardcoding defaults client-side.
export async function fetchOfferingTypeSettingsSchema() {
  const { settings } = await apiGet("/api/learning-offerings/types/settings-schema");
  return settings;
}

// POST /api/learning-offerings/types — requirePermission("offeringTypes.create").
export async function createOfferingType(payload) {
  return apiPost("/api/learning-offerings/types", payload);
}

// PATCH /api/learning-offerings/types/:id — requirePermission("offeringTypes.edit").
// Backend deep-merges `settings` section-by-section, so sending only the
// sections shown in the form (the full set, same as legacy) is safe.
export async function updateOfferingType(id, payload) {
  return apiPatch(`/api/learning-offerings/types/${id}`, payload);
}

export async function activateOfferingType(id) {
  return apiPost(`/api/learning-offerings/types/${id}/activate`);
}

export async function deactivateOfferingType(id) {
  return apiPost(`/api/learning-offerings/types/${id}/deactivate`);
}

/* ==========================================================================
   Programmes (Phase 31). Migrates legacy adminProgrammes()/
   loadProgrammesList()/openProgrammeModal()/saveProgramme()/
   toggleProgrammeActive() and the inline Batches/Cohorts (Learning
   Groups) editor — openProgrammeGroupsModal()/addProgrammeGroup()/
   editProgrammeGroupFee()/renameProgrammeGroup()/deleteProgrammeGroup()
   (dashboard.html) — same /api/learning-offerings/programmes... and
   /api/classes... contracts. Second step in Learning Offering Types →
   Programmes → Learning Instances; fetchProgrammes()/fetchOfferingTypes()
   above are reused as-is (list endpoints already existed for other admin
   pages' filters).

   reopenProgrammeRegistration()/closeProgrammeRegistration()/
   resetProgrammeRegistrationOverride() used to live here as
   Programme-level registration overrides. Removed — see
   setOperationalConfig() below, which now owns that capability
   exclusively on the Programme Run (§8.2/§16 Single Ownership
   Principle).
   ========================================================================== */

// GET /api/learning-offerings/programmes/:id — requireAuth only. Returns
// the single programme plus its Learning Groups (Batches/Cohorts) and
// moduleCount, same as DTL.getProgramme(id).
export async function fetchProgramme(id) {
  return apiGet(`/api/learning-offerings/programmes/${id}`);
}

// POST /api/learning-offerings/programmes — requirePermission("learningOfferings.create").
export async function createProgramme(payload) {
  return apiPost("/api/learning-offerings/programmes", payload);
}

// PATCH /api/learning-offerings/programmes/:id — requirePermission("learningOfferings.edit").
export async function updateProgramme(id, payload) {
  return apiPatch(`/api/learning-offerings/programmes/${id}`, payload);
}

export async function setProgrammeActive(id, active) {
  return apiPost(`/api/learning-offerings/programmes/${id}/${active ? "activate" : "deactivate"}`);
}

// Registration Window admin actions (reopen/close/reset) used to live
// here as Programme-level overrides. Removed — Registration Window
// ownership belongs exclusively to the Programme Run now; use
// setOperationalConfig(instanceId, { registrationForceOpen: true }) (etc.)
// against the Programme's active Run instead. See LearningInstanceModal's
// Operational Configuration section.

export async function uploadProgrammeImage(id, file) {
  const fd = new FormData();
  fd.append("image", file);
  return apiPost(`/api/learning-offerings/programmes/${id}/image`, fd, { isForm: true });
}

// GET /api/learning-offerings/corporate-clients?all=true —
// requirePermission("corporateClients.view"). Reused both by the
// Programme modal's "Corporate Client" dropdown and by the Corporate
// Clients admin page itself (Phase 33) — same ?all=true as legacy's
// DTL.corporateClients(true) in both call sites.
export async function fetchCorporateClients() {
  const { corporateClients } = await apiGet("/api/learning-offerings/corporate-clients?all=true");
  return corporateClients;
}

/* ==========================================================================
   Admin Corporate Clients (Phase 33). Migrates legacy
   adminCorporateClients()/loadCorporateClientsList()/
   openCorporateClientModal()/saveCorporateClient()/
   toggleCorporateClientActive() (dashboard.html) — same
   /api/learning-offerings/corporate-clients... contract as api.js's
   DTL.corporateClients/createCorporateClient/updateCorporateClient/
   setCorporateClientActive/uploadCorporateClientLogo. fetchCorporateClients()
   above (list) is reused here.
   ========================================================================== */

// POST /api/learning-offerings/corporate-clients — requirePermission("corporateClients.create").
export async function createCorporateClient(payload) {
  return apiPost("/api/learning-offerings/corporate-clients", payload);
}

// PATCH /api/learning-offerings/corporate-clients/:id — requirePermission("corporateClients.edit").
export async function updateCorporateClient(id, payload) {
  return apiPatch(`/api/learning-offerings/corporate-clients/${id}`, payload);
}

export async function setCorporateClientActive(id, active) {
  return apiPost(`/api/learning-offerings/corporate-clients/${id}/${active ? "activate" : "deactivate"}`);
}

export async function uploadCorporateClientLogo(id, file) {
  const fd = new FormData();
  fd.append("logo", file);
  return apiPost(`/api/learning-offerings/corporate-clients/${id}/logo`, fd, { isForm: true });
}

/* ==========================================================================
   Admin Sponsors. NGOs/MPs/corporates/individuals covering a learner's
   fees — same CRUD shape as Corporate Clients above (view/create/edit,
   activate/deactivate instead of delete), since it's structurally the
   same kind of entity. See routes/sponsors.js.
   ========================================================================== */

// GET /api/sponsors?all=true — requirePermission("sponsors.view").
export async function fetchSponsors() {
  const { sponsors } = await apiGet("/api/sponsors?all=true");
  return sponsors;
}

export async function createSponsor(payload) {
  return apiPost("/api/sponsors", payload);
}

export async function updateSponsor(id, payload) {
  return apiPatch(`/api/sponsors/${id}`, payload);
}

export async function setSponsorActive(id, active) {
  return apiPost(`/api/sponsors/${id}/${active ? "activate" : "deactivate"}`);
}

// GET /api/sponsors/:id/learners — the roster of learners a sponsor is
// currently funding.
export async function fetchSponsorLearners(id) {
  return apiGet(`/api/sponsors/${id}/learners`);
}

// PATCH /api/users/:userId/sponsor — attach ({ sponsorId }) or detach
// ({ sponsorId: null }) a sponsor on a specific learner's account. Lives
// with the user routes server-side (routes/users.js), not sponsors.js,
// since it's a mutation on the learner's own account.
export async function setLearnerSponsor(userId, sponsorId) {
  return apiPatch(`/api/users/${userId}/sponsor`, { sponsorId });
}

// PATCH /api/enrolments/:id/participation-structure — admin-only edit of a
// learner's Builders' Lab participation structure (structured_school_club /
// structured_other / individual_course) on their primary programme
// enrolment. Backend contract already existed (routes/enrolments.js); this
// was the missing client wrapper for AccountDetailDrawer's edit control.
export async function setEnrolmentParticipationStructure(enrolmentId, participationStructure) {
  return apiPatch(`/api/enrolments/${enrolmentId}/participation-structure`, { participationStructure });
}

// POST /api/users/coordinators — admin creates a "parent" account for an
// NGO/MP/organization coordinator, pre-tied to a sponsor and (optionally)
// capped at maxChildren. Every child this account later adds via the
// normal Add-a-Child flow is auto-sponsored — see that route's own
// comment in routes/users.js.
export async function createCoordinator(payload) {
  return apiPost("/api/users/coordinators", payload);
}

// GET /api/sponsors/:id/coordinators — the coordinator logins currently
// registering learners on this sponsor's behalf (distinct from
// fetchSponsorLearners above, which is the learners themselves).
export async function fetchSponsorCoordinators(sponsorId) {
  return apiGet(`/api/sponsors/${sponsorId}/coordinators`);
}

// POST /api/users/:userId/reset-credentials — admin generates a fresh
// password for a coordinator account (e.g. the original handover was
// missed or lost) and gets it back once to hand over again.
export async function resetCoordinatorPassword(userId) {
  return apiPost(`/api/users/${userId}/reset-credentials`);
}

/* ==========================================================================
   Admin Learning Instances (Phase 32). Migrates legacy
   adminLearningInstances()/loadLearningInstancesList()/
   openLearningInstanceModal()/saveLearningInstance()/
   transitionLearningInstance() (dashboard.html) — same
   /api/learning-instances... contract as api.js's DTL.learningInstances/
   getLearningInstance/createLearningInstance/updateLearningInstance/
   activateLearningInstance/completeLearningInstance/
   archiveLearningInstance/cancelLearningInstance. fetchLearningInstances()
   above (list) is reused here; fetchOfferingTypes()/fetchProgrammes()/
   fetchModules() above are reused for the modal's dropdowns, same as
   legacy's openLearningInstanceModal() loading offeringTypes/programmes/
   modules alongside the instance itself. Third and final step in the
   Learning Offering Types → Programmes → Learning Instances chain.
   ========================================================================== */

// GET /api/learning-instances/:id — requirePermission("learningInstances.view")
// (or, for an instructor, scoped to their own assigned Programmes/Modules —
// not applicable to this admin-only page).
export async function fetchLearningInstance(id) {
  return apiGet(`/api/learning-instances/${id}`);
}

// POST /api/learning-instances — requirePermission("learningInstances.create").
export async function createLearningInstance(payload) {
  return apiPost("/api/learning-instances", payload);
}

// PATCH /api/learning-instances/:id — requirePermission("learningInstances.edit").
// offeringTypeId/programmeId/courseId/status are immutable here by design
// (backend rejects any attempt to change them) — only name/startDate/
// endDate are sent, same as legacy's saveLearningInstance() edit path.
export async function updateLearningInstance(id, payload) {
  return apiPatch(`/api/learning-instances/${id}`, payload);
}

// Status transitions — each a dedicated POST, same as legacy's
// transitionLearningInstance()/DTL.*LearningInstance calls. All gated by
// requirePermission("learningInstances.edit") and the server-side
// ALLOWED_TRANSITIONS state machine (see server/src/utils/learningInstances.js).
export async function activateLearningInstance(id) {
  return apiPost(`/api/learning-instances/${id}/activate`);
}
export async function completeLearningInstance(id) {
  return apiPost(`/api/learning-instances/${id}/complete`);
}
export async function archiveLearningInstance(id) {
  return apiPost(`/api/learning-instances/${id}/archive`);
}
export async function cancelLearningInstance(id) {
  return apiPost(`/api/learning-instances/${id}/cancel`);
}

// Multi-target Learning Instances (Stage 4C/4E). A run's primary target
// (set at creation, mirrored into the payload above) can't be changed —
// these two manage ADDITIONAL Programmes/Modules attached to an existing
// run. POST returns the full updated instance (with its refreshed
// `targets` array), same shape as fetchLearningInstance().
export async function addLearningInstanceTarget(id, { programmeId, courseId }) {
  return apiPost(`/api/learning-instances/${id}/targets`, { programmeId: programmeId || undefined, courseId: courseId || undefined });
}
export async function removeLearningInstanceTarget(id, targetId) {
  return apiDelete(`/api/learning-instances/${id}/targets/${targetId}`);
}

// ---- Academic structure & period-specific targets/payment (Phases 4–6) --
// A run's Semester/Term breakdown (locked once it leaves "upcoming"),
// each period's active-target subset, and each period's payment
// requirement. All return the full updated instance (with a refreshed
// `academicPeriods` array, each period carrying its own `targets` and
// `paymentMode`/`requiredAmountGHS`) except setPeriodPaymentRequirement,
// which returns just that one updated period.
export async function setAcademicStructure(id, structure) {
  return apiPatch(`/api/learning-instances/${id}/academic-structure`, { structure });
}
// v31 — Programme Run operational ownership: Delivery Modes, Campuses,
// Fee, Installments, Capacity, Instructor. `payload` fields are all
// optional/independent (omit any you don't want to change); pass null to
// explicitly clear one. See server/src/routes/learningInstances.js PATCH
// /:id/operational-config.
export async function setOperationalConfig(id, payload) {
  return apiPatch(`/api/learning-instances/${id}/operational-config`, payload);
}
// PATCH /api/learning-instances/:id/academic-periods/:periodId — rename a
// period, or link/adjust its optional dates and Academic Term
// cross-reference. academicTermId is required by the backend whenever the
// period doesn't already have one set (§18 Admin Configuration Workflow /
// §2.1 Single Ownership compliance — see server/src/utils/
// learningInstances.js updateAcademicPeriod()).
export async function updateAcademicPeriod(id, periodId, { name, academicTermId, startDate, endDate } = {}) {
  return apiPatch(`/api/learning-instances/${id}/academic-periods/${periodId}`, { name, academicTermId, startDate, endDate });
}
export async function setPeriodTargets(id, periodId, targetIds) {
  return apiPut(`/api/learning-instances/${id}/academic-periods/${periodId}/targets`, { targetIds });
}
export async function setPeriodPaymentRequirement(id, periodId, { mode, requiredAmountGHS }) {
  return apiPatch(`/api/learning-instances/${id}/academic-periods/${periodId}/payment-requirement`, { mode, requiredAmountGHS });
}
export async function fetchLearnerPeriodPaymentStatus(id, periodId, learnerId) {
  return apiGet(`/api/learning-instances/${id}/academic-periods/${periodId}/learners/${learnerId}/payment-status`);
}

// ---- Activated Courses (§8/§9) — Phase 5 prerequisite 2 -----------------
// A Run's `activatedCourses` array is already embedded on the instance
// returned by fetchLearningInstance()/fetchLearningInstances() — nothing
// new to fetch. This is the corresponding write: review/edit one Course's
// own configuration for this Run (status, Hidden, Compulsory, display
// order, Run-scoped instructor). Returns just that one updated Activated
// Course row (not the whole instance), same "single-thing-changed
// response" shape as setPeriodPaymentRequirement above.
export async function updateActivatedCourse(id, activatedCourseId, payload) {
  return apiPatch(`/api/learning-instances/${id}/activated-courses/${activatedCourseId}`, payload);
}

export async function assignCourseToLearningInstance(id, courseId) {
  return apiPost(`/api/learning-instances/${id}/activated-courses`, { courseId });
}

export async function removeCourseFromLearningInstance(id, activatedCourseId) {
  return apiDelete(`/api/learning-instances/${id}/activated-courses/${activatedCourseId}`);
}

// ---- Operational Groups (v39, ABRS v2.2 §11 / Appendix A-9) -------------
// A Programme Run's Operational Groups — batches/cohorts/sections that
// exist only to organize delivery. NOT Programme Levels (those stay
// classes/`classId`), NOT Participation Structures, NOT Courses (§11.2).
// Each group's overrides (feeGHS/capacity/instructorId/deliveryMode/
// campusId/registrationDeadline) are all optional/independent — omit any
// you don't want to set; pass null to explicitly clear one back to
// "inherit from this Programme Run".
export async function fetchOperationalGroups(instanceId, { includeInactive = false } = {}) {
  const qs = includeInactive ? "?includeInactive=true" : "";
  const { operationalGroups } = await apiGet(`/api/learning-instances/${instanceId}/operational-groups${qs}`);
  return operationalGroups;
}
export async function createOperationalGroup(instanceId, payload) {
  return apiPost(`/api/learning-instances/${instanceId}/operational-groups`, payload);
}
export async function updateOperationalGroup(instanceId, groupId, payload) {
  return apiPatch(`/api/learning-instances/${instanceId}/operational-groups/${groupId}`, payload);
}
export async function deleteOperationalGroup(instanceId, groupId) {
  return apiDelete(`/api/learning-instances/${instanceId}/operational-groups/${groupId}`);
}

// Administrative Operational Group transfer for one Enrollment — distinct
// from Promotion (§11.4/§20.2). Pass groupId: null to unassign.
export async function setEnrolmentOperationalGroup(enrolmentId, operationalGroupId) {
  return apiPatch(`/api/enrolments/${enrolmentId}/operational-group`, { operationalGroupId });
}

// ---- Learning Groups (Batches/Cohorts) under a Programme — POST/PATCH/DELETE
// /api/classes..., requireRole("admin"). GET is not needed here: a
// programme's groups come back embedded in fetchProgramme(id).learningGroups,
// same as legacy re-fetching DTL.getProgramme(id) after every group mutation.
export async function createLearningGroup(payload) {
  return apiPost("/api/classes", payload);
}

export async function updateLearningGroup(id, payload) {
  return apiPatch(`/api/classes/${id}`, payload);
}

export async function deleteLearningGroup(id) {
  return apiDelete(`/api/classes/${id}`);
}
