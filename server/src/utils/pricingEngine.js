// ============================================================
// Pricing Engine — ABRS v2.2 §15 (Pricing & Financial Policy Framework).
//
// THIS IS THE ONE PRICING ENGINE. Per §2.1 (Single Ownership), §15.13 and
// §20.1/§20.2: pricing resolution has exactly one owner — this module —
// and exactly one computation path, executed in exactly the order named
// in §15.13. No other file may implement a second Final-Amount-Payable
// computation, for any caller (registration, admin repricing, reporting
// estimates, refunds).
//
// Every step below reads configuration DATA (site_settings + the tables
// migratePricing.js created); nothing here branches on a business name,
// programme identifier, or policy category label (§2.2). The only
// literal numbers in this file are (a) rounding/clamping arithmetic and
// (b) the last-resort legacy defaults already established in
// site_settings.fees before this framework existed — preserved here only
// so a pre-existing installation that has configured nothing new keeps
// behaving exactly as it did, never as a new hardcoded business rule.
//
// §15.13 resolution order, implemented by resolveComponentPricing():
//   Base Pricing (§15.2) — Corporate Pricing (§15.10) replaces it where applicable
//     -> Operational Group Override (§11.3, §15.1)
//     -> Early Bird (§15.5)               [tuition component only, per §15.5]
//     -> Promotional Campaign (§15.6)
//     -> Discount Policies (§15.7)
//     -> Scholarship Policies (§15.8)
//     -> Financial Aid (§15.9)
//     -> Taxes (§15.12 — reserved, not yet implemented)
//     -> Final Amount Payable
// ============================================================

const db = require("../db/db");
const { getSetting } = require("./settings");
const { resolveEnrollmentOperationalConfig } = require("./learningInstances");

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

function round(amount) {
  return Math.round((Number(amount) || 0) * 100) / 100;
}

function clampNonNegative(amount) {
  return Math.max(0, amount);
}

// ---------------------------------------------------------------------
// Legacy, not-yet-constitutional registration adjustments — the
// own-robotics-kit surcharge and the partner-school alternate base rate.
// Neither has a home among the §15 policy types yet (an "addon" on top
// of Final Amount Payable isn't Early Bird/Campaign/Discount/Scholarship/
// Financial-Aid/Corporate Pricing — all eight of those either replace or
// reduce the base, none of them add to it), so per the constraint against
// inventing a new pricing concept, they stay outside the §15.13 sequence
// itself rather than being force-fit into a step that doesn't describe
// them. They are good candidates for a future, separate migration (a
// Corporate-Pricing-shaped "Partner School Pricing" record, and a
// generic fee-addon table) per Appendix A-10.
//
// What DOES belong here, and is the reason this function now lives in
// the one Pricing Engine rather than in utils/fees.js where it used to:
// §17's Pricing Snapshot must record what the learner actually agreed to
// pay. Before this fix, buildPricingSnapshot() serialized the engine's
// pure §15.13 output while utils/fees.js's registrationBreakdown()/
// currentFees() applied this same adjustment on top, separately, to
// compute the amount actually invoiced — two numbers, one enrollment, a
// silent divergence for any own_robotics_kit or partner-school learner.
// Centralizing the adjustment here, and having buildPricingSnapshot()
// apply it too, closes that gap without pretending it's a §15 policy
// step: it is recorded on the snapshot as `registration.legacyAdjustment`,
// clearly separate from the eight named policy steps above it.
function applyLegacyRegistrationAdjustments(registrationAmount, learnerLike) {
  const fees = getSetting("fees", {});
  let amount = registrationAmount;
  const notes = [];

  const campusName = learnerLike && learnerLike.campus;
  const schoolName = learnerLike && (learnerLike.school_name ?? learnerLike.schoolName);
  const schoolMatchesCampus =
    !!campusName && !!schoolName && String(campusName).trim().toLowerCase() === String(schoolName).trim().toLowerCase();
  const isPartner = !!(schoolMatchesCampus && db.prepare("SELECT 1 FROM campuses WHERE name = ? AND is_partner = 1").get(campusName));
  if (isPartner && (fees.partnerSchoolRegistrationGHS != null || fees.partnerSchoolMonthlyGHS != null) && fees.partnerSchoolRegistrationGHS != null) {
    amount = Number(fees.partnerSchoolRegistrationGHS);
    notes.push({ type: "partner_school_rate", amountGHS: amount });
  }
  if (learnerLike && learnerLike.own_robotics_kit) {
    const surcharge = Number(fees.ownRoboticsKitFeeGHS ?? 200);
    amount += surcharge;
    notes.push({ type: "own_robotics_kit_surcharge", amountGHS: surcharge });
  }
  amount = Math.round(amount);
  return { amount, notes };
}

