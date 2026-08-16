/* ==========================================================================
   Parent dashboard API methods (Phase 6, extended Phase 22). Phase 6 kept
   this deliberately minimal — the legacy parentOverview() renderer
   (dashboard.html) otherwise only called the already-shared
   GET /api/users/:id (api/users.js). Phase 22 completes the remaining
   parent screens (Certificates/Continuous Assessment/Transcripts/
   Progress/Payments/My Programmes/Messages), each a thin wrapper around
   the exact same endpoint its legacy parent*() function already used —
   see dashboard.html's PARENT VIEWS section for the 1:1 mapping. "Add a
   child" remains intentionally not ported — see ParentDashboard.jsx.

   Every one of these endpoints already accepts a parent calling on
   behalf of a linked child via requireSelfParentOrStaff (and, for
   payment/access-gated academic content, requireActiveAccess scoped to
   that one child — see server/src/middleware/auth.js). Nothing here
   re-derives or widens that boundary; a parent asking for a child that
   isn't theirs gets the same 401/403 the backend would give anyone else.
   ========================================================================== */
import { apiGet, apiPost, apiDelete } from "./client";
import { notifyMessagesRead } from "./notificationEvents";

// DELETE /api/users/:parentId/children/:learnerId
export async function removeChild(parentId, learnerId) {
  return apiDelete(`/api/users/${parentId}/children/${learnerId}`);
}

// POST /api/users/:parentId/children — { name, age, campus, schoolName,
// ownRoboticsKit, modules }. Migrates legacy openAddChildModal()/
// submitAddChild() (dashboard.html): reuses the exact same fields/rules
// as /api/auth/register's parent-learner path (see
// server/src/routes/users.js for the full breakdown). The new learner is
// created with status='pending_payment', same as at initial registration
// — no separate payment call here, the parent's existing combined-charge
// payment flow (ParentPaymentsPage) picks it up automatically.
export async function addChild(parentId, payload) {
  return apiPost(`/api/users/${parentId}/children`, payload);
}

// GET /:parentId/children/credentials — the persistent, authorized
// credential view (Stage 4A/4B). Returns password: null once a learner
// has logged in for themselves (see routes/auth.js).
export async function fetchChildrenCredentials(parentId) {
  const { learners } = await apiGet(`/api/users/${parentId}/children/credentials`);
  return learners;
}

// GET /api/modules — public, unfiltered (same endpoint api/learner.js and
// api/admin.js each already wrap independently; kept here too rather than
// cross-importing across portal modules, matching the rest of the app).
// The route returns { courses: [...] } (server/src/routes/modules.js) —
// destructure that key, not "modules".
export async function fetchModules() {
  const { courses } = await apiGet("/api/modules");
  return courses;
}

// GET /api/modules/:moduleId/lessons — requireActiveAccessSelf. For a
// parent caller this is gated on EVERY linked child at once, not just the
// one the lessons belong to (there's no per-child scoping on this route —
// see the middleware's own comment in server/src/middleware/auth.js), so
// a single restricted ward can 403 this for all of them. Callers should
// treat that 403 as "lesson progress unavailable right now", not as
// "no lessons" or a real error.
export async function fetchLessonsForModule(moduleId) {
  const { lessons } = await apiGet(`/api/modules/${moduleId}/lessons`);
  return lessons;
}

// GET /api/attendance/learner/:learnerId — requireSelfParentOrStaff, no
// payment-restriction gate.
export async function fetchAttendanceHistory(learnerId) {
  const { attendance } = await apiGet(`/api/attendance/learner/${learnerId}`);
  return attendance;
}

// ---- certificates -----------------------------------------------------------
// GET /api/certificates/learner/:userId — requireSelfParentOrStaff +
// requireActiveAccess("userId"), scoped to this one child.
export async function fetchCertificates(childId) {
  const { certificates } = await apiGet(`/api/certificates/learner/${childId}`);
  return certificates;
}

