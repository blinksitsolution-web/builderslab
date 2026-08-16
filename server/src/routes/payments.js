const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requireSelfParentOrStaff, requireInAdminScope } = require("../middleware/auth");
const { campusScopeFor, isTargetInAdminScope } = require("../utils/rbac");
const paystack = require("../utils/paystack");
const { currentFees, registrationBreakdown, getProgrammeFee, getOperationalGroupIdForLearner, PROGRAMME_FEE_TYPES } = require("../utils/fees");
const { activateSuccessfulPayment } = require("../utils/paymentActivation");
const { getActiveInstanceIdForProgramme, getActiveInstanceIdForClass, getLearningInstanceById, getAcademicPeriodById, getLearnerLearningInstances, activateEnrollmentCurriculum, resolveCombinedPeriodCharge, getEffectivePeriodPaymentRequirement, getEnrolledLearningInstanceIdForLearner } = require("../utils/learningInstances");
const { getPeriodPaymentStatus } = require("../utils/periodPayments");

const router = express.Router();

const PERIOD_BASED_ACADEMIC_STRUCTURES = new Set(["term", "semester"]);
const MONTHLY_BILLING_BLOCKED_MESSAGE =
  "Monthly billing is not available for this Learning Instance. Please use the applicable academic-period payment.";

// Resolves the Learning Instance that governs billing for this learner,
// preferring the primary programme_enrollment's run over a freshly
// re-resolved "active" instance (same precedence as registration/payment
// scoping elsewhere in this file).
function resolveBillingLearningInstance(learner, { programmeId = null, classId = null, programmeEnrollmentId = null, learningInstanceId = null } = {}) {
  if (!learner) return null;
  if (learningInstanceId) {
    const inst = getLearningInstanceById(learningInstanceId);
    if (inst) return inst;
  }
  if (programmeEnrollmentId) {
    const pe = db.prepare("SELECT learning_instance_id FROM programme_enrollments WHERE id = ?").get(programmeEnrollmentId);
    if (pe && pe.learning_instance_id) {
      const inst = getLearningInstanceById(pe.learning_instance_id);
      if (inst) return inst;
    }
  }
  const primary = db
    .prepare("SELECT learning_instance_id, class_id, programme_id FROM programme_enrollments WHERE user_id = ? AND is_primary = 1 LIMIT 1")
    .get(learner.id);
  if (primary && primary.learning_instance_id) {
    return getLearningInstanceById(primary.learning_instance_id);
  }
  const resolvedClassId = classId || learner.class_id || (primary && primary.class_id) || null;
  let resolvedProgrammeId = programmeId || (primary && primary.programme_id) || null;
  if (!resolvedProgrammeId && resolvedClassId) {
    const cls = db.prepare("SELECT programme_id FROM classes WHERE id = ?").get(resolvedClassId);
    resolvedProgrammeId = cls ? cls.programme_id : null;
  }
  const instanceId = resolvedProgrammeId
    ? getActiveInstanceIdForProgramme(resolvedProgrammeId)
    : resolvedClassId
      ? getActiveInstanceIdForClass(resolvedClassId)
      : null;
  return instanceId ? getLearningInstanceById(instanceId) : null;
}

function usesPeriodBasedBilling(instance) {
  return !!(instance && PERIOD_BASED_ACADEMIC_STRUCTURES.has(instance.academicStructure));
}

function getMonthlyBillingBlockReason(learner, context = {}) {
  return usesPeriodBasedBilling(resolveBillingLearningInstance(learner, context)) ? MONTHLY_BILLING_BLOCKED_MESSAGE : null;
}

function sumPeriodOutstandingGHS(learnerId) {
  let total = 0;
  getLearnerLearningInstances(learnerId).forEach((instance) => {
    (instance.academicPeriods || []).forEach((period) => {
      const status = getPeriodPaymentStatus(learnerId, instance, period);
      if (status.outstandingGHS > 0) total += status.outstandingGHS;
    });
  });
  return Math.round(total * 100) / 100;
}

// Authorization boundary for GET /:reference/verify — there's no :userId
// param on this route (only a Paystack reference), so requireSelfParentOrStaff
// doesn't apply directly; this mirrors the same ownership model it encodes,
// extended to the two payment shapes middleware/auth.js's helper doesn't see:
// a combined parent charge (payment.user_id is the paying parent;
// payment.learner_ids lists every covered ward) and a payment placed
// directly on a learner's own account by their parent (payment.user_id is
// the learner; the parent isn't literally the payer field, but is still
// entitled to check it — same as requireSelfParentOrStaff's own child check).
// Instructors/admins keep the same staff bypass every other ownership check
// in this codebase grants them.
function canViewPayment(user, payment) {
  if (user.role === "instructor" || user.role === "admin") return true;
  if (user.id === payment.user_id) return true;
  let learnerIds = [];
  try {
    learnerIds = payment.learner_ids ? JSON.parse(payment.learner_ids) : [];
  } catch (e) {
    learnerIds = [];
  }
  if (learnerIds.includes(user.id)) return true;
  if (user.role === "parent") {
    const isMyChild = (id) => db.prepare("SELECT id FROM users WHERE id = ? AND parent_id = ?").get(id, user.id);
    if (isMyChild(payment.user_id)) return true;
    if (learnerIds.some(isMyChild)) return true;
  }
  return false;
}