// ---------------------------------------------------------------------
// Step: Base Pricing (§15.2) / Corporate Pricing (§15.10)
// ---------------------------------------------------------------------

// Finds the single best-matching, active Corporate Pricing record for
// this learner's organization against this Programme Run — Run-specific
// beats Programme-wide beats Offering-Type-wide (most specific reach
// wins), per §15.10's "same Programme Run every other learner enrolls
// into" resolution.
function findCorporatePricing({ corporateClientId, learningInstanceId, programmeId, offeringTypeId }) {
  if (!corporateClientId) return null;
  const byInstance = learningInstanceId
    ? db
        .prepare(
          `SELECT * FROM corporate_pricing WHERE is_active = 1 AND corporate_client_id = ? AND learning_instance_id = ?`
        )
        .get(corporateClientId, learningInstanceId)
    : null;
  if (byInstance) return byInstance;

  const byProgramme = programmeId
    ? db
        .prepare(
          `SELECT * FROM corporate_pricing WHERE is_active = 1 AND corporate_client_id = ? AND target_programme_id = ?`
        )
        .get(corporateClientId, programmeId)
    : null;
  if (byProgramme) return byProgramme;

  const byOfferingType = offeringTypeId
    ? db
        .prepare(
          `SELECT * FROM corporate_pricing WHERE is_active = 1 AND corporate_client_id = ? AND target_offering_type_id = ?`
        )
        .get(corporateClientId, offeringTypeId)
    : null;
  return byOfferingType || null;
}

// Resolves the standard (non-corporate, non-Operational-Group) Base
// Tuition Fee or Registration Fee for a Programme Run. `component` is
// 'tuition' | 'registration'. Falls through to the legacy, admin-editable
// site_settings > Fees default (never a literal baked into a branch) for
// any Run that predates this framework and hasn't configured its own
// fee yet — the same "NULL = not configured, never inferred" convention
// every resolver in utils/learningInstances.js already uses.
function resolveStandardBaseAmount(component, runRow) {
  const legacyFees = getSetting("fees", {});
  if (component === "registration") {
    if (runRow) {
      // Learning-Instance pricing: the Registration Fee MUST come from the
      // Run's own configured registration_fee_ghs. A configured Run with
      // no Registration Fee is a data problem, not licence to silently
      // substitute the old global site-wide default — that would let a
      // stale/never-configured legacy fee override what an admin actually
      // set (or deliberately left unset) on this specific Run.
      if (runRow.registration_fee_ghs != null) return Number(runRow.registration_fee_ghs);
      throw new Error(
        `Learning Instance ${runRow.id} has no registration_fee_ghs configured — refusing to silently fall back to the legacy site-wide registration fee.`
      );
    }
    // No Learning Instance in context at all (e.g. a pre-Run/legacy
    // caller) — the old global default is the only thing that has ever
    // governed this case, so it remains the fallback here.
    return Number(legacyFees.registrationGHS ?? process.env.REGISTRATION_FEE_GHS ?? 0) || 0;
  }
  // component === 'tuition'
  if (runRow && runRow.fee_ghs != null) return Number(runRow.fee_ghs);
  return Number(legacyFees.monthlyGHS ?? process.env.MONTHLY_FEE_GHS ?? 0) || 0;
}

// ---------------------------------------------------------------------
// Step: Operational Group Override (§11.3 / §15.1) — Tuition Fee ONLY.
//
// Delegates the actual "whose override wins" resolution to
// utils/learningInstances.js's resolveEnrollmentOperationalConfig() — the
// single resolver that file's own v39 documentation names as what every
// new read path (including this one) must call, rather than
// re-implementing Operational-Group-vs-Class-vs-Run precedence here too
// (which would itself be a second, competing pricing-adjacent
// calculation path). This module's only job is to decide whether that
// resolved figure should win over Corporate Pricing.
// ---------------------------------------------------------------------

