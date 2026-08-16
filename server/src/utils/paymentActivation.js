const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { getActiveInstanceIdForClass, activateEnrollmentCurriculum, syncPeriodCourseEnrollments, getEnrolledLearningInstanceIdForLearner } = require("./learningInstances");

// Turns a combined multi-ward registration charge (one payments row on the
// PARENT's user_id, covering several learners at once — see
// routes/payments.js POST /:userId/initiate) into one additional payments
// row PER learner, each carrying that learner's own user_id, amount,
// Programme/Class and (freshly resolved) Learning Instance. Without this,
// the combined row was invisible to every per-learner/per-Learning-Instance
// figure in the Admin Portal (Payments Overview, the Admin Overview
// "Statistics by ..." panel) since it has no single correct
// programme_id/class_id/learning_instance_id of its own and isn't tied to
// any one learner's user_id.
//
// Idempotent: safe to call more than once for the same payment (e.g. a
// webhook retry) — skips any learner a row has already been fanned out for.
function fanOutCombinedRegistrationPayment(payment) {
  if (!payment.learner_ids) return;
  let breakdown;
  try {
    breakdown = JSON.parse(payment.learner_breakdown || "null");
  } catch (e) {
    breakdown = null;
  }
  const learnerIds = JSON.parse(payment.learner_ids);
  const entryFor = (learnerId) => breakdown && breakdown.find((b) => b.id === learnerId);
  // Pre-existing rows (created before learner_breakdown existed) have no
  // stored per-learner amount — split the total evenly rather than skip
  // fan-out entirely, so old payments still surface in the per-instance
  // figures once this ships.
  const amountFor = (learnerId) => {
    const entry = entryFor(learnerId);
    if (entry) return entry.amountGHS;
    return Math.round((payment.amount / learnerIds.length) * 100) / 100;
  };
  const alreadyFanned = new Set(
    db
      .prepare("SELECT user_id FROM payments WHERE paystack_ref LIKE ?")
      .all(`${payment.paystack_ref}::%`)
      .map((r) => r.user_id)
  );
  const insert = db.prepare(
    `INSERT INTO payments (id, user_id, amount, type, method, status, paystack_ref, date, programme_id, class_id, learning_instance_id, learning_instance_academic_period_id)
     VALUES (?, ?, ?, ?, ?, 'successful', ?, datetime('now'), ?, ?, ?, ?)`
  );
  learnerIds.forEach((learnerId, idx) => {
    if (alreadyFanned.has(learnerId)) return;
    const learnerRow = db.prepare("SELECT class_id FROM users WHERE id = ?").get(learnerId);
    const classId = learnerRow ? learnerRow.class_id : null;
    const classRow = classId ? db.prepare("SELECT programme_id FROM classes WHERE id = ?").get(classId) : null;
    const programmeId = classRow ? classRow.programme_id : null;
    // Combined Registration + First Period Payment (see
    // utils/learningInstances.js's resolveCombinedPeriodCharge): this
    // learner's own charge was quoted against a specific Learning
    // Instance + period at registrationBreakdown() time — reuse that
    // exact pairing here rather than freshly re-resolving the class's
    // *currently* active instance, which could in principle have changed
    // between the charge and this fan-out (e.g. a delayed webhook) and
    // would otherwise silently stamp a period id alongside the wrong
    // instance id, making this row invisible to that period's payment
    // total. Every learner without a periodId (the normal, non-combined
    // case) keeps the exact same fresh-resolution behaviour as before.
    const entry = entryFor(learnerId);
    const periodId = entry && entry.periodId ? entry.periodId : null;
    // Root-cause fix (same one as routes/payments.js's combined-registration
    // charge above, which is what populates entry.learningInstanceId in the
    // first place): a class_id-only fallback leaves an Individual Course
    // learner's fanned-out row with learning_instance_id NULL, since that
    // participation structure never has a class_id. Falling back to the
    // learner's own primary enrollment (the same Run registrationBreakdown()
    // priced this charge against) keeps every existing classId-based Run
    // resolving exactly as before, while an Individual Course learner's
    // final payment row now still lands against their actual Run even on
    // this defensive "entry has no learningInstanceId" branch (e.g. a
    // pre-fix pending payment being fanned out after the fact).
    const learningInstanceId =
      entry && entry.learningInstanceId
        ? entry.learningInstanceId
        : classId
          ? getActiveInstanceIdForClass(classId)
          : getEnrolledLearningInstanceIdForLearner(learnerId);
    const rowType = periodId ? "period_payment" : payment.type;
    insert.run(
      uuid(),
      learnerId,
      amountFor(learnerId),
      rowType,
      payment.method,
      `${payment.paystack_ref}::${learnerId}`,
      programmeId,
      classId,
      learningInstanceId,
      periodId
    );
  });
}