router.post("/:userId/initiate", requireAuth, requireSelfParentOrStaff("userId"), requireInAdminScope("userId"), async (req, res) => {
  const { type, network, momoNumber } = req.body;
  // Explicit payment-method boundary (additive): MOBILE_MONEY is the
  // default, matching every existing caller that has never sent `method`
  // (PayMonthlyFeeModal, ParentPaymentsPage, the pre-international
  // RegisterPage build, etc.) byte-for-byte. CARD is the new hosted-
  // checkout path. Never inferred from country/anything else server-side
  // — the client states explicitly which one it's asking for.
  const rawMethod = req.body.method;
  const paymentMethod = rawMethod === undefined || rawMethod === null ? "MOBILE_MONEY" : rawMethod;
  if (paymentMethod !== "MOBILE_MONEY" && paymentMethod !== "CARD") {
    return res.status(400).json({ error: "method must be MOBILE_MONEY or CARD." });
  }
  const account = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.userId);
  if (!account) return res.status(404).json({ error: "Account not found." });
  // Ghana Mobile Money's number-format gate — unchanged, just now scoped
  // to the method it actually applies to. A CARD request has no
  // momoNumber at all, and must not be rejected for lacking one.
  if (paymentMethod === "MOBILE_MONEY" && !/^0\d{9}$/.test(momoNumber || "")) {
    return res.status(400).json({ error: "Enter a valid 10-digit Mobile Money number." });
  }
  // Card charges never carry a Ghana MoMo number/network — persisted as
  // such regardless of what a client might send alongside `method: "CARD"`.
  const paymentMethodLabel = paymentMethod === "CARD" ? "Card" : `${network} MoMo`;
  const paymentMomoNumber = paymentMethod === "CARD" ? null : momoNumber;
  // Paystack's hosted checkout always returns the customer here; Paystack
  // appends its own ?reference=&trxref= query params, so nothing else
  // needs to be encoded into the URL itself. Same APP_URL convention as
  // the password-reset link in routes/users.js — never hardcoded.
  const cardCallbackUrl = `${process.env.APP_URL || ""}/app/register`;

  // Parent registering one or more wards: ONE combined Paystack charge
  // covering every learner still pending registration payment, with the
  // multi-ward discount (2nd+ child) applied where applicable. Preserves
  // the same charge/OTP/dev-fallback flow as the single-account path below.
  if (type === "registration" && account.role === "parent") {
    const learners = db
      .prepare("SELECT * FROM users WHERE parent_id = ? AND role = 'learner' AND status = 'pending_payment' ORDER BY joined_date ASC, rowid ASC")
      .all(account.id);
    if (!learners.length) return res.status(400).json({ error: "No learner is pending registration payment." });

    // Root-cause fix: a class_id is how a Structured (School Club/Other)
    // learner's governing Learning Instance has always been resolved here,
    // but an Individual Course learner (e.g. Kids STEM's Builders' Lab
    // "Individual Course" offerings) has no class_id at all — they're
    // enrolled straight onto a Learning Instance via their
    // programme_enrollments row (see routes/auth.js POST /register). Without
    // this, registrationBreakdown() below had NO way to find that learner's
    // actual Learning Instance, so it fell all the way through to the
    // legacy site-wide Fees > Registration default (bypassing the Run's own
    // registration_fee_ghs entirely) and never detected Combine Registration
    // with First Period — the charge and the Period Payments table then
    // silently disagreed. Resolving each learner's own primary enrollment's
    // learning_instance_id here (the same lookup utils/fees.js's
    // resolveRunContext already does for a persisted learner "with an id")
    // means classId-based Runs are completely unaffected (classId still
    // takes precedence in resolveRunContext) while Individual Course
    // learners now resolve to the exact Run they actually registered into.
    const { breakdown, totalGHS } = registrationBreakdown(
      learners.map((l) => ({
        name: l.name,
        campus: l.campus,
        schoolName: l.school_name,
        ownRoboticsKit: l.own_robotics_kit,
        classId: l.class_id,
        learningInstanceId: l.class_id ? null : getEnrolledLearningInstanceIdForLearner(l.id),
        sponsored: !!l.sponsor_id,
      }))
    );
    const reference = `DTL-${uuid()}`;
    const learnerIds = learners.map((l) => l.id);
    // Captured once, at charge time, so utils/paymentActivation.js can fan
    // this single combined charge out into one payments row PER learner
    // (each with its own amount, Programme/Class and Learning Instance)
    // the moment it succeeds — without it, a parent's combined
    // registration payment was invisible to every per-learner/per-
    // Learning-Instance figure in the Admin Portal.
    const learnerBreakdown = learners.map((l, idx) => ({
      id: l.id,
      amountGHS: breakdown[idx].amountGHS,
      periodId: breakdown[idx].periodId || null,
      learningInstanceId: breakdown[idx].learningInstanceId || null,
    }));

    // This one payment row can cover several wards, each potentially in a
    // different Programme/Class (and therefore a different Learning
    // Instance) — there's no single correct learning_instance_id to store
    // on the combined charge itself. Each ward's own primary
    // programme_enrollments row already carries its own
    // learning_instance_id (set at registration/enrolment time), which is
    // where per-learner run-scoping lives; this row stays unattached by
    // design rather than guessing one learner's instance for all of them.
    // (Per-learner Programme/Instance scoping instead comes from the
    // fanned-out rows created on success — see learner_breakdown above.)
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, method, momo_number, status, paystack_ref, date, learner_ids, learner_breakdown)
       VALUES (?, ?, ?, 'registration', ?, ?, 'pending', ?, datetime('now'), ?, ?)`
    ).run(uuid(), account.id, totalGHS, paymentMethodLabel, paymentMomoNumber, reference, JSON.stringify(learnerIds), JSON.stringify(learnerBreakdown));

    try {
      if (paymentMethod === "CARD") {
        const data = await paystack.initiateCardCharge({ email: account.email, amountGHS: totalGHS, reference, callbackUrl: cardCallbackUrl });
        return res.json({ ok: true, reference, method: "CARD", status: "pending", authorizationUrl: data.authorization_url, breakdown, totalGHS });
      }
      const data = await paystack.initiateMobileMoneyCharge({
        email: account.email,
        amountGHS: totalGHS,
        phone: momoNumber,
        network,
        reference,
      });
      return res.json({ ok: true, reference, status: data.status, displayText: data.display_text || null, breakdown, totalGHS });
    } catch (e) {
      const noKeyConfigured = e.message.includes("PAYSTACK_SECRET_KEY is not configured");
      if (noKeyConfigured && process.env.NODE_ENV !== "production") {
        const payment = db.prepare("SELECT * FROM payments WHERE paystack_ref = ?").get(reference);
        activateSuccessfulPayment(payment);
        console.warn(`⚠️  DEV MODE: no PAYSTACK_SECRET_KEY set — auto-completed payment ${reference} without calling Paystack.`);
        return res.json({ ok: true, reference, method: paymentMethod, status: "success", displayText: "Dev mode: payment auto-completed (no Paystack key configured).", authorizationUrl: null, breakdown, totalGHS });
      }
      db.prepare("UPDATE payments SET status='failed' WHERE paystack_ref=?").run(reference);
      return res.status(502).json({ error: e.message });
    }
  }

  // Period-specific payment (Phase 6) — settles the outstanding balance of
  // a specific academic period's payment requirement (full fee or
  // deposit/installment, per how the admin configured that period — see
  // utils/learningInstances.js's setPeriodPaymentRequirement). Charges
  // only the remaining outstanding amount (requiredAmountGHS minus
  // whatever's already been paid toward this exact learner + Learning
  // Instance + period), so a learner topping up a deposit already paid
  // isn't asked to pay the full amount again, and a learner who's already
  // fully paid can't be charged a second time for the same period.
  if (req.body.learningInstanceAcademicPeriodId) {
    const instance = getLearningInstanceById(req.body.learningInstanceId || "");
    if (!instance) return res.status(400).json({ error: "learningInstanceId does not match a known Learning Instance." });
    const period = getAcademicPeriodById(instance.id, req.body.learningInstanceAcademicPeriodId);
    if (!period) return res.status(400).json({ error: "This academic period doesn't belong to the given Learning Instance." });
    const requirement = getEffectivePeriodPaymentRequirement(instance, period);
    if (!requirement.mode || !requirement.requiredAmountGHS) {
      return res.status(400).json({ error: "This academic period has no payment requirement configured." });
    }
    const paymentStatus = getPeriodPaymentStatus(account.id, instance, period);
    if (paymentStatus.satisfied) {
      return res.status(409).json({ error: "This academic period's payment requirement is already satisfied." });
    }
    const amount = paymentStatus.outstandingGHS;
    const reference = `DTL-${uuid()}`;
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, method, momo_number, status, paystack_ref, date, learning_instance_id, learning_instance_academic_period_id)
       VALUES (?, ?, ?, 'period_payment', ?, ?, 'pending', ?, datetime('now'), ?, ?)`
    ).run(uuid(), account.id, amount, paymentMethodLabel, paymentMomoNumber, reference, instance.id, period.id);

    try {
      const chargeEmail = account.email.includes("@learners.") ? `billing+${account.id}@dalijaytechhub.online` : account.email;
      if (paymentMethod === "CARD") {
        const data = await paystack.initiateCardCharge({ email: chargeEmail, amountGHS: amount, reference, callbackUrl: cardCallbackUrl });
        return res.json({ ok: true, reference, method: "CARD", status: "pending", authorizationUrl: data.authorization_url, totalGHS: amount });
      }
      const data = await paystack.initiateMobileMoneyCharge({ email: chargeEmail, amountGHS: amount, phone: momoNumber, network, reference });
      return res.json({ ok: true, reference, status: data.status, displayText: data.display_text || null, totalGHS: amount });
    } catch (e) {
      const noKeyConfigured = e.message.includes("PAYSTACK_SECRET_KEY is not configured");
      if (noKeyConfigured && process.env.NODE_ENV !== "production") {
        const payment = db.prepare("SELECT * FROM payments WHERE paystack_ref = ?").get(reference);
        activateSuccessfulPayment(payment);
        console.warn(`⚠️  DEV MODE: no PAYSTACK_SECRET_KEY set — auto-completed payment ${reference} without calling Paystack.`);
        return res.json({ ok: true, reference, method: paymentMethod, status: "success", displayText: "Dev mode: payment auto-completed (no Paystack key configured).", authorizationUrl: null, totalGHS: amount });
      }
      db.prepare("UPDATE payments SET status='failed' WHERE paystack_ref=?").run(reference);
      return res.status(502).json({ error: e.message });
    }
  }

  // Additional-programme enrolment (existing account enrolling into a new
  // Programme without a new account — routes/enrolments.js POST /). Reuses
  // the exact same fee-resolution (registrationBreakdown) and Paystack
  // charge/OTP/dev-fallback flow as every other path here; the only
  // difference is the payment is tagged with programme_enrollment_id so
  // activateSuccessfulPayment() flips that specific enrolment (not the
  // account's primary status/payment_status) once it succeeds.
  if (req.body.programmeEnrollmentId) {
    const enrollment = db.prepare("SELECT * FROM programme_enrollments WHERE id = ?").get(req.body.programmeEnrollmentId);
    if (!enrollment || enrollment.user_id !== account.id) {
      return res.status(404).json({ error: "Enrolment not found." });
    }
    if (enrollment.status !== "pending_payment") {
      return res.status(409).json({ error: "This enrolment isn't awaiting payment." });
    }
    const { totalGHS } = registrationBreakdown([
      { name: account.name, campus: account.campus, schoolName: account.school_name, ownRoboticsKit: account.own_robotics_kit, classId: enrollment.class_id, sponsored: !!account.sponsor_id },
    ]);
    const reference = `DTL-${uuid()}`;
    // Same run this specific enrolment was tagged with (routes/enrolments.js
    // POST /), not re-resolved from "whatever's active right now" — the
    // payment must settle the run the learner actually enrolled into, even
    // if a different instance for the same Programme has since gone active.
    const paymentLearningInstanceId = enrollment.learning_instance_id || null;
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, method, momo_number, status, paystack_ref, date, programme_id, class_id, programme_enrollment_id, learning_instance_id)
       VALUES (?, ?, ?, 'registration', ?, ?, 'pending', ?, datetime('now'), ?, ?, ?, ?)`
    ).run(uuid(), account.id, totalGHS, paymentMethodLabel, paymentMomoNumber, reference, enrollment.programme_id, enrollment.class_id, enrollment.id, paymentLearningInstanceId);

    try {
      const chargeEmail = account.email.includes("@learners.") ? `billing+${account.id}@dalijaytechhub.online` : account.email;
      if (paymentMethod === "CARD") {
        const data = await paystack.initiateCardCharge({ email: chargeEmail, amountGHS: totalGHS, reference, callbackUrl: cardCallbackUrl });
        return res.json({ ok: true, reference, method: "CARD", status: "pending", authorizationUrl: data.authorization_url, totalGHS });
      }
      const data = await paystack.initiateMobileMoneyCharge({
        email: chargeEmail,
        amountGHS: totalGHS,
        phone: momoNumber,
        network,
        reference,
      });
      return res.json({ ok: true, reference, status: data.status, displayText: data.display_text || null, totalGHS });
    } catch (e) {
      const noKeyConfigured = e.message.includes("PAYSTACK_SECRET_KEY is not configured");
      if (noKeyConfigured && process.env.NODE_ENV !== "production") {
        const payment = db.prepare("SELECT * FROM payments WHERE paystack_ref = ?").get(reference);
        activateSuccessfulPayment(payment);
        console.warn(`⚠️  DEV MODE: no PAYSTACK_SECRET_KEY set — auto-completed payment ${reference} without calling Paystack.`);
        return res.json({ ok: true, reference, method: paymentMethod, status: "success", displayText: "Dev mode: payment auto-completed (no Paystack key configured).", authorizationUrl: null, totalGHS });
      }
      db.prepare("UPDATE payments SET status='failed' WHERE paystack_ref=?").run(reference);
      return res.status(502).json({ error: e.message });
    }
  }

  // Existing single-account path — adult learners, and per-child monthly/
  // termly payments. Unchanged workflow; currentFees() now applies the
  // multi-ward monthly discount automatically for 2nd+ children.
  const learner = account;
  const FEES = currentFees(learner);
  // Course/Workshop/Bootcamp fees are resolved per the learner's programme
  // (via their Learning Group) rather than the fixed Kids/Adult FEES object
  // above — this is what lets Adult Professional and Corporate/Bootcamp
  // learners pay a rate configured for their specific programme.
  const learnerProgrammeId = learner.class_id
    ? (db.prepare("SELECT programme_id FROM classes WHERE id = ?").get(learner.class_id) || {}).programme_id
    : null;
  const billingInstance = resolveBillingLearningInstance(learner, {
    programmeId: learnerProgrammeId,
    classId: learner.class_id,
  });
  const learningInstanceId = billingInstance ? billingInstance.id : null;
  let amount = FEES[type];
  if (amount == null && PROGRAMME_FEE_TYPES.includes(type)) {
    amount = getProgrammeFee(type, learnerProgrammeId, learner.class_id, getOperationalGroupIdForLearner(learner), learningInstanceId);
  }
  if (amount == null) {
    return res.status(400).json({ error: `type must be one of: registration, monthly, ${PROGRAMME_FEE_TYPES.join(", ")}.` });
  }

  if (type === "monthly") {
    const monthlyBlock = getMonthlyBillingBlockReason(learner, {
      programmeId: learnerProgrammeId,
      classId: learner.class_id,
    });
    if (monthlyBlock) {
      return res.status(400).json({ error: monthlyBlock });
    }
  }

  const reference = `DTL-${uuid()}`;

  // Combined Registration + First Period Payment — see
  // utils/learningInstances.js's resolveCombinedPeriodCharge. Only ever
  // applies to a registration charge; every other type (monthly, termly,
  // course, workshop, bootcamp) is completely unaffected.
  let periodId = null;
  // The type actually written to the payments row. Normally identical to
  // the request's own `type`, EXCEPT for a combined-mode charge: storing
  // that as 'registration' would make activateSuccessfulPayment's
  // recoverRegistrationIfNeverCompleted() see this exact row (already
  // marked 'successful' by that point) as proof registration was already
  // completed, and skip activating the account entirely. Storing it as
  // 'period_payment' — the same type every other period-scoped payment in
  // this codebase already uses — sidesteps that and is also the more
  // honest label: no separate Registration Fee is ever charged in
  // combined mode, so this row genuinely is a period payment.
  let storedType = type;
  if (type === "registration" && learningInstanceId) {
    const instance = getLearningInstanceById(learningInstanceId);
    const combined = instance ? resolveCombinedPeriodCharge(instance) : null;
    if (combined) {
      amount = combined.requiredAmountGHS;
      periodId = combined.periodId;
      storedType = "period_payment";
    }
  }

  db.prepare(
    `INSERT INTO payments (id, user_id, amount, type, method, momo_number, status, paystack_ref, date, programme_id, class_id, learning_instance_id, learning_instance_academic_period_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'), ?, ?, ?, ?)`
  ).run(uuid(), learner.id, amount, storedType, paymentMethodLabel, paymentMomoNumber, reference, learnerProgrammeId || null, learner.class_id || null, learningInstanceId, periodId);

  try {
    const chargeEmail = learner.email.includes("@learners.") ? `billing+${learner.id}@dalijaytechhub.online` : learner.email;
    if (paymentMethod === "CARD") {
      const data = await paystack.initiateCardCharge({ email: chargeEmail, amountGHS: amount, reference, callbackUrl: cardCallbackUrl });
      return res.json({ ok: true, reference, method: "CARD", status: "pending", authorizationUrl: data.authorization_url });
    }
    const data = await paystack.initiateMobileMoneyCharge({
      email: chargeEmail,
      amountGHS: amount,
      phone: momoNumber,
      network,
      reference,
    });
    res.json({ ok: true, reference, status: data.status, displayText: data.display_text || null });
  } catch (e) {
    // DEV-ONLY FALLBACK: if no real Paystack key is configured and we're not
    // in production, auto-complete the payment so you can test the whole
    // portal locally without a Paystack account. This branch never runs in
    // production (NODE_ENV=production), and never runs once a real key is set.
    const noKeyConfigured = e.message.includes("PAYSTACK_SECRET_KEY is not configured");
    if (noKeyConfigured && process.env.NODE_ENV !== "production") {
      const payment = db.prepare("SELECT * FROM payments WHERE paystack_ref = ?").get(reference);
      activateSuccessfulPayment(payment);
      console.warn(`⚠️  DEV MODE: no PAYSTACK_SECRET_KEY set — auto-completed payment ${reference} without calling Paystack.`);
      return res.json({ ok: true, reference, method: paymentMethod, status: "success", displayText: "Dev mode: payment auto-completed (no Paystack key configured).", authorizationUrl: null });
    }
    db.prepare("UPDATE payments SET status='failed' WHERE paystack_ref=?").run(reference);
    res.status(502).json({ error: e.message });
  }
});