function resolveOperationalOverride(component, context) {
  if (component !== "tuition") return { feeGHS: null, isExplicitOverride: false };
  if (!context.classId && !context.enrollmentRow && !context.operationalGroupId) return { feeGHS: null, isExplicitOverride: false };

  const config = resolveEnrollmentOperationalConfig(
    context.enrollmentRow || { operational_group_id: context.operationalGroupId || null, class_id: context.classId || null },
    context.classId ? db.prepare("SELECT * FROM classes WHERE id = ?").get(context.classId) : null
  );
  if (!config || config.feeGHS == null) return { feeGHS: null, isExplicitOverride: false };

  // An override only counts as "sole authoritative, wins over Corporate
  // Pricing" (§11.3) when the Operational Group or legacy Class row
  // actually SET its own fee_ghs — not merely inherited its parent Run's.
  // Read the raw column rather than the already-resolved value so a
  // Group/Class with no override of its own still lets Corporate Pricing
  // apply normally.
  let isExplicitOverride = false;
  if (config.operationalGroupId) {
    const ogRow = db.prepare("SELECT fee_ghs FROM operational_groups WHERE id = ?").get(config.operationalGroupId);
    isExplicitOverride = !!(ogRow && ogRow.fee_ghs != null);
  } else if (context.classId) {
    const classRow = db.prepare("SELECT fee_ghs FROM classes WHERE id = ?").get(context.classId);
    isExplicitOverride = !!(classRow && classRow.fee_ghs != null);
  }

  return { feeGHS: Number(config.feeGHS), isExplicitOverride };
}

// ---------------------------------------------------------------------
// Step: Early Bird (§15.5) — tuition component only, date-driven.
// ---------------------------------------------------------------------

function resolveEarlyBird(component, runRow, currentAmount, now) {
  if (component !== "tuition" || !runRow || !runRow.early_bird_deadline) return { amount: currentAmount, applied: null };
  const deadline = Date.parse(runRow.early_bird_deadline);
  if (Number.isNaN(deadline) || now > deadline) return { amount: currentAmount, applied: null };

  if (runRow.early_bird_amount_ghs != null) {
    const amt = Number(runRow.early_bird_amount_ghs);
    return { amount: amt, applied: { type: "amount", amountGHS: amt, deadline: runRow.early_bird_deadline } };
  }
  if (runRow.early_bird_percent != null) {
    const pct = Number(runRow.early_bird_percent);
    const amt = round(currentAmount * (1 - pct / 100));
    return { amount: amt, applied: { type: "percent", percent: pct, deadline: runRow.early_bird_deadline } };
  }
  return { amount: currentAmount, applied: null };
}

// ---------------------------------------------------------------------
// Step: Promotional Campaigns (§15.6)
// ---------------------------------------------------------------------

function campaignMatchesTargeting(campaign, ctx) {
  if (campaign.target_offering_type_id && campaign.target_offering_type_id !== ctx.offeringTypeId) return false;
  if (campaign.target_programme_id && campaign.target_programme_id !== ctx.programmeId) return false;
  if (campaign.target_learning_instance_id && campaign.target_learning_instance_id !== ctx.learningInstanceId) return false;
  if (campaign.target_course_id && !(ctx.courseIds || []).includes(campaign.target_course_id)) return false;
  // Audience is evaluated generically: null/'all' always matches. Any
  // other configured audience value is treated as a targeting criterion
  // this installation hasn't defined an evaluator for yet, so it is
  // conservatively excluded rather than guessed at — never inferred from
  // the audience string itself (§2.2).
  if (campaign.target_audience && campaign.target_audience !== "all") {
    if (typeof ctx.audienceMatcher === "function" && !ctx.audienceMatcher(campaign.target_audience)) return false;
    if (typeof ctx.audienceMatcher !== "function") return false;
  }
  return true;
}

function findActiveCampaigns(ctx, now) {
  const rows = db
    .prepare(
      `SELECT * FROM promotional_campaigns
       WHERE is_active = 1
         AND (starts_at IS NULL OR starts_at <= ?)
         AND (ends_at IS NULL OR ends_at >= ?)`
    )
    .all(new Date(now).toISOString(), new Date(now).toISOString());
  return rows.filter((c) => campaignMatchesTargeting(c, ctx));
}