// ---- continuous assessment results ------------------------------------------
// GET /api/continuous-assessments/mine/:userId — same guard pair as above.
export async function fetchContinuousAssessmentResults(childId) {
  const { results } = await apiGet(`/api/continuous-assessments/mine/${childId}`);
  return results;
}

// ---- grades / transcript -----------------------------------------------------
// GET /api/grades/:userId/transcript — same guard pair as above. Returns
// the full transcript payload as-is (learner, rows, attendance, branding,
// issued, stars) — nothing recomputed client-side.
//
// Phase 10 — optional { learningInstanceId, academicPeriodId } switches
// this to the period-scoped transcript (both must be given together, per
// the backend's own validation); omitting them keeps the exact same
// default (non-period) behaviour as before.
export async function fetchTranscript(childId, { learningInstanceId, academicPeriodId } = {}) {
  const params = {};
  if (learningInstanceId) params.learningInstanceId = learningInstanceId;
  if (academicPeriodId) params.academicPeriodId = academicPeriodId;
  const qs = new URLSearchParams(params).toString();
  return apiGet(`/api/grades/${childId}/transcript${qs ? `?${qs}` : ""}`);
}

// GET /api/grades/:userId/transcript-options — Phase 10 self-service
// catalog (this learner's own Learning Instances that have an academic
// structure, each with its academic periods) for building the Learning
// Instance/Period picker used above. Same guard pair as fetchTranscript.
export async function fetchTranscriptOptions(childId) {
  const { learningInstances } = await apiGet(`/api/grades/${childId}/transcript-options`);
  return learningInstances;
}

// ---- payments ----------------------------------------------------------------
// GET /api/payments/user/:userId — requireSelfParentOrStaff, no
// access-restriction gate (a parent must always be able to see/settle a
// restricted child's balance).
export async function fetchPayments(childId) {
  const { payments } = await apiGet(`/api/payments/user/${childId}`);
  return payments;
}

// GET /api/payments/:userId/period-status — Phase 10 self-service view of
// every period payment requirement across this learner's own Learning
// Instances (required amount/mode, amount paid, outstanding balance,
// status), same guard pair as fetchPayments.
export async function fetchPeriodPaymentStatus(childId) {
  const { periodPayments } = await apiGet(`/api/payments/${childId}/period-status`);
  return periodPayments;
}

// POST /api/payments/:userId/initiate — same Mobile Money charge flow as
// legacy payMonthly(): { type: "monthly", network, momoNumber } -> a
// Paystack charge either resolves immediately ("success"), needs an OTP
// ("send_otp"), or needs polling. Not re-derived or simplified here — the
// backend (server/src/routes/payments.js) is the sole authority on
// amount, fee type, and success/failure. `method` defaults to
// MOBILE_MONEY, matching every existing caller byte-for-byte; pass
// "CARD" for the Paystack hosted-checkout path (see PayMonthlyFeeModal.jsx)
// — network/momoNumber are simply ignored server-side in that case.
export async function initiateMonthlyPayment(childId, { network, momoNumber, method } = {}) {
  return apiPost(`/api/payments/${childId}/initiate`, { type: "monthly", method, network, momoNumber });
}

// POST /api/payments/:childId/initiate — same Mobile Money charge flow as
// initiateMonthlyPayment above, but tagged with learningInstanceId +
// learningInstanceAcademicPeriodId so the server charges exactly that
// Learning Instance's Academic Period's outstanding balance (the Phase 6
// period-payment branch in server/src/routes/payments.js — it keys off the
// presence of learningInstanceAcademicPeriodId in the body, not a `type`)
// instead of the flat legacy monthly/programme fee. `method` defaults to
// MOBILE_MONEY, same convention as initiateMonthlyPayment/
// initiateEnrolmentPayment; pass "CARD" for the Paystack hosted-checkout
// path (see PayPeriodModal.jsx).
export async function initiatePeriodPayment(childId, { network, momoNumber, method, learningInstanceId, learningInstanceAcademicPeriodId }) {
  return apiPost(`/api/payments/${childId}/initiate`, {
    method,
    network,
    momoNumber,
    learningInstanceId,
    learningInstanceAcademicPeriodId,
  });
}