// Registration-completion safety net (Issue #3, generalised in Issue #5):
// detects whether `learnerId`'s account has NEVER had a successful
// registration payment — i.e. its original registration charge failed
// (routes/payments.js "Charge Attempted"), the account/learner rows were
// still created (routes/auth.js), and this is the very first payment of
// ANY kind that has gone on to succeed for them — and if so, completes
// registration exactly as a first-attempt success would have.
//
// Detected from "this account has never had a successful registration
// payment", not merely from status === 'pending_payment' — status alone
// isn't a safe signal, since an admin can independently revert an
// already-registered account to 'pending_payment' via PATCH /:userId/status
// for a reason that has nothing to do with an unpaid registration (a hold,
// a dispute, etc). Checking payment history instead means an ordinary
// later payment on such an account is left exactly as the admin set it,
// while an account that truly never completed registration still gets
// recovered here. A learner's successful registration payment always
// lands on their own user_id either directly (single-account charge) or
// via fanOutCombinedRegistrationPayment's per-learner rows (a combined
// parent charge) — both carry type='registration', so this single check
// covers either origin.
//
// Callers must only invoke this for a payment that has already been
// recorded successful for `learnerId` — it doesn't check `payment` itself
// (a period payment, a monthly fee, a registration retry — whatever type
// of payment got this account its first-ever success is irrelevant, it
// still means "registration completes now").
//
// Idempotent/safe to call on every successful payment: a no-op for any
// account that's already active, or that never had a pending registration
// to begin with (learner is undefined/not pending_payment) — so a
// retried/duplicate callback, or an ordinary later payment on an
// already-registered account, always falls through to the caller's normal
// (non-recovery) handling instead.
function recoverRegistrationIfNeverCompleted(learnerId) {
  const learner = db.prepare("SELECT status FROM users WHERE id = ?").get(learnerId);
  const neverRegistered =
    learner &&
    learner.status === "pending_payment" &&
    !db.prepare("SELECT 1 FROM payments WHERE user_id = ? AND type IN ('registration', 'bootcamp') AND status = 'successful' LIMIT 1").get(learnerId);
  if (!neverRegistered) return false;

  db.prepare("UPDATE users SET status='active', payment_status='current', balance_owed_ghs=0 WHERE id=?").run(learnerId);
  db.prepare(
    "UPDATE programme_enrollments SET status='active', payment_status='current', updated_at=datetime('now') WHERE user_id=? AND is_primary=1"
  ).run(learnerId);
  // Enrollment Activation (v30) — same curriculum resolution every other
  // activation path in this file uses, so this "recovered" completion ends
  // up with exactly the same access a first-attempt success would have
  // granted.
  const primary = db
    .prepare("SELECT class_id, requested_course_ids, learning_instance_id FROM programme_enrollments WHERE user_id=? AND is_primary=1")
    .get(learnerId);
  if (primary) {
    let requestedCourseIds = [];
    try {
      requestedCourseIds = JSON.parse(primary.requested_course_ids || "[]");
    } catch (e) {
      requestedCourseIds = [];
    }
    activateEnrollmentCurriculum(learnerId, primary.class_id, requestedCourseIds, primary.learning_instance_id);
  }
  return true;
}