function applyBestPerGroup(policies, currentAmount, valueField, typeField, groupField) {
  // Groups a set of {discount_type/type, discount_value/value,
  // stacking_group} rows by stacking_group. Within a group, only the
  // single best-for-the-learner policy applies (mutual exclusivity);
  // across groups (including every policy with a NULL group, each of
  // which is its own exclusive group of one), every group's winner
  // stacks. Pure data-driven selection — never a name/category branch.
  const groups = new Map();
  policies.forEach((p) => {
    const key = p[groupField] != null ? `g:${p[groupField]}` : `solo:${p.id}`;
    const resultingAmount = clampNonNegative(
      p[typeField] === "percentage" ? currentAmount * (1 - Number(p[valueField]) / 100) : currentAmount - Number(p[valueField])
    );
    const existing = groups.get(key);
    if (!existing || resultingAmount < existing.resultingAmount) {
      groups.set(key, { policy: p, resultingAmount });
    }
  });

  // Each stacking group's winning discount is computed against the same
  // pre-step currentAmount (groups stack additively off one baseline,
  // never compounding against another group's already-discounted
  // output) — this is what "stacks across groups, exclusive within a
  // group" means in practice.
  const applied = [];
  let finalAmount = currentAmount;
  groups.forEach(({ policy }) => {
    const reduction =
      policy[typeField] === "percentage" ? (currentAmount * Number(policy[valueField])) / 100 : Number(policy[valueField]);
    finalAmount -= reduction;
    applied.push({ id: policy.id, type: policy[typeField], value: Number(policy[valueField]) });
  });
  finalAmount = round(clampNonNegative(finalAmount));
  return { amount: finalAmount, applied };
}

function resolveCampaigns(component, ctx, currentAmount, now) {
  const campaigns = findActiveCampaigns(ctx, now);
  if (!campaigns.length) return { amount: currentAmount, applied: [] };
  return applyBestPerGroup(campaigns, currentAmount, "discount_value", "discount_type", "stacking_group");
}

// ---------------------------------------------------------------------
// Step: Discount Policies (§15.7)
// ---------------------------------------------------------------------

// Generic, data-driven eligibility evaluator. Rule "type" values are a
// fixed computation-strategy vocabulary (§2.2's distinction between a
// business-identifier branch and a generic strategy the config selects),
// never a business-category name.
function evaluateEligibilityRule(rule, ctx) {
  if (!rule || !rule.type) return false;
  switch (rule.type) {
    case "always":
      return true;
    case "flag":
      return !!(ctx.learner && rule.flag && ctx.learner[rule.flag]);
    case "sibling_rank_gte": {
      if (!ctx.siblingRank) return false;
      return ctx.siblingRank >= Number(rule.rank || 2);
    }
    case "manual_grant":
      return !!(ctx.grantedPolicyIds && ctx.grantedPolicyIds.has(rule.__policyId));
    default:
      return false; // unknown rule type — never guessed, treated as not eligible
  }
}

function policyMatchesTargeting(policy, ctx) {
  if (policy.target_offering_type_id && policy.target_offering_type_id !== ctx.offeringTypeId) return false;
  if (policy.target_programme_id && policy.target_programme_id !== ctx.programmeId) return false;
  if (policy.target_learning_instance_id && policy.target_learning_instance_id !== ctx.learningInstanceId) return false;
  return true;
}

function resolveDiscountPolicies(component, ctx, currentAmount) {
  const applicable = ["both", component];
  const rows = db
    .prepare(`SELECT * FROM discount_policies WHERE is_active = 1 AND applies_to IN (${applicable.map(() => "?").join(",")})`)
    .all(...applicable)
    .filter((p) => policyMatchesTargeting(p, ctx));
  if (!rows.length) return { amount: currentAmount, applied: [] };

  const grantedPolicyIds = ctx.userId
    ? new Set(db.prepare(`SELECT discount_policy_id FROM discount_grants WHERE user_id = ?`).all(ctx.userId).map((r) => r.discount_policy_id))
    : new Set();

  const eligible = rows.filter((p) => {
    const rule = parseJson(p.eligibility_rule, null);
    return evaluateEligibilityRule({ ...rule, __policyId: p.id }, { ...ctx, grantedPolicyIds });
  });
  if (!eligible.length) return { amount: currentAmount, applied: [] };

  const { amount, applied } = applyBestPerGroup(eligible, currentAmount, "discount_value", "discount_type", "stacking_group");
  return {
    amount,
    applied: applied.map((a, idx) => ({ ...a, category: eligible.find((e) => e.id === a.id).category })),
  };
}

