// ============================================================
// utils/fees.js — thin, backward-compatible adapter over the ONE Pricing
// Engine (utils/pricingEngine.js, ABRS v2.2 §15). Every function here
// keeps its original name/signature/return-shape so existing call sites
// (auth.js, enrolments.js, payments.js, users.js) don't need to change,
// but NONE of them compute a price anymore — they resolve the learner's
// Enrollment/Programme-Run context and hand it to pricingEngine, which is
// now the only place §15.13's resolution sequence (Base Pricing/Corporate
// Pricing -> Operational Group Override -> Early Bird -> Campaign ->
// Discount -> Scholarship -> Financial Aid -> Tax) is implemented.
//
// Two narrow legacy adjustments remain here rather than in the engine
// because neither has a constitutional home among the §15 policy tables
// yet (they predate this framework and are genuine "add-on"/"alternate
// base rate" business rules, not Discount Policies): the own-robotics-kit
// registration surcharge, and the partner-school alternate base rate.
// Both are pass-through legacy behaviour only, clearly marked below, and
// are good candidates for a follow-up migration into a Corporate-
// Pricing-shaped "Partner School Pricing" table and a generic fee-addon
// table respectively — NOT duplicated pricing math for anything §15
// already covers.
// ============================================================

const db = require("../db/db");
const { getOfferingTypeForClass, getOfferingTypeForProgramme } = require("./offeringTypeSettings");
const { getActiveInstanceIdForClass, getActiveInstanceIdForProgramme, getLearningInstanceById, resolveCombinedPeriodCharge, getEnrolledLearningInstanceIdForLearner } = require("./learningInstances");
const pricingEngine = require("./pricingEngine");

// Resolves which Programme Run (learning_instances), Class, and
// Operational Group govern a learner-like object's fee, exactly as
// before for classId/learningInstanceId — this is context resolution,
// not pricing math, so it stays here. A Class has no learning_instance_id
// column of its own — its governing Run is always resolved via its
// Programme's current Active Run, exactly like every other reader in
// this codebase (getActiveInstanceIdForClass).
//
// Operational Group Tuition Fee override (§11.3/§15.1) is the sole
// authoritative tuition value once one is explicitly set — but until
// this fix, recurring/ad hoc tuition payments (routes/payments.js's
// currentFees() path) never looked it up, so a learner assigned to an
// Operational Group with its own overridden fee was still billed at the
// Programme Run's plain rate for every payment after the one that
// happened to be made at enrollment time (which DOES thread it through
// enrollment.operational_group_id -> the Pricing Snapshot). That was two
// different Final Amount Payable figures for the same learner depending
// on which code path priced them — exactly what §2.1/§15.13 forbid. For
// a persisted learner (one with an `id`, i.e. not a pre-insert batch
// registrant at signup time, which has no Enrollment row yet), their
// primary Enrollment's own operational_group_id is now resolved here so
// every caller of currentFees()/resolvePricing() sees the same
// Operational Group override the original enrollment snapshot did.
function resolveRunContext(learnerLike) {
  const classId = learnerLike && learnerLike.class_id;
  const classRow = classId ? db.prepare("SELECT * FROM classes WHERE id = ?").get(classId) : null;
  let learningInstanceId = null;
  if (learnerLike && learnerLike.id) {
    learningInstanceId = getEnrolledLearningInstanceIdForLearner(learnerLike.id);
  }
  if (!learningInstanceId) {
    learningInstanceId = classId ? getActiveInstanceIdForClass(classId) : (learnerLike && learnerLike.learning_instance_id) || null;
  }
  let operationalGroupId = null;
  if (learnerLike && learnerLike.id) {
    const primaryEnrollment = db
      .prepare("SELECT operational_group_id FROM programme_enrollments WHERE user_id = ? AND is_primary = 1")
      .get(learnerLike.id);
    operationalGroupId = (primaryEnrollment && primaryEnrollment.operational_group_id) || null;
  }
  if (!operationalGroupId) {
    operationalGroupId = (learnerLike && learnerLike.operational_group_id) || null;
  }
  let resolvedProgrammeId = learnerLike && learnerLike.programme_id;
  if (!resolvedProgrammeId && classRow) resolvedProgrammeId = classRow.programme_id;
  if (!resolvedProgrammeId && learningInstanceId) {
    const inst = db.prepare("SELECT programme_id FROM learning_instances WHERE id = ?").get(learningInstanceId);
    if (inst) resolvedProgrammeId = inst.programme_id;
  }
  const offeringType = resolvedProgrammeId ? getOfferingTypeForProgramme(resolvedProgrammeId) : (classId ? getOfferingTypeForClass(classId) : null);

  return { classId: classId || null, classRow, offeringType, learningInstanceId, operationalGroupId };
}

