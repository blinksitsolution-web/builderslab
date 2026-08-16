// ============================================================
// routes/pricing.js — ABRS v2.2 §15 (Pricing & Financial Policy
// Framework) and §15.11/refunds.
//
// POST /api/pricing/quote is the ONE endpoint in the codebase that
// computes a Final Amount Payable — for registration, admin repricing,
// or a reporting estimate alike. It does nothing but call
// utils/pricingEngine.js and return the result; it holds no pricing
// logic of its own (§20.1/§20.2).
//
// Everything else here is admin configuration CRUD (create the DATA the
// engine reads) and refund processing (apply a Refund Policy to an
// already-completed Payment, writing a new `refunds` row — the original
// `payments` row is never touched, per the "Preserve existing payment
// records" constitutional requirement).
// ============================================================

const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requirePermission } = require("../middleware/auth");
const { hasPermission } = require("../utils/rbac");
const pricingEngine = require("../utils/pricingEngine");

const router = express.Router();

/* ---------------------------------------------------------------------
   Quote — the single Final Amount Payable computation path
   --------------------------------------------------------------------- */

router.post("/quote", requireAuth, (req, res) => {
  const {
    learningInstanceId,
    programmeId,
    offeringTypeId,
    classId,
    operationalGroupId,
    userId,
    corporateClientId,
    courseIds,
  } = req.body || {};

  // A caller without pricing.view may only ever quote for themselves (or
  // their own ward) — never an arbitrary userId, which would leak
  // another learner's grant-driven pricing (scholarships/financial aid).
  let effectiveUserId = userId || null;
  if (!hasPermission(req.user, "pricing.view") && !hasPermission(req.user, "payments.view")) {
    if (effectiveUserId && effectiveUserId !== req.user.id) {
      const target = db.prepare("SELECT parent_id FROM users WHERE id = ?").get(effectiveUserId);
      if (!target || target.parent_id !== req.user.id) {
        return res.status(403).json({ error: "You can only request a quote for your own account or your own ward." });
      }
    }
  }

  const quote = pricingEngine.resolvePricing({
    learningInstanceId: learningInstanceId || null,
    programmeId: programmeId || null,
    offeringTypeId: offeringTypeId || null,
    classId: classId || null,
    operationalGroupId: operationalGroupId || null,
    userId: effectiveUserId,
    corporateClientId: corporateClientId || null,
    courseIds: Array.isArray(courseIds) ? courseIds : [],
  });
  res.json(quote);
});

/* ---------------------------------------------------------------------
   Generic admin CRUD helper — every §15 policy table (installment
   configurations, payment plans, campaigns, discount/scholarship/
   financial-aid policies, corporate pricing, refund policies) is plain
   configuration data with the same list/create/update/delete shape, so
   one small factory implements it once rather than repeating five
   nearly-identical route blocks (§2.2's own discipline, applied here to
   the admin surface rather than the pricing computation itself).
   --------------------------------------------------------------------- */