// ---------------------------------------------------------------------
// Step: Scholarship Policies (§15.8) and Financial Aid (§15.9) — both
// always admin-granted to a specific learner, structurally identical.
// ---------------------------------------------------------------------

function resolveGrantedAssistance(kind, component, ctx, currentAmount) {
  const policyTable = kind === "scholarship" ? "scholarship_policies" : "financial_aid_policies";
  const grantTable = kind === "scholarship" ? "scholarship_grants" : "financial_aid_grants";
  const policyFk = kind === "scholarship" ? "scholarship_policy_id" : "financial_aid_policy_id";

  if (!ctx.userId) return { amount: currentAmount, applied: [] };

  const grants = db
    .prepare(
      `SELECT g.*, p.type AS policy_type, p.value AS policy_value, p.applies_to AS policy_applies_to
       FROM ${grantTable} g
       JOIN ${policyTable} p ON p.id = g.${policyFk}
       WHERE g.user_id = ? AND g.is_active = 1 AND p.is_active = 1
         AND (g.learning_instance_id IS NULL OR g.learning_instance_id = ?)`
    )
    .all(ctx.userId, ctx.learningInstanceId || null)
    .filter((g) => g.policy_applies_to === "both" || g.policy_applies_to === component);

  if (!grants.length) return { amount: currentAmount, applied: [] };

  let amount = currentAmount;
  const applied = [];
  grants.forEach((g) => {
    let reduction = 0;
    if (g.policy_type === "full" || g.policy_type === "fee_waiver") {
      reduction = amount; // zeroes out whatever remains at this step
    } else if (g.policy_type === "percentage" || g.policy_type === "partial") {
      reduction = (amount * Number(g.policy_value || 0)) / 100;
    } else if (g.policy_type === "fixed_amount") {
      reduction = Number(g.policy_value || 0);
    }
    amount = clampNonNegative(round(amount - reduction));
    applied.push({ grantId: g.id, policyId: g[policyFk], type: g.policy_type, value: g.policy_value });
  });

  return { amount, applied };
}

// ---------------------------------------------------------------------
// Core: resolve ONE fee component (tuition or registration) through the
// full §15.13 order. This is the only function in the codebase permitted
// to produce a Final Amount Payable for a component.
// ---------------------------------------------------------------------

function resolveComponentPricing(component, context) {
  const now = context.now || Date.now();
  const runRow = context.learningInstanceId
    ? db.prepare("SELECT * FROM learning_instances WHERE id = ?").get(context.learningInstanceId)
    : null;

  const ctx = {
    learningInstanceId: context.learningInstanceId || null,
    programmeId: context.programmeId || (runRow && runRow.programme_id) || null,
    offeringTypeId: context.offeringTypeId || (runRow && runRow.offering_type_id) || null,
    courseIds: context.courseIds || [],
    userId: context.userId || null,
    learner: context.learner || null,
    siblingRank: context.siblingRank || null,
    audienceMatcher: context.audienceMatcher || null,
  };

  // Step 1: Base Pricing / Corporate Pricing (§15.2, §15.10) and
  // Step 2: Operational Group Override (§11.3/§15.1) — resolved together
  // because whether Corporate Pricing applies at all depends on whether
  // a more specific Operational Group/Class override exists (§15.1: an
  // explicit override is the SOLE authoritative value and wins over
  // everything, including a corporate rate).
  const operationalOverride = resolveOperationalOverride(component, context);
  const corporatePricing = operationalOverride.isExplicitOverride
    ? null
    : findCorporatePricing({
        corporateClientId: context.corporateClientId,
        learningInstanceId: ctx.learningInstanceId,
        programmeId: ctx.programmeId,
        offeringTypeId: ctx.offeringTypeId,
      });

  let amount;
  let corporatePricingApplied = null;
  if (operationalOverride.isExplicitOverride) {
    // Operational Group/Class explicitly set its own Tuition Fee — the
    // sole authoritative value (§11.3); already fully resolved.
    amount = operationalOverride.feeGHS;
  } else if (component === "tuition" && corporatePricing) {
    const standard = resolveStandardBaseAmount(component, runRow);
    amount =
      corporatePricing.rate_type === "fixed_amount"
        ? Number(corporatePricing.rate_value)
        : round(standard * (1 - Number(corporatePricing.rate_value) / 100));
    corporatePricingApplied = {
      id: corporatePricing.id,
      corporateClientId: corporatePricing.corporate_client_id,
      rateType: corporatePricing.rate_type,
      rateValue: corporatePricing.rate_value,
    };
  } else {
    amount = resolveStandardBaseAmount(component, runRow);
  }
  const baseAmount = amount;
  const ogOverride = operationalOverride.isExplicitOverride ? operationalOverride.feeGHS : null;

  // Step 3: Early Bird (§15.5)
  const earlyBird = resolveEarlyBird(component, runRow, amount, now);
  amount = earlyBird.amount;

  // Step 4: Promotional Campaign (§15.6)
  const campaignResult = resolveCampaigns(component, ctx, amount, now);
  amount = campaignResult.amount;

  // Step 5: Discount Policies (§15.7)
  const discountResult = resolveDiscountPolicies(component, ctx, amount);
  amount = discountResult.amount;

  // Step 6: Scholarship Policies (§15.8)
  const scholarshipResult = resolveGrantedAssistance("scholarship", component, ctx, amount);
  amount = scholarshipResult.amount;

  // Step 7: Financial Aid (§15.9)
  const financialAidResult = resolveGrantedAssistance("financial_aid", component, ctx, amount);
  amount = financialAidResult.amount;

  // Step 8: Taxes (§15.12) — reserved position, not yet implemented.
  const tax = { implemented: false, amount: 0 };

  amount = clampNonNegative(round(amount));

  return {
    component,
    baseAmountGHS: round(baseAmount),
    corporatePricingApplied,
    operationalGroupOverrideGHS: ogOverride,
    earlyBird: earlyBird.applied,
    campaigns: campaignResult.applied,
    discounts: discountResult.applied,
    scholarships: scholarshipResult.applied,
    financialAid: financialAidResult.applied,
    tax,
    finalAmountGHS: amount,
  };
}