// Legacy, not-yet-constitutional adjustments (see pricingEngine.js's
// applyLegacyRegistrationAdjustments for the full rationale — this is
// now a thin re-export so there is exactly one implementation, not two
// that could drift apart). Applied AFTER the Pricing Engine has resolved
// the Final Amount Payable for the registration component, exactly as
// they always were applied after the old baseFees() calculation —
// preserved for behavioural continuity only.
function applyLegacyRegistrationAdjustments(registrationAmount, learnerLike) {
  return pricingEngine.applyLegacyRegistrationAdjustments(registrationAmount, learnerLike).amount;
}

// Computes a learner's sibling rank among their parent's other learners
// (ordered by joined_date), 1-based. Returns null for an only child/adult
// learner with no parent_id — the Pricing Engine's
// {"type":"sibling_rank_gte"} Discount Policy rule treats null as
// ineligible, exactly matching the old "single-ward parents always pay
// normal rate" business rule.
function resolveSiblingRank(learnerLike) {
  if (!learnerLike || !learnerLike.parent_id) return null;
  const siblings = db
    .prepare("SELECT id FROM users WHERE parent_id = ? AND role = 'learner' ORDER BY joined_date ASC, rowid ASC")
    .all(learnerLike.parent_id);
  if (siblings.length <= 1) return null;
  const idx = siblings.findIndex((s) => s.id === learnerLike.id);
  return idx >= 0 ? idx + 1 : null;
}

// Fees for an EXISTING learner already in the DB (or an in-memory
// candidate carrying the same shape). Returns the same
// { registration, monthly, termly, bootcamp } shape every caller already expects.
function currentFees(learner) {
  const { classId, learningInstanceId, operationalGroupId } = resolveRunContext(learner);
  const siblingRank = resolveSiblingRank(learner);

  const quote = pricingEngine.resolvePricing({
    learningInstanceId,
    classId,
    operationalGroupId,
    userId: learner && learner.id,
    corporateClientId: learner && learner.corporate_client_id,
    siblingRank,
  });

  return {
    registration: applyLegacyRegistrationAdjustments(quote.registration.finalAmountGHS, learner),
    monthly: Math.round(quote.tuition.finalAmountGHS),
    termly: getProgrammeFee("termly", null, classId, operationalGroupId, learningInstanceId),
    bootcamp: Math.round(quote.tuition.finalAmountGHS),
  };
}

// Ward/sibling discount percentages, kept for any caller that still wants
// to display the configured percentage rather than a computed amount.
// Reads it back out of the same Discount Policy rows the Engine itself
// evaluates (category-marked at migration time), rather than a second,
// independent settings lookup — so this can never drift from what the
// Engine actually applies.
function wardDiscountPercents(offeringType) {
  const targetOfferingTypeId = offeringType && offeringType.id;
  const rows = db
    .prepare(
      `SELECT applies_to, discount_value FROM discount_policies
       WHERE is_active = 1 AND eligibility_rule LIKE '%sibling_rank_gte%'
         AND (target_offering_type_id = ? OR target_offering_type_id IS NULL)
       ORDER BY (target_offering_type_id IS NULL) ASC`
    )
    .all(targetOfferingTypeId || null);
  const registration = rows.find((r) => r.applies_to === "registration" || r.applies_to === "both");
  const monthly = rows.find((r) => r.applies_to === "tuition" || r.applies_to === "both");
  return {
    registration: registration ? Number(registration.discount_value) : 0,
    monthly: monthly ? Number(monthly.discount_value) : 0,
  };
}