function registerPolicyCrud({ path, table, columns, permission }) {
  router.get(`/${path}`, requireAuth, requirePermission(permission.replace(/\.[a-z]+$/, ".view")), (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC`).all();
    res.json(rows);
  });

  router.post(`/${path}`, requireAuth, requirePermission(permission.replace(/\.[a-z]+$/, ".create")), (req, res) => {
    const id = uuid();
    const cols = columns
      .map((c) => (typeof c === "string" ? c : c.name))
      .filter((c) => req.body && Object.prototype.hasOwnProperty.call(req.body, c));
    const placeholders = cols.map(() => "?").join(",");
    const params = cols.map((c) => normalizeValue(req.body[c]));
    try {
      db.prepare(`INSERT INTO ${table} (id${cols.length ? "," + cols.join(",") : ""}) VALUES (?${cols.length ? "," + placeholders : ""})`).run(id, ...params);
      res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.patch(`/${path}/:id`, requireAuth, requirePermission(permission.replace(/\.[a-z]+$/, ".edit")), (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found." });
    const cols = columns.map((c) => (typeof c === "string" ? c : c.name)).filter((c) => req.body && Object.prototype.hasOwnProperty.call(req.body, c));
    if (!cols.length) return res.json(existing);
    const setClause = cols.map((c) => `${c} = ?`).join(", ");
    const params = cols.map((c) => normalizeValue(req.body[c]));
    try {
      db.prepare(`UPDATE ${table} SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).run(...params, req.params.id);
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete(`/${path}/:id`, requireAuth, requirePermission(permission.replace(/\.[a-z]+$/, ".delete")), (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found." });
    // Deactivate rather than hard-delete wherever a lifecycle flag exists
    // — a policy that already priced live Enrollments shouldn't vanish
    // out from under their pricing_snapshot's audit trail. Tables without
    // an is_active column (join/grant records) are hard-deleted.
    if (hasColumn(table, "is_active")) {
      db.prepare(`UPDATE ${table} SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    } else {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    }
    res.json({ ok: true });
  });
}

function normalizeValue(v) {
  if (v === undefined) return null;
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

const columnCache = new Map();
function hasColumn(table, column) {
  if (!columnCache.has(table)) {
    columnCache.set(table, db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  }
  return columnCache.get(table).includes(column);
}

registerPolicyCrud({
  path: "installment-configurations",
  table: "installment_configurations",
  columns: ["learning_instance_id", "name", "schedule", "is_active"],
  permission: "pricing.view",
});
registerPolicyCrud({
  path: "payment-plans",
  table: "payment_plans",
  columns: ["learning_instance_id", "installment_configuration_id", "name", "eligibility_rule", "late_payment_policy", "is_default", "is_active"],
  permission: "pricing.view",
});
registerPolicyCrud({
  path: "campaigns",
  table: "promotional_campaigns",
  columns: [
    "name", "description", "starts_at", "ends_at",
    "target_offering_type_id", "target_programme_id", "target_learning_instance_id", "target_course_id",
    "target_audience", "discount_type", "discount_value", "stacking_group", "priority", "is_active",
  ],
  permission: "pricing.view",
});
registerPolicyCrud({
  path: "discount-policies",
  table: "discount_policies",
  columns: [
    "category", "eligibility_rule", "discount_type", "discount_value", "applies_to",
    "stacking_group", "target_offering_type_id", "target_programme_id", "target_learning_instance_id", "is_active",
  ],
  permission: "pricing.view",
});
registerPolicyCrud({
  path: "scholarship-policies",
  table: "scholarship_policies",
  columns: ["name", "type", "value", "applies_to", "is_active"],
  permission: "pricing.view",
});
registerPolicyCrud({
  path: "financial-aid-policies",
  table: "financial_aid_policies",
  columns: ["name", "type", "value", "applies_to", "is_active"],
  permission: "pricing.view",
});
registerPolicyCrud({
  path: "corporate-pricing",
  table: "corporate_pricing",
  columns: ["corporate_client_id", "learning_instance_id", "target_programme_id", "target_offering_type_id", "rate_type", "rate_value", "is_active"],
  permission: "pricing.view",
});
registerPolicyCrud({
  path: "refund-policies",
  table: "refund_policies",
  columns: [
    "name", "target_offering_type_id", "target_programme_id", "target_learning_instance_id",
    "refund_window_days", "refund_percent", "conditions", "non_refundable_components", "is_default", "is_active",
  ],
  permission: "pricing.view",
});

/* ---------------------------------------------------------------------
   Grants — admin assigns a Discount Policy / Scholarship / Financial Aid
   Policy to a specific learner. Simple create/list/revoke; not run
   through the generic CRUD factory since grants are join records with no
   "edit" concept, only grant/revoke.
   --------------------------------------------------------------------- */

function registerGrantRoutes({ path, table, policyFk }) {
  router.get(`/${path}`, requireAuth, requirePermission("pricing.view"), (req, res) => {
    const { userId } = req.query;
    const rows = userId
      ? db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY created_at DESC`).all(userId)
      : db.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT 200`).all();
    res.json(rows);
  });

  router.post(`/${path}`, requireAuth, requirePermission("pricing.create"), (req, res) => {
    const { userId, learningInstanceId, note } = req.body || {};
    const policyId = req.body ? req.body[policyFk] : null;
    if (!userId || !policyId) return res.status(400).json({ error: `userId and ${policyFk} are required.` });
    const id = uuid();
    db.prepare(
      `INSERT INTO ${table} (id, ${policyFk}, user_id, learning_instance_id, granted_by, note, is_active) VALUES (?,?,?,?,?,?,1)`
    ).run(id, policyId, userId, learningInstanceId || null, req.user.id, note || null);
    res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
  });

  router.delete(`/${path}/:id`, requireAuth, requirePermission("pricing.delete"), (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found." });
    db.prepare(`UPDATE ${table} SET is_active = 0 WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });
}

registerGrantRoutes({ path: "discount-grants", table: "discount_grants", policyFk: "discount_policy_id" });
registerGrantRoutes({ path: "scholarship-grants", table: "scholarship_grants", policyFk: "scholarship_policy_id" });
registerGrantRoutes({ path: "financial-aid-grants", table: "financial_aid_grants", policyFk: "financial_aid_policy_id" });

/* ---------------------------------------------------------------------
   Refunds (§15.11) — ownership rule: a refund is always resolved against
   the Refund Policy governing the PAYMENT's Programme Run (via the
   Enrollment's Financial Policy Snapshot where available, §17), applied
   by pricingEngine.computeRefundAmount(); it is never a manually-typed
   amount unless an admin explicitly overrides with `overrideAmountGHS`
   and a reason. The original `payments` row is read-only here — a
   refund is always a NEW `refunds` row.
   --------------------------------------------------------------------- */

router.post("/refunds", requireAuth, requirePermission("payments.refund"), (req, res) => {
  const { paymentId, reason, overrideAmountGHS } = req.body || {};
  if (!paymentId) return res.status(400).json({ error: "paymentId is required." });

  const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
  if (!payment) return res.status(404).json({ error: "Payment not found." });
  if (payment.status !== "successful") {
    return res.status(400).json({ error: "Only a successful payment can be refunded." });
  }
  const alreadyRefunded = db.prepare("SELECT SUM(amount_ghs) AS total FROM refunds WHERE payment_id = ? AND status = 'completed'").get(paymentId);
  const alreadyRefundedGHS = Number(alreadyRefunded && alreadyRefunded.total) || 0;

  // Resolve the owning Enrollment: prefer the direct link payments.
  // programme_enrollment_id already carries (wired in at payment-record
  // time — see utils/paymentActivation.js), since that is the actual
  // Enrollment this specific Payment was made under. Only for payment
  // records that predate that integration (programme_enrollment_id
  // NULL) do we fall back to the learner's most recent Enrollment on the
  // Payment's own learning_instance_id, or failing that, their most
  // recent Enrollment overall.
  let enrollment = payment.programme_enrollment_id
    ? db.prepare("SELECT * FROM programme_enrollments WHERE id = ?").get(payment.programme_enrollment_id)
    : null;
  if (!enrollment && payment.learning_instance_id) {
    enrollment = db
      .prepare("SELECT * FROM programme_enrollments WHERE user_id = ? AND learning_instance_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(payment.user_id, payment.learning_instance_id);
  }
  if (!enrollment) {
    enrollment = db
      .prepare(
        `SELECT * FROM programme_enrollments WHERE user_id = ? ORDER BY
          CASE WHEN status = 'active' THEN 0 ELSE 1 END, rowid DESC LIMIT 1`
      )
      .get(payment.user_id);
  }

  let refundPolicy = null;
  if (enrollment && enrollment.financial_policy_snapshot) {
    try {
      const snap = JSON.parse(enrollment.financial_policy_snapshot);
      if (snap.refundPolicyId) refundPolicy = db.prepare("SELECT * FROM refund_policies WHERE id = ?").get(snap.refundPolicyId);
    } catch (e) {
      /* fall through to live resolution */
    }
  }
  if (!refundPolicy) {
    refundPolicy = pricingEngine.resolveRefundPolicy({
      learningInstanceId: (enrollment && enrollment.learning_instance_id) || payment.learning_instance_id || null,
    });
  }

  let refundableGHS;
  let policyReason = null;
  if (overrideAmountGHS != null) {
    refundableGHS = Math.max(0, Number(overrideAmountGHS));
  } else {
    const academicPeriod = enrollment && enrollment.academic_period_id
      ? db.prepare("SELECT * FROM learning_instance_academic_periods WHERE id = ?").get(enrollment.academic_period_id)
      : null;
    const computed = pricingEngine.computeRefundAmount({
      paymentAmountGHS: payment.amount,
      paymentType: payment.type,
      refundPolicy,
      academicPeriodStart: academicPeriod ? academicPeriod.starts_at : null,
    });
    refundableGHS = computed.refundableGHS;
    policyReason = computed.reason;
  }

  refundableGHS = Math.max(0, Math.min(refundableGHS, payment.amount - alreadyRefundedGHS));

  const id = uuid();
  db.prepare(
    `INSERT INTO refunds (id, payment_id, programme_enrollment_id, refund_policy_id, amount_ghs, reason, status, processed_by)
     VALUES (?,?,?,?,?,?, 'completed', ?)`
  ).run(id, paymentId, enrollment ? enrollment.id : null, refundPolicy ? refundPolicy.id : null, refundableGHS, reason || policyReason || null, req.user.id);

  res.status(201).json({
    refund: db.prepare("SELECT * FROM refunds WHERE id = ?").get(id),
    refundPolicyApplied: refundPolicy ? { id: refundPolicy.id, name: refundPolicy.name } : null,
    policyReason,
  });
});

router.get("/refunds", requireAuth, requirePermission("payments.view"), (req, res) => {
  const { userId, paymentId } = req.query;
  let rows;
  if (paymentId) {
    rows = db.prepare("SELECT * FROM refunds WHERE payment_id = ? ORDER BY created_at DESC").all(paymentId);
  } else if (userId) {
    rows = db
      .prepare(
        `SELECT r.* FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.user_id = ? ORDER BY r.created_at DESC`
      )
      .all(userId);
  } else {
    rows = db.prepare("SELECT * FROM refunds ORDER BY created_at DESC LIMIT 200").all();
  }
  res.json(rows);
});

module.exports = router;