// ---------------------------------------------------------------------
// Public: full pricing quote for an Enrollment (tuition + registration).
// Exactly one function computes Final Amount Payable end to end (§20.2).
// ---------------------------------------------------------------------

function resolvePricing(context) {
  const tuition = resolveComponentPricing("tuition", context);
  const registration = resolveComponentPricing("registration", context);
  return {
    currency: "GHS",
    resolvedAt: new Date(context.now || Date.now()).toISOString(),
    tuition,
    registration,
    finalAmountPayableGHS: round(tuition.finalAmountGHS + registration.finalAmountGHS),
  };
}

// Builds the immutable snapshot persisted onto programme_enrollments at
// enrollment time (§17: Pricing Snapshot / Financial Policy Snapshot).
// This is what every later read of "what did this learner actually agree
// to pay" consults — never a live re-run of resolvePricing() against
// possibly-since-changed policy configuration.
//
// `context.legacyAdjustmentContext`, when provided (campus/schoolName/
// ownRoboticsKit — the same shape utils/fees.js's registrationBreakdown()
// already receives per learner), applies the same legacy registration
// adjustment registrationBreakdown() applies when computing the actual
// charge, so the two can never again silently diverge (see
// applyLegacyRegistrationAdjustments's comment above). Omitting it is
// fine and unchanged for every caller that has no such context (e.g.
// tuition-only recurring payments, which this adjustment never touches).
function buildPricingSnapshot(context) {
  const quote = resolvePricing(context);
  if (context.legacyAdjustmentContext) {
    const { amount, notes } = applyLegacyRegistrationAdjustments(quote.registration.finalAmountGHS, context.legacyAdjustmentContext);
    if (notes.length) {
      quote.registration = { ...quote.registration, legacyAdjustment: { notes, preAdjustmentAmountGHS: quote.registration.finalAmountGHS }, finalAmountGHS: amount };
      quote.finalAmountPayableGHS = round(quote.tuition.finalAmountGHS + amount);
    }
  }
  return JSON.stringify(quote);
}

function buildFinancialPolicySnapshot({ learningInstanceId, paymentPlanId, refundPolicyId } = {}) {
  const plan = paymentPlanId ? db.prepare("SELECT * FROM payment_plans WHERE id = ?").get(paymentPlanId) : resolveDefaultPaymentPlan(learningInstanceId);
  const refundPolicy = refundPolicyId ? db.prepare("SELECT * FROM refund_policies WHERE id = ?").get(refundPolicyId) : resolveRefundPolicy({ learningInstanceId });
  return JSON.stringify({
    paymentPlanId: plan ? plan.id : null,
    installmentConfigurationId: plan ? plan.installment_configuration_id : null,
    refundPolicyId: refundPolicy ? refundPolicy.id : null,
  });
}