// Registration fee breakdown for a batch of NEW (not-yet-inserted)
// learners at signup time. Same return shape as before:
// { breakdown: [{ name, amountGHS, discounted }], totalGHS }.
//
// Each entry may carry `sponsored: true` (a Sponsor Account learner —
// see routes/payments.js's combined-charge branch and
// utils/sponsorBulkRegistration.js). The sibling/multi-child Discount
// Policy (§15.7) is a rule about a paying parent's own children
// registering together; a sponsored learner's fee is the Sponsor
// Account's own arrangement, resolved through Corporate/Financial Aid
// Pricing (§15.9/§15.10), never the sibling Discount Policy. A sponsored
// entry therefore never receives a sibling rank itself, and — just as
// importantly — is skipped entirely when assigning rank to everyone
// else, so mixing a sponsored and an unsponsored child in the same
// signup/charge can't shift the unsponsored child's own rank.
function registrationBreakdown(learnerList) {
  let total = 0;
  const unsponsored = learnerList.filter((l) => !l.sponsored);
  let unsponsoredSeen = 0;
  const breakdown = learnerList.map((l) => {
    const learnerLike = {
      campus: l.campus,
      school_name: l.schoolName,
      own_robotics_kit: l.ownRoboticsKit,
      class_id: l.classId || null,
      programme_id: l.programmeId || null,
      learning_instance_id: l.learningInstanceId || null,
      operational_group_id: l.operationalGroupId || null,
    };
    const { classId, learningInstanceId } = resolveRunContext(learnerLike);
    const resolvedProgrammeId =
      l.programmeId ||
      (classId ? (db.prepare("SELECT programme_id FROM classes WHERE id = ?").get(classId) || {}).programme_id : null) ||
      (learningInstanceId ? (db.prepare("SELECT programme_id FROM learning_instances WHERE id = ?").get(learningInstanceId) || {}).programme_id : null);

    let siblingRank = null;
    if (!l.sponsored) {
      unsponsoredSeen += 1;
      siblingRank = unsponsored.length > 1 ? unsponsoredSeen : null;
    }

    // Combined Registration + First Period Payment — see
    // utils/learningInstances.js's resolveCombinedPeriodCharge. Checked
    // before the normal pricing-engine path below; when it applies, this
    // learner's charge IS the Registration Fee (which now also satisfies
    // Period 1), full stop — never discounted the way a sibling's
    // Registration Fee normally would be (this is the Registration Fee
    // wearing a period-payment hat for bookkeeping/access purposes, not
    // a second, independently discountable product).
    const instance = learningInstanceId ? getLearningInstanceById(learningInstanceId) : null;
    const combined = instance ? resolveCombinedPeriodCharge(instance) : null;
    if (combined) {
      total += combined.requiredAmountGHS;
      return {
        name: l.name,
        amountGHS: combined.requiredAmountGHS,
        discounted: false,
        periodId: combined.periodId,
        learningInstanceId,
      };
    }

    const quote = pricingEngine.resolvePricing({
      learningInstanceId,
      classId,
      programmeId: resolvedProgrammeId,
      operationalGroupId: l.operationalGroupId || null,
      siblingRank,
    });

    const amount = applyLegacyRegistrationAdjustments(quote.registration.finalAmountGHS, learnerLike);
    total += amount;
    return { name: l.name, amountGHS: amount, discounted: siblingRank != null && siblingRank > 1, periodId: null, learningInstanceId };
  });
  return { breakdown, totalGHS: total };
}

// Generic configurable fee for the Term/Course/Workshop/Bootcamp fee
// types. Resolves the governing Programme Run (via classId, falling back
// to the Programme's active Run) and asks the Engine for its Tuition
// component — Term/Course/Workshop/Bootcamp fees are all just "the Base
// Tuition Fee of a Run using that cadence", constitutionally no different
// from any other Programme Run's tuition.
const PROGRAMME_FEE_TYPES = ["termly", "course", "workshop", "bootcamp"];

function getProgrammeFee(type, programmeId, classId, operationalGroupId, learningInstanceId) {
  if (!PROGRAMME_FEE_TYPES.includes(type)) return null;
  const resolvedInstanceId =
    learningInstanceId || (classId ? getActiveInstanceIdForClass(classId) : programmeId ? getActiveInstanceIdForProgramme(programmeId) : null);
  const quote = pricingEngine.resolveComponentPricing("tuition", {
    learningInstanceId: resolvedInstanceId,
    classId,
    programmeId,
    operationalGroupId: operationalGroupId || null,
  });
  return Math.round(quote.finalAmountGHS);
}

// Small exported helper so callers outside this file (routes/payments.js's
// Course/Workshop/Bootcamp fee lookup) can resolve the same learner's
// Operational Group without duplicating the primary-Enrollment lookup
// resolveRunContext() already does above — one lookup implementation,
// not a second one growing independently in routes/payments.js.
function getOperationalGroupIdForLearner(learner) {
  return resolveRunContext(learner).operationalGroupId;
}

module.exports = { currentFees, registrationBreakdown, wardDiscountPercents, getProgrammeFee, getOperationalGroupIdForLearner, PROGRAMME_FEE_TYPES };
