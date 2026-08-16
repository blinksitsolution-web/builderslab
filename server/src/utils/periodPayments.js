// ============================================================
// Period-specific payment enforcement (Phase 6).
//
// Builds on Phase 4's learning_instance_academic_periods (a Learning
// Instance's own Semester/Term breakdown) and Phase 5's period-target
// configuration (learning_instance_period_targets) to answer the one
// question every learning-content access route needs: "does THIS learner
// currently satisfy the payment requirement for THIS academic period of
// THIS Learning Instance?"
//
// Reuses the existing `payments` table exclusively — no parallel payment
// system. A payment counts toward a period only when it is `successful`,
// in GHS, belongs to the learner, and is explicitly scoped to that
// Learning Instance + academic period via the new
// payments.learning_instance_academic_period_id column (migrate.js v27).
// This is what keeps period payments auditable and non-duplicating: a
// learner advancing to a new period simply hasn't paid anything scoped to
// that period yet (0 paid, not a copy of a prior period's rows), and every
// legacy/registration/monthly payment (learning_instance_academic_period_id
// IS NULL) is never accidentally counted toward any period's total.
// ============================================================

const db = require("../db/db");
const {
  getCurrentAcademicPeriod,
  isTargetActiveInCurrentPeriod,
  getActiveInstanceIdForCourse,
  getLearningInstanceById,
  getInstanceTargets,
  getEffectivePeriodPaymentRequirement,
} = require("./learningInstances");