router.post("/otp", requireAuth, async (req, res) => {
  const { reference, otp } = req.body;
  try {
    const data = await paystack.submitOtp({ reference, otp });
    res.json({ ok: true, status: data.status });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Manual fallback: poll this after redirect/otp if you don't have a public
// webhook URL configured yet (e.g. while developing on localhost).
router.get("/:reference/verify", requireAuth, async (req, res) => {
  const payment = db.prepare("SELECT * FROM payments WHERE paystack_ref = ?").get(req.params.reference);
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (!canViewPayment(req.user, payment)) {
    return res.status(403).json({ error: "You don't have permission to view this payment." });
  }
  try {
    const data = await paystack.verifyTransaction(req.params.reference);
    if (data.status === "success" && payment.status !== "successful") activateSuccessfulPayment(payment);
    res.json({ status: data.status });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get("/user/:userId", requireAuth, requireSelfParentOrStaff("userId"), requireInAdminScope("userId"), (req, res) => {
  const rows = db.prepare(
    `SELECT p.*, pr.name as programmeName, li.name as learningInstanceName, li.status as learningInstanceStatus
     FROM payments p
     LEFT JOIN programmes pr ON pr.id = p.programme_id
     LEFT JOIN learning_instances li ON li.id = p.learning_instance_id
     WHERE p.user_id = ? ORDER BY p.date DESC`
  ).all(req.params.userId);
  res.json({
    payments: rows.map((r) => ({
      ...r,
      // Phase 10 — resolved live (not stored redundantly on the row), same
      // convention as certificates.js's academicPeriod field, so a
      // since-renamed period still shows its current name here too. null
      // for every pre-Phase-9 payment or one not scoped to a period —
      // those remain valid, undated-by-period payment rows, not an error.
      academicPeriodName:
        r.learning_instance_id && r.learning_instance_academic_period_id
          ? (getAcademicPeriodById(r.learning_instance_id, r.learning_instance_academic_period_id) || {}).name || null
          : null,
    })),
  });
});

// Phase 10 — self-service view of every period payment requirement that
// applies to THIS learner, for the learner/parent Payments UI (the
// existing per-period status lookup at
// GET /learning-instances/:id/academic-periods/:periodId/learners/:learnerId/payment-status
// is staff-permission-gated and requires already knowing the instance/
// period ids up front). Reuses getLearnerLearningInstances (grades.js's
// transcript-options endpoint) to find which of the learner's own Learning
// Instances have an academic structure, then getPeriodPaymentStatus
// (utils/periodPayments.js — the exact same function the enforcement path
// and the admin endpoint both use) for each configured period. Periods
// with no payment requirement configured are included with
// mode: null / satisfied: true, same "don't invent a requirement" rule
// getPeriodPaymentStatus already encodes, so the UI can still label them
// (e.g. "no payment required") without a separate branch.
router.get("/:userId/period-status", requireAuth, requireSelfParentOrStaff("userId"), requireInAdminScope("userId"), (req, res) => {
  const learner = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.userId);
  if (!learner) return res.status(404).json({ error: "Account not found." });
  const results = [];
  getLearnerLearningInstances(req.params.userId).forEach((instance) => {
    (instance.academicPeriods || []).forEach((period) => {
      results.push({
        learningInstance: { id: instance.id, name: instance.name, status: instance.status },
        academicPeriod: { id: period.id, name: period.name, sequence: period.sequence },
        ...getPeriodPaymentStatus(req.params.userId, instance, period),
      });
    });
  });
  res.json({ periodPayments: results });
});

// Admin ledger — full payment history, filterable by learner/class/campus/
// month/type so the admin can narrow down the full payments list without
// scrolling through every record.
router.get("/", requireAuth, requireRole("admin"), (req, res) => {
  const { learnerId, classId, campus, month, type, offeringTypeId, programmeId, learningInstanceId, learningInstanceScope } = req.query;
  // A parent's combined multi-ward registration charge (learner_ids set)
  // is kept only as the Paystack-reference-matching record for the
  // webhook/verify/OTP flow — once successful it's fanned out (see
  // utils/paymentActivation.js) into one row PER learner, which is what
  // carries the real per-learner amount/Programme/Learning Instance.
  // Excluded here so the ledger — and any total computed from it, e.g.
  // Admin Overview's "Total collected" KPI — never double-counts the same
  // money once as the combined charge and again as each learner's share.
  let sql = `SELECT p.*, u.name as learnerName, u.campus as learnerCampus, u.is_adult as learnerIsAdult, c.name as learnerClassName,
                    li.name as learningInstanceName, li.status as learningInstanceStatus
             FROM payments p
             JOIN users u ON u.id = p.user_id
             LEFT JOIN classes c ON c.id = u.class_id
             LEFT JOIN programmes pr ON pr.id = p.programme_id
             LEFT JOIN learning_instances li ON li.id = p.learning_instance_id
             WHERE p.learner_ids IS NULL`;
  const params = [];
  if (learnerId) { sql += " AND p.user_id = ?"; params.push(learnerId); }
  if (classId) { sql += " AND u.class_id = ?"; params.push(classId); }
  // Campus Administrators are hard-scoped to their own campus regardless
  // of what (if anything) the client passed as ?campus= — a scoped admin
  // must never be able to widen or redirect their own view by supplying a
  // different campus query param (utils/rbac.js campusScopeFor).
  const scope = campusScopeFor(req.user);
  if (scope != null) {
    sql += " AND u.campus = ?"; params.push(scope);
  } else if (campus) {
    sql += " AND u.campus = ?"; params.push(campus);
  }
  if (month) { sql += " AND p.payment_month = ?"; params.push(month); }
  if (type) { sql += " AND p.type = ?"; params.push(type); }
  // Learning Instance / Programme / Offering Type scoping — opt-in, same
  // pattern as GET /api/users above: only applied when explicitly
  // requested, so every other existing caller of this endpoint is
  // unaffected. `payments.programme_id`/`learning_instance_id` were
  // populated at write time by the Enrolments/Payments integration
  // milestone (see FIX_NOTES_learning_instance_integration.md) — reused
  // directly here, not recomputed.
  if (offeringTypeId) { sql += " AND pr.offering_type_id = ?"; params.push(offeringTypeId); }
  if (programmeId) { sql += " AND p.programme_id = ?"; params.push(programmeId); }
  if (learningInstanceId) {
    sql += " AND p.learning_instance_id = ?";
    params.push(learningInstanceId);
  } else if (learningInstanceScope === "active") {
    sql += " AND p.learning_instance_id IN (SELECT id FROM learning_instances WHERE status = 'active')";
  }
  sql += " ORDER BY p.date DESC";
  const rows = db.prepare(sql).all(...params);
  res.json({
    payments: rows.map((r) => ({
      ...r,
      // Phase 10 — same live-resolved field as GET /user/:userId, so the
      // Admin Payments ledger can also show which academic period a
      // period-scoped payment settled.
      academicPeriodName:
        r.learning_instance_id && r.learning_instance_academic_period_id
          ? (getAcademicPeriodById(r.learning_instance_id, r.learning_instance_academic_period_id) || {}).name || null
          : null,
    })),
  });
});

// Admin: one row per learner/adult learner with amount paid, amount owed,
// last payment date/month and type — the accounting overview table.
// Reuses the same payments + users/classes data as the ledger above.
router.get("/overview", requireAuth, requireRole("admin"), (req, res) => {
  const { classId, campus, offeringTypeId, programmeId, learningInstanceId, learningInstanceScope } = req.query;
  // The per-learner "amount paid" / "last payment" figures must reflect the
  // SAME scope used to decide which learners appear at all — otherwise a
  // filtered view shows the right population with wrong (all-time,
  // all-instance) numbers, which is exactly the "statistic didn't update
  // with the filter" bug this fixes. Building one shared payments-scope
  // SQL fragment and reusing it in every subquery keeps that consistent
  // instead of each subquery re-deciding its own scope.
  let paymentScopeSql = "p.user_id = u.id AND p.status = 'successful'";
  const paymentScopeParams = [];
  if (offeringTypeId) {
    paymentScopeSql += " AND p.programme_id IN (SELECT id FROM programmes WHERE offering_type_id = ?)";
    paymentScopeParams.push(offeringTypeId);
  }
  if (programmeId) { paymentScopeSql += " AND p.programme_id = ?"; paymentScopeParams.push(programmeId); }
  if (learningInstanceId) {
    paymentScopeSql += " AND p.learning_instance_id = ?";
    paymentScopeParams.push(learningInstanceId);
  } else if (learningInstanceScope === "active") {
    paymentScopeSql += " AND p.learning_instance_id IN (SELECT id FROM learning_instances WHERE status = 'active')";
  }
  let sql = `SELECT u.id, u.name, u.campus, u.class_id, cl.name as className, u.is_adult, u.student_code,
               u.payment_status, u.balance_owed_ghs as balanceOwedGHS,
               COALESCE((SELECT SUM(amount) FROM payments p WHERE ${paymentScopeSql} AND p.currency = 'GHS'), 0) as totalPaidGHS,
               (SELECT date FROM payments p WHERE ${paymentScopeSql} ORDER BY date DESC LIMIT 1) as lastPaymentDate,
               (SELECT payment_month FROM payments p WHERE ${paymentScopeSql} ORDER BY date DESC LIMIT 1) as lastPaymentMonth,
               (SELECT type FROM payments p WHERE ${paymentScopeSql} ORDER BY date DESC LIMIT 1) as lastPaymentType
             FROM users u
             LEFT JOIN classes cl ON cl.id = u.class_id
             WHERE u.role = 'learner'`;
  const params = [...paymentScopeParams, ...paymentScopeParams, ...paymentScopeParams, ...paymentScopeParams];
  if (classId) { sql += " AND u.class_id = ?"; params.push(classId); }
  // Same hard campus scope override as GET / above.
  const scope = campusScopeFor(req.user);
  if (scope != null) {
    sql += " AND u.campus = ?"; params.push(scope);
  } else if (campus) {
    sql += " AND u.campus = ?"; params.push(campus);
  }
  // Same opt-in Learning Instance / Programme / Offering Type scoping as
  // GET / above and GET /api/users — this endpoint is learner-only already
  // (WHERE u.role = 'learner'), so no role carve-out is needed here.
  if (offeringTypeId || programmeId || learningInstanceId || learningInstanceScope) {
    let sub = `EXISTS (
      SELECT 1 FROM programme_enrollments pe
      JOIN programmes pr ON pr.id = pe.programme_id
      WHERE pe.user_id = u.id AND pe.status IN ('active','pending_payment')`;
    const subParams = [];
    if (offeringTypeId) { sub += " AND pr.offering_type_id = ?"; subParams.push(offeringTypeId); }
    if (programmeId) { sub += " AND pe.programme_id = ?"; subParams.push(programmeId); }
    if (learningInstanceId) {
      sub += " AND pe.learning_instance_id = ?";
      subParams.push(learningInstanceId);
    } else if (learningInstanceScope === "active") {
      sub += " AND pe.learning_instance_id IN (SELECT id FROM learning_instances WHERE status = 'active')";
    }
    sub += ")";
    sql += ` AND ${sub}`;
    params.push(...subParams);
  }
  sql += " ORDER BY u.name ASC";
  const rows = db.prepare(sql).all(...params);
  res.json({ learners: rows });
});

// Admin: learners with outstanding obligations, respecting each learner's
// billing model — monthly arrears for legacy/monthly runs; period
// outstanding totals for term/semester runs (utils/periodPayments.js).
router.get("/defaulters", requireAuth, requireRole("admin"), (req, res) => {
  const FEES = currentFees();
  const scope = campusScopeFor(req.user);
  let sql = `SELECT u.id, u.name, u.campus, u.status, u.payment_status, u.class_id, u.parent_id, p.name as parentName, p.phone as parentPhone
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
       WHERE u.role = 'learner' AND u.status != 'graduated'`;
  const params = [];
  if (scope != null) { sql += " AND u.campus = ?"; params.push(scope); }
  const rows = db.prepare(sql).all(...params);
  const defaulters = [];
  let monthlyArrearsGHS = 0;
  let periodArrearsGHS = 0;
  rows.forEach((row) => {
    const learner = db.prepare("SELECT * FROM users WHERE id = ?").get(row.id);
    const instance = resolveBillingLearningInstance(learner);
    if (usesPeriodBasedBilling(instance)) {
      const periodOutstandingGHS = sumPeriodOutstandingGHS(learner.id);
      if (periodOutstandingGHS > 0) {
        defaulters.push({ ...row, billingModel: "period", periodOutstandingGHS });
        periodArrearsGHS += periodOutstandingGHS;
      }
      return;
    }
    if (learner.payment_status !== "current") {
      defaulters.push({ ...row, billingModel: "monthly" });
      monthlyArrearsGHS += FEES.monthly;
    }
  });
  res.json({
    defaulters,
    estimatedArrearsGHS: monthlyArrearsGHS + periodArrearsGHS,
    monthlyArrearsGHS,
    periodArrearsGHS,
    monthlyFeeGHS: FEES.monthly,
  });
});

// Admin: parents who have at least one learner in arrears (for the
// "message parents who owe" workflow).
// Phase 2 — extended to also include parents of period-based defaulters:
// a learner on a term/semester run may have payment_status = 'current'
// (the legacy monthly field is never updated for period-based runs) but
// still have an outstanding period payment. We union both populations,
// deduplicating by parent id. The existing monthly-defaulters SQL path is
// completely unchanged; the period check is a JS-side post-filter using
// the same sumPeriodOutstandingGHS already used by GET /defaulters.
router.get("/owing-parents", requireAuth, requireRole("admin"), (req, res) => {
  const scope = campusScopeFor(req.user);

  // Step 1 — monthly defaulters (same as before)
  let sql = `SELECT DISTINCT p.id, p.name, p.email, p.phone
       FROM users u JOIN users p ON p.id = u.parent_id
       WHERE u.role = 'learner' AND u.payment_status != 'current' AND u.status != 'graduated'`;
  const params = [];
  if (scope != null) { sql += " AND u.campus = ?"; params.push(scope); }
  const monthlyRows = db.prepare(sql).all(...params);

  // Step 2 — period-based defaulters: find all learners (with a parent)
  // whose outstanding period balance > 0, then collect their parents.
  let learnerSql = `SELECT DISTINCT u.id as learnerId, p.id, p.name, p.email, p.phone
       FROM users u JOIN users p ON p.id = u.parent_id
       WHERE u.role = 'learner' AND u.status != 'graduated' AND u.parent_id IS NOT NULL`;
  if (scope != null) { learnerSql += " AND u.campus = ?"; }
  const allLearnerRows = db.prepare(learnerSql).all(...(scope != null ? [scope] : []));

  const periodParents = [];
  const seenLearnerParentIds = new Set(monthlyRows.map((r) => r.id));
  allLearnerRows.forEach((row) => {
    if (seenLearnerParentIds.has(row.id)) return; // already captured via monthly path
    if (sumPeriodOutstandingGHS(row.learnerId) > 0) {
      seenLearnerParentIds.add(row.id);
      periodParents.push({ id: row.id, name: row.name, email: row.email, phone: row.phone });
    }
  });

  res.json({ parents: [...monthlyRows, ...periodParents] });
});

// ---------------------------------------------------------------------
// Admin accounting: manually set a learner/adult's payment status (e.g.
// after confirming a Mobile Money payment referenced by student ID), and
// track exactly how much is still owed when only part has been paid.
// ---------------------------------------------------------------------
router.patch("/:userId/status", requireAuth, requireRole("admin"), requireInAdminScope("userId"), (req, res) => {
  const { status, type, amountPaid, balanceOwed, note, method, paymentMonth, academicYearId, termId, programmeId, classId } = req.body;
  const ALLOWED_TYPES = ["registration", "monthly", "termly", "course", "workshop", "bootcamp"];
  if (!["current", "partial", "unpaid"].includes(status)) {
    return res.status(400).json({ error: "status must be 'current' (paid in full), 'partial' (paid part) or 'unpaid' (owing)." });
  }
  if (type && !ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${ALLOWED_TYPES.join(", ")}.` });
  }
  if (method && !["Paystack", "MoMo", "Cash"].includes(method)) {
    return res.status(400).json({ error: "method must be 'Paystack', 'MoMo' or 'Cash'." });
  }
  const learner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.userId);
  if (!learner) return res.status(404).json({ error: "Account not found." });

  const paymentType = type || (amountPaid && Number(amountPaid) > 0 ? "monthly" : null);
  if (paymentType === "monthly") {
    const monthlyBlock = getMonthlyBillingBlockReason(learner, {
      programmeId: programmeId || null,
      classId: classId || learner.class_id || null,
    });
    if (monthlyBlock) {
      return res.status(400).json({ error: monthlyBlock });
    }
  }

  const tx = db.transaction(() => {
    if (amountPaid && Number(amountPaid) > 0) {
      const resolvedProgrammeId = programmeId || null;
      const resolvedClassId = classId || learner.class_id || null;
      const billingInstance = resolveBillingLearningInstance(learner, {
        programmeId: resolvedProgrammeId,
        classId: resolvedClassId,
      });
      const learningInstanceId = billingInstance ? billingInstance.id : null;
      db.prepare(
        `INSERT INTO payments (id, user_id, amount, type, method, status, paystack_ref, date, payment_month, academic_year_id, term_id, programme_id, class_id, learning_instance_id)
         VALUES (?, ?, ?, ?, ?, 'successful', ?, datetime('now'), ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        learner.id,
        Number(amountPaid),
        type || "monthly",
        method ? `Admin: ${method}` : "Admin: manual update",
        `ADMIN-${uuid()}`,
        type === "monthly" ? (paymentMonth || null) : null,
        academicYearId || null,
        termId || null,
        resolvedProgrammeId,
        resolvedClassId,
        learningInstanceId
      );
    }
    const owed = status === "partial" ? Number(balanceOwed || 0) : 0;
    db.prepare("UPDATE users SET payment_status = ?, balance_owed_ghs = ? WHERE id = ?").run(status, owed, learner.id);
    // Keep the account's PRIMARY programme_enrollments row (its original
    // placement, from registration — routes/auth.js) showing the same
    // payment_status as the account itself, the same way activateSuccessfulPayment
    // does for Paystack-confirmed payments. No-op for accounts that predate
    // this row existing.
    db.prepare("UPDATE programme_enrollments SET payment_status = ?, updated_at = datetime('now') WHERE user_id = ? AND is_primary = 1").run(status, learner.id);
    // Paying registration in full also activates a pending account, matching
    // what the webhook does for card/MoMo payments made through the portal.
    if (status === "current" && learner.status === "pending_payment") {
      db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(learner.id);
      db.prepare("UPDATE programme_enrollments SET status = 'active', updated_at = datetime('now') WHERE user_id = ? AND is_primary = 1").run(learner.id);
      // Enrollment Activation (v30): this handler activates a pending
      // account the same way activateSuccessfulPayment does for a
      // Paystack-confirmed payment (it's a second, parallel activation
      // path — an admin manually recording a cash/MoMo payment collected
      // outside Paystack — not a call into that function), so it needs
      // the same curriculum-granting step, reusing the exact same
      // activateEnrollmentCurriculum helper rather than reimplementing
      // it here.
      const primary = db.prepare("SELECT class_id, requested_course_ids, learning_instance_id FROM programme_enrollments WHERE user_id = ? AND is_primary = 1").get(learner.id);
      if (primary) {
        let requestedCourseIds = [];
        try {
          requestedCourseIds = JSON.parse(primary.requested_course_ids || "[]");
        } catch (e) {
          requestedCourseIds = [];
        }
        activateEnrollmentCurriculum(learner.id, primary.class_id, requestedCourseIds, primary.learning_instance_id);
      }
    }
  });
  tx();
  res.json({ ok: true, note: note || null });
});

// Admin: manually record a payment toward one learner's specific academic
// period requirement (e.g. confirming a cash/MoMo payment made outside
// Paystack) — deliberately separate from PATCH /:userId/status above,
// which sets the account's GLOBAL payment_status/balance_owed_ghs (overall
// registration/monthly standing). A period payment must never touch that
// on its own; it settles only its own period's requirement, read back on
// demand from the payments table itself (see utils/periodPayments.js).
// Routes through activateSuccessfulPayment (utils/paymentActivation.js)
// exactly like a Paystack-confirmed period payment does, so an
// admin-recorded period payment also completes registration if this is
// effectively this learner's first-ever successful payment (their
// original registration charge failed) — not just the course-enrollment
// sync that used to be the only side effect here.
router.post("/:userId/period-payment", requireAuth, requireRole("admin"), requireInAdminScope("userId"), (req, res) => {
  const { learningInstanceId, periodId, amountGHS, method, note } = req.body;
  if (method && !["Paystack", "MoMo", "Cash"].includes(method)) {
    return res.status(400).json({ error: "method must be 'Paystack', 'MoMo' or 'Cash'." });
  }
  const learner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.userId);
  if (!learner) return res.status(404).json({ error: "Account not found." });
  const instance = getLearningInstanceById(learningInstanceId || "");
  if (!instance) return res.status(400).json({ error: "learningInstanceId does not match a known Learning Instance." });
  const period = getAcademicPeriodById(instance.id, periodId);
  if (!period) return res.status(400).json({ error: "This academic period doesn't belong to the given Learning Instance." });
  if (!Number(amountGHS) || Number(amountGHS) <= 0) {
    return res.status(400).json({ error: "amountGHS must be a positive amount." });
  }
  const insertedId = uuid();
  db.prepare(
    `INSERT INTO payments (id, user_id, amount, type, method, status, paystack_ref, date, learning_instance_id, learning_instance_academic_period_id)
     VALUES (?, ?, ?, 'period_payment', ?, 'successful', ?, datetime('now'), ?, ?)`
  ).run(insertedId, learner.id, Number(amountGHS), method ? `Admin: ${method}` : "Admin: manual update", `ADMIN-${uuid()}`, instance.id, period.id);
  // Same activation path a Paystack-confirmed period payment goes
  // through (utils/paymentActivation.js), not just the course-enrollment
  // sync — this is what also completes registration if this learner's
  // account never had a successful registration payment (e.g. their
  // original registration charge failed and this admin-recorded period
  // payment is effectively the first payment that's ever succeeded for
  // them), on top of the existing period Course auto-enrollment.
  const insertedPayment = db.prepare("SELECT * FROM payments WHERE id = ?").get(insertedId);
  activateSuccessfulPayment(insertedPayment);
  res.json({ ok: true, note: note || null, paymentStatus: getPeriodPaymentStatus(learner.id, instance, period) });
});

// Admin: everything needed for one learner's accounting row — running
// total paid, current balance, and the full payment history.
router.get("/:userId/summary", requireAuth, requireRole("admin"), requireInAdminScope("userId"), (req, res) => {
  const learner = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.userId);
  if (!learner) return res.status(404).json({ error: "Account not found." });
  const payments = db.prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY date DESC").all(req.params.userId);
  const totalPaidGHS = payments
    .filter((p) => p.status === "successful" && p.currency === "GHS")
    .reduce((a, p) => a + p.amount, 0);
  res.json({
    paymentStatus: learner.payment_status,
    balanceOwedGHS: learner.balance_owed_ghs || 0,
    totalPaidGHS,
    // Phase 10 — same live-resolved academicPeriodName as every other
    // payment listing in this file, so the admin's per-learner history
    // modal can also show which period a period-scoped payment settled.
    payments: payments.map((p) => ({
      ...p,
      academicPeriodName:
        p.learning_instance_id && p.learning_instance_academic_period_id
          ? (getAcademicPeriodById(p.learning_instance_id, p.learning_instance_academic_period_id) || {}).name || null
          : null,
    })),
  });
});
module.exports = router;