// Applies the effect of a successful payment to the account(s) it covers.
// `payment.learner_ids` (JSON array) is only set for combined multi-ward
// registration charges; otherwise falls back to the single payment.user_id,
// exactly matching the previous single-account behaviour.
function activateSuccessfulPayment(payment) {
  db.prepare("UPDATE payments SET status='successful' WHERE id=?").run(payment.id);

  // Period-specific payments (Phase 6) settle ONLY that period's own
  // requirement — computed on read directly from the payments table (see
  // utils/periodPayments.js) — and must never also flip the account's
  // global payment_status/balance_owed_ghs or its primary enrolment's
  // status, which mean something else entirely (overall registration/
  // monthly standing) and could otherwise be incorrectly marked "current"
  // by a payment that only covered one period's deposit — UNLESS this is
  // the account's registration-completion safety net firing (see
  // recoverRegistrationIfNeverCompleted above), in which case that's
  // exactly what should happen once.
  //
  // It IS, however, exactly the "a later term/semester's payment has been
  // made" trigger for auto-enrollment: with the payment now recorded
  // successful, sync this Run's period-scoped Course enrollments so the
  // learner is immediately assigned to whichever period(s) are now both
  // begun and paid for (see syncPeriodCourseEnrollments's own comment —
  // it independently re-checks "has this period begun" too, so this is
  // safe even if a payment for a not-yet-started period is made early).
  if (payment.learning_instance_academic_period_id) {
    recoverRegistrationIfNeverCompleted(payment.user_id);

    if (payment.learning_instance_id) {
      syncPeriodCourseEnrollments(payment.user_id, payment.learning_instance_id);
    }
    return;
  }

  fanOutCombinedRegistrationPayment(payment);

  // Additional-programme enrolment payment (routes/enrolments.js): only the
  // specific programme_enrollments row is activated. The account's primary
  // status/payment_status (and every other enrolment) is deliberately left
  // alone — this account may already be active on its original programme,
  // and that must keep meaning exactly what it meant before.
  if (payment.programme_enrollment_id) {
    const enrolment = db.prepare("SELECT user_id, class_id, requested_course_ids, learning_instance_id FROM programme_enrollments WHERE id = ?").get(payment.programme_enrollment_id);
    db.prepare(
      "UPDATE programme_enrollments SET status='active', payment_status='current', updated_at=datetime('now') WHERE id=?"
    ).run(payment.programme_enrollment_id);
    // Also update account status to active if pending_payment
    if (enrolment) {
      db.prepare("UPDATE users SET status='active', payment_status='current', balance_owed_ghs=0 WHERE id=? AND status='pending_payment'").run(enrolment.user_id);
      let requestedCourseIds = [];
      try {
        requestedCourseIds = JSON.parse(enrolment.requested_course_ids || "[]");
      } catch (e) {
        requestedCourseIds = [];
      }
      activateEnrollmentCurriculum(enrolment.user_id, enrolment.class_id, requestedCourseIds, enrolment.learning_instance_id);
    }
    return;
  }

  const targetIds = payment.learner_ids ? JSON.parse(payment.learner_ids) : [payment.user_id];
  const activate = db.prepare("UPDATE users SET status='active', payment_status='current', balance_owed_ghs=0 WHERE id=?");
  const markCurrent = db.prepare("UPDATE users SET payment_status='current', balance_owed_ghs=0 WHERE id=?");
  // Mirrors the same transition onto the account's PRIMARY programme_enrollments
  // row (its original placement, inserted at registration — routes/auth.js) so
  // "My Programmes" reflects reality instead of showing a paid, active account
  // stuck at pending_payment/unpaid forever. A no-op (0 rows affected) for any
  // account that predates this row existing, or that has none for some other
  // reason — never blocks the users-table update above.
  const activatePrimaryEnrollment = db.prepare(
    "UPDATE programme_enrollments SET status='active', payment_status='current', updated_at=datetime('now') WHERE user_id=? AND is_primary=1"
  );
  const markPrimaryEnrollmentCurrent = db.prepare(
    "UPDATE programme_enrollments SET payment_status='current', updated_at=datetime('now') WHERE user_id=? AND is_primary=1"
  );
  // Enrollment Activation (v30) — only relevant for a registration payment
  // (a recurring "monthly" payment activates nothing new curriculum-wise;
  // the learner was already granted their curriculum on the registration
  // payment that first made them active). Read before the UPDATEs above
  // run — class_id/requested_course_ids aren't touched by them either way.
  const primaryEnrolmentForActivation = db.prepare(
    "SELECT class_id, requested_course_ids, learning_instance_id FROM programme_enrollments WHERE user_id=? AND is_primary=1"
  );
  targetIds.forEach((id) => {
    if (payment.type === "registration" || payment.type === "bootcamp") {
      activate.run(id);
      activatePrimaryEnrollment.run(id);
      const primary = primaryEnrolmentForActivation.get(id);
      if (primary) {
        let requestedCourseIds = [];
        try {
          requestedCourseIds = JSON.parse(primary.requested_course_ids || "[]");
        } catch (e) {
          requestedCourseIds = [];
        }
        activateEnrollmentCurriculum(id, primary.class_id, requestedCourseIds, primary.learning_instance_id);
      }
    } else {
      // Registration-completion safety net (Issue #5): a non-registration
      // payment (e.g. "Pay this month's fee") is normally made by an
      // account that's ALREADY active, which is why this branch otherwise
      // only marks payment_status current. But when the ward's Programme
      // has no academic-period structure, this generic fee payment is the
      // ONLY payment route the Parent Payments UI ever offers a
      // pending_payment ward — there is no "retry registration" action in
      // the portal. So this can also be the very first payment that ever
      // succeeds for an account whose original registration charge failed
      // (see recoverRegistrationIfNeverCompleted above, the exact same
      // safety net the period-payment branch uses). If that fires, it
      // already brings payment_status/balance_owed_ghs current as part of
      // full activation, so the plain markCurrent below is skipped for
      // this id to avoid a redundant (harmless, but pointless) second
      // write.
      const recovered = recoverRegistrationIfNeverCompleted(id);
      if (!recovered) {
        markCurrent.run(id);
        markPrimaryEnrollmentCurrent.run(id);
      }
    }
  });
}

module.exports = { activateSuccessfulPayment, fanOutCombinedRegistrationPayment, recoverRegistrationIfNeverCompleted };