// Sum of successful GHS payments this learner has made that are explicitly
// scoped to this Learning Instance + academic period.
function amountPaidForPeriod(learnerId, learningInstanceId, periodId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM payments
       WHERE user_id = ? AND learning_instance_id = ? AND learning_instance_academic_period_id = ?
         AND status = 'successful' AND currency = 'GHS'`
    )
    .get(learnerId, learningInstanceId, periodId);
  return row ? Number(row.total) || 0 : 0;
}

// The full picture for one learner/instance/period: required amount, paid
// so far, outstanding balance, a human status label, which mode applies,
// and whether the learner currently satisfies the access requirement.
// A period with no payment requirement configured (paymentMode === null)
// always resolves to `satisfied: true` — the "don't invent a requirement
// for historical/unconfigured periods" rule.
//
// `instance` (not just its id) is required so this can resolve the
// Combined Registration + First Period Payment requirement for the
// first academic period (getEffectivePeriodPaymentRequirement) instead
// of only ever reading the period row's own, independently-configured
// payment_mode/required_amount_ghs columns — which stay NULL for that
// period by design once combine is ON (business rule §9: never a second,
// duplicated source of truth for the same obligation).
function getPeriodPaymentStatus(learnerId, instance, period) {
  const learningInstanceId = instance && instance.id ? instance.id : instance;
  const requirement = getEffectivePeriodPaymentRequirement(instance, period);
  if (!requirement.mode || !requirement.requiredAmountGHS) {
    return {
      mode: null,
      requiredAmountGHS: 0,
      amountPaidGHS: 0,
      outstandingGHS: 0,
      status: "not_required",
      satisfied: true,
    };
  }
  const requiredAmountGHS = requirement.requiredAmountGHS;
  const amountPaidGHS = amountPaidForPeriod(learnerId, learningInstanceId, period.id);
  const outstandingGHS = Math.max(0, Math.round((requiredAmountGHS - amountPaidGHS) * 100) / 100);
  let status;
  if (amountPaidGHS <= 0) status = "unpaid";
  else if (amountPaidGHS < requiredAmountGHS) status = "partial";
  else status = "paid";
  return {
    mode: requirement.mode,
    requiredAmountGHS,
    amountPaidGHS,
    outstandingGHS,
    status,
    satisfied: amountPaidGHS >= requiredAmountGHS,
    inheritedFromRegistrationFee: !!requirement.inheritedFromRegistrationFee,
  };
}

// The full access decision for one learner trying to reach a specific
// Programme/Module target belonging to `instance`, right now:
//   - no academic structure configured on the instance at all -> never
//     restricted by this (nothing for the admin to have configured yet —
//     this is what keeps every pre-Phase-4 Learning Instance, and every
//     historical access pattern, completely unaffected);
//   - no resolvable "current" period (shouldn't happen once a structure
//     is set, but defensive) -> not restricted;
//   - the current period has an explicitly configured (non-empty) target
//     list that does NOT include this Programme/Module -> restricted,
//     reason 'not_active_for_period'. An EMPTY target list for the period
//     means the admin hasn't configured it yet, which is treated as
//     unrestricted-by-target (same back-compat reasoning as payment_mode
//     being null) rather than silently locking out every learner the
//     moment Phase 4 structure is turned on.
//   - the resolved period's payment requirement isn't satisfied ->
//     restricted, reason 'payment', with the full paymentStatus attached
//     for the caller to surface (amount owed, etc).
function evaluatePeriodAccess({ instance, learnerId, courseId = null, programmeId = null }) {
  if (!instance || !instance.academicStructure) {
    return { restricted: false, period: null, paymentStatus: null };
  }
  const period = getCurrentAcademicPeriod(instance);
  if (!period) {
    return { restricted: false, period: null, paymentStatus: null };
  }
  if (!isTargetActiveInCurrentPeriod(instance, { courseId, programmeId })) {
    return { restricted: true, reason: "not_active_for_period", period, paymentStatus: null };
  }
  const paymentStatus = getPeriodPaymentStatus(learnerId, instance, period);
  if (!paymentStatus.satisfied) {
    return { restricted: true, reason: "payment", period, paymentStatus };
  }
  return { restricted: false, period, paymentStatus };
}

// ------------------------------------------------------------------------
// Root-cause fix: evaluatePeriodAccess above was previously wired into only
// ONE learner-content route (routes/modules.js's GET /:courseId/lessons —
// video lessons). Every other course-scoped learner-content route (Notes,
// Assignments, Continuous Assessments, Examinations, Progress/quiz) gated
// only on the account's GLOBAL payment_status/status
// (utils/accessControl.js), which a registration/monthly payment sets to
// 'current' and — correctly, per that column's own contract — a later
// period-scoped payment never touches (see utils/paymentActivation.js).
// The practical effect: once a learner's account was globally 'current',
// every one of those routes stayed open even after they advanced into a
// new academic period they had not yet paid for — exactly the "a
// historical successful payment keeps authorizing future unpaid periods"
// bug this checkpoint exists to close. The fix is not a new rule; it's
// applying this ALREADY-CORRECT per-course decision at every course-scoped
// learner-content route, the same way it already gates video lessons.
//
// learnerIdsForCourseAccess / periodAccessDecisionForCourse are the exact
// same "which learner record(s) does this request check against" and
// "what does evaluatePeriodAccess say about them" logic routes/modules.js
// originally had inlined for its own lessons gate — factored out here so
// every route reuses one implementation instead of five copies.
function learnerIdsForCourseAccess(user, courseId) {
  if (!user) return [];
  if (user.role === "learner") return [user.id];
  if (user.role === "parent") {
    return db
      .prepare("SELECT e.user_id as id FROM enrollments e JOIN users u ON u.id = e.user_id WHERE u.parent_id = ? AND e.course_id = ?")
      .all(user.id, courseId)
      .map((r) => r.id);
  }
  return [];
}

// The instance/structure resolution shared by both decision helpers below —
// factored out so it's derived once, the same way, everywhere.
// Prefer the Learning Instance attached to the learner's actual registration
// over a global "most recent active Run for this course" lookup. This keeps
// Individual Course + term/semester offerings from accidentally resolving
// against an unrelated Structured Run (and vice versa).
// True when `instance` is the learner's OWN enrollment Learning Instance
// for `courseId` — i.e. the enrollment's offering is Individual Course, the
// instance directly owns/targets the course, the instance is a
// programme-wide run (curriculum grants courses without a course target),
// or the course has been explicitly activated onto this instance
// (learning_instance_courses — the Bootcamp/Adult Professional/Corporate
// Training run-scoped-curriculum path). Factored out of
// resolveInstanceForPeriodAccess so "does this row match" and "does the
// match gate on periods" are two separate questions (see that function's
// root-cause-fix comment below).
function instanceOwnsCourseForEnrollment(instance, participationStructure, courseId) {
  if (participationStructure === "individual_course") return true;
  if (instance.courseId === courseId) return true;
  const targets = getInstanceTargets(instance.id);
  if (targets.some((t) => t.courseId === courseId)) return true;
  if (targets.some((t) => t.targetType === "programme")) return true;
  const activated = db
    .prepare(
      `SELECT 1 FROM learning_instance_courses
       WHERE learning_instance_id = ? AND course_id = ? AND (status IS NULL OR status = 'active')`
    )
    .get(instance.id, courseId);
  return !!activated;
}

function resolveInstanceForPeriodAccess(learnerId, courseId) {
  if (learnerId) {
    const enrollmentRows = db
      .prepare(
        `SELECT learning_instance_id, participation_structure, is_primary
         FROM programme_enrollments
         WHERE user_id = ? AND learning_instance_id IS NOT NULL
           AND status IN ('active', 'pending_payment')
         ORDER BY is_primary DESC, created_at DESC`
      )
      .all(learnerId);

    for (const row of enrollmentRows) {
      const instance = getLearningInstanceById(row.learning_instance_id);
      if (!instance) continue;
      if (!instanceOwnsCourseForEnrollment(instance, row.participation_structure, courseId)) continue;

      // Root-cause fix (Bootcamp cross-Learning-Instance resolution bug):
      // this row IS the learner's own enrollment Learning Instance for this
      // course, established via their actual programme_enrollment — never a
      // guess. Previously, an owning instance with no academicStructure
      // configured (every Bootcamp Learning Instance: Bootcamp has no
      // term/semester concept at all — see
      // isParticipationStructureAllowedForOfferingType's Bootcamp comment
      // above) was treated as "no match" (`continue`) here, which let the
      // loop fall through to the GLOBAL, offering-type-blind
      // resolveStructuredInstanceForCourse fallback below. That fallback
      // (getActiveInstanceIdForCourse) picks the most-recently-activated
      // Active Learning Instance targeting this courseId with NO regard for
      // which learner or offering type it belongs to — so a fully-paid
      // Bootcamp learner whose course happens to also be targeted by an
      // unrelated, more-recently-created Kids STEM/structured Learning
      // Instance would have their content request wrongly evaluated against
      // THAT Learning Instance's academic-period payment requirement instead
      // of their own. Once we've found the learner's own enrollment
      // instance for this course, that is final: return it if it has an
      // academic structure to check, or null otherwise (evaluatePeriodAccess
      // already treats an instance with no academicStructure as
      // unrestricted, and periodAccessDecisionForCourse/ForLearner already
      // treat a null instance as unrestricted) — but never keep searching
      // and never fall through to a different Learning Instance.
      return instance.academicStructure ? instance : null;
    }
  }

  return resolveStructuredInstanceForCourse(courseId);
}

function resolveStructuredInstanceForCourse(courseId) {
  const instanceId = getActiveInstanceIdForCourse(courseId);
  const instance = instanceId ? getLearningInstanceById(instanceId) : null;
  return instance && instance.academicStructure ? instance : null;
}

// The access decision for one SPECIFIC, already-known learner id reaching a
// specific Course right now — for routes that are already scoped to an
// explicit target learner (e.g. progress.js's :userId routes, which already
// run their own ownership/enrollment check) rather than deriving the
// learner id from the caller's own role. `bypass` lets the caller pass its
// own already-computed staff/instructor-or-admin bypass decision straight
// through, matching every other gate in this codebase where staff are never
// restricted. Returns null when the caller should proceed unrestricted.
function periodAccessDecisionForLearner(learnerId, courseId, { bypass = false } = {}) {
  if (!courseId || !learnerId || bypass) return null;
  const instance = resolveInstanceForPeriodAccess(learnerId, courseId);
  if (!instance) return null;
  const decision = evaluatePeriodAccess({ instance, learnerId, courseId });
  return decision.restricted ? decision : null;
}

// The access decision for one caller (learner, or parent on behalf of any
// linked/enrolled child) reaching a specific Course right now. Returns null
// when the caller should proceed unrestricted — no courseId to check, staff
// (instructors/admins always bypass, matching every other gate in this
// codebase), no resolvable Learning Instance/academic structure for this
// Course (back-compat: nothing for an admin to have configured yet), or no
// linked learner id to check against (nothing to restrict). Otherwise
// returns the same { restricted: true, reason, period, paymentStatus }
// shape evaluatePeriodAccess itself returns, taken from whichever checked
// learner illustrates the block (mirrors the "any one satisfied lets a
// parent's request through" tradeoff callerCanAccessCourse already uses
// elsewhere for the same parent/multi-child shape).
function periodAccessDecisionForCourse(user, courseId) {
  if (!courseId || !user || user.role === "instructor" || user.role === "admin") return null;
  const learnerIds = learnerIdsForCourseAccess(user, courseId);
  if (!learnerIds.length) return null;
  // Evaluate each learner against THEIR own enrollment LI — do not share one
  // global course→instance resolution across siblings/wards.
  for (const learnerId of learnerIds) {
    const instance = resolveInstanceForPeriodAccess(learnerId, courseId);
    if (!instance) return null;
    if (!evaluatePeriodAccess({ instance, learnerId, courseId }).restricted) return null;
  }
  const firstInstance = resolveInstanceForPeriodAccess(learnerIds[0], courseId);
  return evaluatePeriodAccess({ instance: firstInstance, learnerId: learnerIds[0], courseId });
}

// Same 402/403 response shape routes/modules.js's lessons gate already
// returns, shared so every route surfaces this identically.
function sendPeriodAccessDenied(res, decision) {
  if (decision.reason === "payment") {
    return res.status(402).json({
      error: "Payment is required for the current academic period before this content can be accessed.",
      code: "PERIOD_PAYMENT_REQUIRED",
      period: { id: decision.period.id, name: decision.period.name },
      paymentStatus: decision.paymentStatus,
    });
  }
  return res.status(403).json({ error: "This Course isn't part of the current academic period.", code: "NOT_ACTIVE_FOR_PERIOD" });
}

module.exports = {
  amountPaidForPeriod,
  getPeriodPaymentStatus,
  evaluatePeriodAccess,
  learnerIdsForCourseAccess,
  periodAccessDecisionForCourse,
  periodAccessDecisionForLearner,
  sendPeriodAccessDenied,
};