// POST /api/payments/otp — { reference, otp }
export async function submitPaymentOtp(reference, otp) {
  return apiPost("/api/payments/otp", { reference, otp });
}

// GET /api/payments/:reference/verify — manual poll fallback, same as
// legacy's payMonthly() polling loop.
export async function verifyPayment(reference) {
  return apiGet(`/api/payments/${reference}/verify`);
}

// ---- my programmes (existing-account additional-programme enrolment) --------
// GET /api/enrolments/mine?targetUserId=<childId> — accepts any caller
// self/parent-of per resolveTargetLearner() (server/src/routes/enrolments.js).
export async function fetchEnrolments(childId) {
  const { enrolments } = await apiGet(`/api/enrolments/mine?targetUserId=${encodeURIComponent(childId)}`);
  return enrolments;
}

// GET /api/enrolments/eligible-offerings?targetUserId=<childId> — Learning
// Offering Types this account could self-enrol an ADDITIONAL programme
// into, scoped to whichever audience (adult / parent-learner) the child
// belongs to. Migrates legacy toggleEnrolForm()'s first DTL call
// (dashboard.html).
export async function fetchEligibleOfferings(childId) {
  return apiGet(`/api/enrolments/eligible-offerings?targetUserId=${encodeURIComponent(childId)}`);
}

// GET /api/enrolments/fee-preview?targetUserId=<childId>&classId=<classId>
// — the registration fee that will actually be charged for a given
// Batch/Cohort, computed server-side with the exact same logic the
// payment step itself uses. Migrates legacy onEnrolClassChange().
export async function fetchEnrolmentFeePreview(childId, classId) {
  return apiGet(`/api/enrolments/fee-preview?targetUserId=${encodeURIComponent(childId)}&classId=${encodeURIComponent(classId)}`);
}

// POST /api/enrolments — { targetUserId, programmeId, classId }. Creates
// the new 'pending_payment' enrolment row; payment is a separate step
// (see initiateEnrolmentPayment below). Migrates legacy
// submitAdditionalEnrolment().
export async function enrolInAdditionalProgramme({ targetUserId, programmeId, classId }) {
  return apiPost("/api/enrolments", { targetUserId, programmeId, classId });
}

// POST /api/payments/:childId/initiate — same Mobile Money charge flow as
// initiateMonthlyPayment above, but tagged with programmeEnrollmentId so
// the server activates that one additional enrolment (not the account's
// primary status). Migrates legacy payAdditionalEnrolment(). `method`
// defaults to MOBILE_MONEY, matching every existing caller byte-for-byte;
// pass "CARD" for the Paystack hosted-checkout path (see PayEnrolmentModal.jsx).
export async function initiateEnrolmentPayment(childId, { network, momoNumber, programmeEnrollmentId, method }) {
  return apiPost(`/api/payments/${childId}/initiate`, { type: "registration", method, network, momoNumber, programmeEnrollmentId });
}

// ---- messages ------------------------------------------------------------
// GET /api/users/instructors-for/:learnerId — same endpoint legacy's
// DTL.instructorsForLearner() wraps, used to build the parent's message
// contact list (one entry per instructor teaching any linked child).
export async function fetchInstructorsForLearner(learnerId) {
  const { instructors } = await apiGet(`/api/users/instructors-for/${learnerId}`);
  return instructors;
}

// GET /api/messages/thread/:otherUserId
export async function fetchThread(otherUserId) {
  const { messages } = await apiGet(`/api/messages/thread/${otherUserId}`);
  notifyMessagesRead();
  return messages;
}

// POST /api/messages — { to, body, subject }
export async function sendMessage({ to, body, subject }) {
  return apiPost("/api/messages", { to, body, subject });
}