function resolveDefaultPaymentPlan(learningInstanceId) {
  if (!learningInstanceId) return null;
  return (
    db.prepare(`SELECT * FROM payment_plans WHERE learning_instance_id = ? AND is_active = 1 AND is_default = 1`).get(learningInstanceId) ||
    db.prepare(`SELECT * FROM payment_plans WHERE learning_instance_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1`).get(learningInstanceId) ||
    null
  );
}

// ---------------------------------------------------------------------
// Refund Policies (§15.11) — resolved by reach precedence: a Run-scoped
// policy wins over a Programme-scoped policy, which wins over an
// Offering-Type-scoped policy, which wins over the institution-wide
// default (is_default = 1, every target_* column NULL). This is the one
// place that precedence is implemented (§19: "Pricing Resolution — the
// Section 15.13 resolution engine — exactly one per Run"; the same
// Single-Ownership discipline applies to Refund Policy resolution).
// ---------------------------------------------------------------------

function resolveRefundPolicy({ learningInstanceId, programmeId, offeringTypeId } = {}) {
  if (learningInstanceId) {
    const byInstance = db.prepare(`SELECT * FROM refund_policies WHERE is_active = 1 AND target_learning_instance_id = ?`).get(learningInstanceId);
    if (byInstance) return byInstance;
  }
  const runRow = learningInstanceId ? db.prepare("SELECT * FROM learning_instances WHERE id = ?").get(learningInstanceId) : null;
  const resolvedProgrammeId = programmeId || (runRow && runRow.programme_id) || null;
  if (resolvedProgrammeId) {
    const byProgramme = db.prepare(`SELECT * FROM refund_policies WHERE is_active = 1 AND target_programme_id = ?`).get(resolvedProgrammeId);
    if (byProgramme) return byProgramme;
  }
  const resolvedOfferingTypeId = offeringTypeId || (runRow && runRow.offering_type_id) || null;
  if (resolvedOfferingTypeId) {
    const byOfferingType = db.prepare(`SELECT * FROM refund_policies WHERE is_active = 1 AND target_offering_type_id = ?`).get(resolvedOfferingTypeId);
    if (byOfferingType) return byOfferingType;
  }
  return db.prepare(`SELECT * FROM refund_policies WHERE is_active = 1 AND is_default = 1`).get() || null;
}

// Computes the refundable amount for a specific Payment against the
// Refund Policy that governs the Enrollment it belongs to (per the
// Enrollment's Financial Policy Snapshot where available — §17 — falling
// back to a fresh resolveRefundPolicy() lookup only when the Enrollment
// predates snapshotting). Never mutates the original payment row.
function computeRefundAmount({ paymentAmountGHS, paymentType, refundPolicy, academicPeriodStart, now }) {
  if (!refundPolicy) return { refundableGHS: 0, reason: "No Refund Policy configured — nothing is refundable by default." };

  const nonRefundable = parseJson(refundPolicy.non_refundable_components, []);
  if (paymentType === "registration" && nonRefundable.includes("registration_fee")) {
    return { refundableGHS: 0, reason: "Registration Fee is non-refundable under the applicable Refund Policy." };
  }

  if (refundPolicy.refund_window_days != null) {
    const windowStart = academicPeriodStart ? Date.parse(academicPeriodStart) : null;
    if (windowStart != null && !Number.isNaN(windowStart)) {
      const deadline = windowStart + refundPolicy.refund_window_days * 24 * 60 * 60 * 1000;
      const nowTs = now || Date.now();
      if (nowTs > deadline) {
        return { refundableGHS: 0, reason: "Refund window has closed." };
      }
    }
  }

  const refundableGHS = round(clampNonNegative(paymentAmountGHS * (Number(refundPolicy.refund_percent) / 100)));
  return { refundableGHS, reason: null };
}

module.exports = {
  resolvePricing,
  resolveComponentPricing,
  buildPricingSnapshot,
  buildFinancialPolicySnapshot,
  resolveDefaultPaymentPlan,
  resolveRefundPolicy,
  computeRefundAmount,
  findCorporatePricing,
  applyLegacyRegistrationAdjustments,
};
