// ============================================================
// v41 — Pricing & Financial Policy Framework (ABRS v2.2 §15; resolves
// Appendix Items A-10 and A-11).
//
// Everything this migration adds is config DATA, never code — the point
// of §15 is that a new discount category, a new campaign shape, or a new
// refund rule is a new row in one of these tables, never a new `if`
// branch anywhere in the app. utils/pricingEngine.js is the ONE resolution
// engine (§15.13, §20.1, §20.2) that reads all of it; nothing else in the
// codebase is permitted to compute a Final Amount Payable.
//
// Ownership recap (§15.1, §19): the Institution owns which policy TYPES
// exist (the table shapes below); the Programme Run (learning_instances)
// owns which of those types apply to it and how they're parameterized —
// every policy table below is scoped by a nullable learning_instance_id/
// programme_id/offering_type_id "reach" (NULL = institution-wide default,
// same "NULL = not configured, never inferred" convention used
// everywhere else in this codebase); an Operational Group may override
// ONLY Tuition Fee (already implemented — operational_groups.fee_ghs,
// v39) — nothing here grants it any further override, per §15.1's
// explicit prohibition.
//
// All additions are additive/nullable. No existing table is altered in a
// way that changes existing behaviour; no existing payment record is
// touched or deleted by this migration.
// ============================================================

module.exports = function migratePricing(db, tryAlter) {
  // --- §15.2 Registration Fee (distinctly-tracked from Base Tuition Fee) ---
  // Base Tuition Fee already exists as learning_instances.fee_ghs (v31).
  // Early Bird (§15.5) is date-driven off the Run's own configured window —
  // never a manual toggle, never inferred from any business identifier.
  tryAlter("ALTER TABLE learning_instances ADD COLUMN registration_fee_ghs INTEGER");
  tryAlter("ALTER TABLE learning_instances ADD COLUMN early_bird_deadline TEXT"); // ISO datetime; NULL = Early Bird not configured for this Run
  tryAlter("ALTER TABLE learning_instances ADD COLUMN early_bird_amount_ghs INTEGER"); // discrete override amount; takes precedence over percent when both set
  tryAlter("ALTER TABLE learning_instances ADD COLUMN early_bird_percent REAL"); // percentage-off Base Tuition Fee (post Operational Group override, per §15.5)

  db.exec(`
-- §15.3 Installment Configuration — the MECHANICS of dividing a Run's fees
-- (how many installments, their amounts/percentages, and due dates
-- relative to the Run's Academic Calendar). Programme-Run-owned.
CREATE TABLE IF NOT EXISTS installment_configurations (
  id                  TEXT PRIMARY KEY,
  learning_instance_id TEXT NOT NULL REFERENCES learning_instances(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  -- JSON array of { label, percent (0-100) OR amount_ghs, due_offset_days }
  -- due_offset_days is relative to the Run's Academic Calendar start —
  -- never a hardcoded calendar date baked into code.
  schedule            TEXT NOT NULL,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_installment_configurations_instance ON installment_configurations(learning_instance_id);

-- §15.4 Payment Plans — distinct from Installments: WHEN and UNDER WHAT
-- CONDITIONS payment occurs, layered on top of a chosen Installment
-- Configuration. eligibility_rule is data (evaluated generically by the
-- engine, never a name-keyed branch) e.g. {"requires":"corporate"} or
-- {"requires":"financial_aid"} or {"requires":null} (open to everyone).
CREATE TABLE IF NOT EXISTS payment_plans (
  id                          TEXT PRIMARY KEY,
  learning_instance_id        TEXT NOT NULL REFERENCES learning_instances(id) ON DELETE CASCADE,
  installment_configuration_id TEXT REFERENCES installment_configurations(id), -- NULL = single lump-sum plan (no installments)
  name                        TEXT NOT NULL,
  eligibility_rule            TEXT, -- JSON, data-driven; NULL = eligible to every learner on this Run
  late_payment_policy         TEXT, -- JSON (e.g. {"gracePeriodDays":7,"lateFeeGHS":50}); NULL = none configured
  is_default                  INTEGER NOT NULL DEFAULT 0,
  is_active                   INTEGER NOT NULL DEFAULT 1,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_plans_instance ON payment_plans(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_payment_plans_installment_config ON payment_plans(installment_configuration_id);

-- §15.6 Promotional Campaigns — targeting criteria and discount effect are
-- both DATA; the engine evaluates a learner's Enrollment context against
-- every currently-active Campaign's targeting fields, never a name- or
-- identifier-keyed code branch. Every target_* column is nullable — NULL
-- means "not restricted on this dimension" (matches everything).
CREATE TABLE IF NOT EXISTS promotional_campaigns (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  starts_at             TEXT, -- NULL = no start restriction
  ends_at               TEXT, -- NULL = no end restriction
  target_offering_type_id TEXT REFERENCES learning_offering_types(id),
  target_programme_id   TEXT REFERENCES programmes(id),
  target_learning_instance_id TEXT REFERENCES learning_instances(id),
  target_course_id      TEXT REFERENCES courses(id),
  target_audience       TEXT, -- data value only (e.g. 'all' | 'new_learners' | 'returning_learners'); never branched on by name outside the generic audience evaluator
  discount_type         TEXT NOT NULL CHECK (discount_type IN ('percentage','fixed_amount')),
  discount_value        REAL NOT NULL,
  stacking_group        TEXT, -- Campaigns sharing a non-null group are mutually exclusive (best-for-learner one wins); NULL = its own exclusive group of one
  priority              INTEGER NOT NULL DEFAULT 0, -- tie-break when more than one otherwise-eligible Campaign in the same stacking_group applies; higher wins
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_instance ON promotional_campaigns(target_learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_programme ON promotional_campaigns(target_programme_id);
CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_offering_type ON promotional_campaigns(target_offering_type_id);
CREATE INDEX IF NOT EXISTS idx_promotional_campaigns_active_window ON promotional_campaigns(is_active, starts_at, ends_at);

-- §15.7 Discount Policy Engine — the constitutional home for EVERY
-- named-category discount (multi-child, sibling, alumni, returning
-- learner, staff, corporate, partner, merit, need-based, loyalty, and any
-- future category). "category" is a free-text ADMIN LABEL only, purely
-- for display — the engine never switches on it. eligibility_rule is the
-- generic, data-driven rule the engine actually evaluates (§2.2's
-- "CORRECT" pattern: applyDiscountPolicy(discountPolicy.rules) — rules
-- are data). Supported eligibility_rule "type" values are themselves a
-- fixed, generic computation-strategy vocabulary (not a business-identifier
-- vocabulary) — adding a new discount CATEGORY never needs a new rule
-- type, only a new row using an existing one:
--   {"type":"sibling_rank_gte","rank":2}   — nth-and-later ward of a parent
--   {"type":"flag","flag":"is_staff"}      — users.<flag> style boolean flag
--   {"type":"manual_grant"}                — requires a discount_grants row
--   {"type":"always"}                      — unconditional, applies to everyone in scope
CREATE TABLE IF NOT EXISTS discount_policies (
  id                    TEXT PRIMARY KEY,
  category              TEXT NOT NULL, -- admin-facing label only, e.g. "Sibling", "Staff", "Alumni"
  eligibility_rule      TEXT NOT NULL, -- JSON, see above
  discount_type         TEXT NOT NULL CHECK (discount_type IN ('percentage','fixed_amount')),
  discount_value        REAL NOT NULL,
  applies_to            TEXT NOT NULL DEFAULT 'tuition' CHECK (applies_to IN ('tuition','registration','both')),
  stacking_group        TEXT, -- Discount Policies sharing a non-null group are mutually exclusive (best value wins); NULL = always stacks with every other policy
  target_offering_type_id TEXT REFERENCES learning_offering_types(id), -- NULL = institution-wide
  target_programme_id   TEXT REFERENCES programmes(id),
  target_learning_instance_id TEXT REFERENCES learning_instances(id),
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discount_policies_instance ON discount_policies(target_learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_discount_policies_programme ON discount_policies(target_programme_id);
CREATE INDEX IF NOT EXISTS idx_discount_policies_offering_type ON discount_policies(target_offering_type_id);

-- A manual grant of a specific Discount Policy to a specific learner —
-- backs the {"type":"manual_grant"} eligibility rule above. Admin-driven,
-- never inferred.
CREATE TABLE IF NOT EXISTS discount_grants (
  id                 TEXT PRIMARY KEY,
  discount_policy_id TEXT NOT NULL REFERENCES discount_policies(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by         TEXT REFERENCES users(id),
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discount_grants_policy ON discount_grants(discount_policy_id);
CREATE INDEX IF NOT EXISTS idx_discount_grants_user ON discount_grants(user_id);

-- §15.8 Scholarship Policies — percentage | fixed_amount | full | partial |
-- fee_waiver. Always admin-granted to a specific learner (a Scholarship is
-- never institution-wide-automatic the way a Discount Policy rule can be);
-- coexists with Early Bird/Campaign/Discount evaluation per §15.13 rather
-- than short-circuiting it, even when its effect is to zero out the price.
CREATE TABLE IF NOT EXISTS scholarship_policies (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('percentage','fixed_amount','full','partial','fee_waiver')),
  value          REAL, -- percentage (0-100) or fixed GHS amount; NULL for type='full'/'fee_waiver' (value is implicitly 100%/whole fee)
  applies_to     TEXT NOT NULL DEFAULT 'tuition' CHECK (applies_to IN ('tuition','registration','both')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS scholarship_grants (
  id                    TEXT PRIMARY KEY,
  scholarship_policy_id TEXT NOT NULL REFERENCES scholarship_policies(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  learning_instance_id  TEXT REFERENCES learning_instances(id), -- NULL = applies wherever this learner enrolls; set = scoped to one Run
  granted_by            TEXT REFERENCES users(id),
  note                  TEXT,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scholarship_grants_user ON scholarship_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_scholarship_grants_policy ON scholarship_grants(scholarship_policy_id);

-- §15.9 Financial Aid Policies — distinct in source/administration from
-- Scholarships (institution/programme-administered need-based assistance
-- rather than merit/category), identical in constitutional treatment:
-- configurable, never hardcoded, evaluated after Scholarships and before
-- Taxes (§15.13).
CREATE TABLE IF NOT EXISTS financial_aid_policies (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('percentage','fixed_amount','full','partial','fee_waiver')),
  value          REAL,
  applies_to     TEXT NOT NULL DEFAULT 'tuition' CHECK (applies_to IN ('tuition','registration','both')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS financial_aid_grants (
  id                      TEXT PRIMARY KEY,
  financial_aid_policy_id TEXT NOT NULL REFERENCES financial_aid_policies(id) ON DELETE CASCADE,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  learning_instance_id    TEXT REFERENCES learning_instances(id),
  granted_by              TEXT REFERENCES users(id),
  note                    TEXT,
  is_active               INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_financial_aid_grants_user ON financial_aid_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_financial_aid_grants_policy ON financial_aid_grants(financial_aid_policy_id);

-- §15.10 Corporate Pricing — an organization's negotiated rate against the
-- SAME Programme Run every other learner enrolls into (never a parallel,
-- org-specific Run). Exactly one of learning_instance_id/target_programme_id/
-- target_offering_type_id is set, per how broad the negotiation is
-- (Run-specific, Programme-wide, or Offering-Type-wide). Enters §15.13 at
-- the Base Pricing step, as an alternative base rate — never an
-- additional discount layer on top of the standard learner's Base
-- Pricing.
CREATE TABLE IF NOT EXISTS corporate_pricing (
  id                      TEXT PRIMARY KEY,
  corporate_client_id     TEXT NOT NULL REFERENCES corporate_clients(id) ON DELETE CASCADE,
  learning_instance_id    TEXT REFERENCES learning_instances(id),
  target_programme_id     TEXT REFERENCES programmes(id),
  target_offering_type_id TEXT REFERENCES learning_offering_types(id),
  rate_type               TEXT NOT NULL CHECK (rate_type IN ('fixed_amount','percentage_discount')),
  rate_value              REAL NOT NULL, -- fixed_amount: the negotiated Base Tuition Fee in GHS; percentage_discount: % off the standard Base Tuition Fee
  is_active               INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (learning_instance_id IS NOT NULL AND target_programme_id IS NULL AND target_offering_type_id IS NULL) OR
    (learning_instance_id IS NULL AND target_programme_id IS NOT NULL AND target_offering_type_id IS NULL) OR
    (learning_instance_id IS NULL AND target_programme_id IS NULL AND target_offering_type_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_corporate_pricing_client ON corporate_pricing(corporate_client_id);
CREATE INDEX IF NOT EXISTS idx_corporate_pricing_instance ON corporate_pricing(learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_corporate_pricing_programme ON corporate_pricing(target_programme_id);
CREATE INDEX IF NOT EXISTS idx_corporate_pricing_offering_type ON corporate_pricing(target_offering_type_id);

-- §15.11 Refund Policies — applied AFTER Final Amount Payable has been
-- paid and a refund is subsequently requested; not a step in the pricing
-- resolution sequence itself. Scoped like every other policy table (NULL
-- reach columns = institution-wide default; a Run-scoped row wins over a
-- Programme-scoped row, which wins over an Offering-Type-scoped row,
-- which wins over the institution-wide default — resolved by
-- pricingEngine.resolveRefundPolicy, the one place this precedence is
-- implemented).
CREATE TABLE IF NOT EXISTS refund_policies (
  id                           TEXT PRIMARY KEY,
  name                         TEXT NOT NULL,
  target_offering_type_id      TEXT REFERENCES learning_offering_types(id),
  target_programme_id          TEXT REFERENCES programmes(id),
  target_learning_instance_id  TEXT REFERENCES learning_instances(id),
  refund_window_days           INTEGER, -- relative to the Run's Academic Calendar start; NULL = unconditional/no window restriction
  refund_percent               REAL NOT NULL DEFAULT 100, -- % of the paid amount returned, within the window
  conditions                   TEXT, -- free-text/JSON description of qualifying circumstances an admin evaluates manually when approving a refund request; not machine-evaluated
  non_refundable_components    TEXT, -- JSON array, subset of ["registration_fee"]; amounts this policy excludes from any refund regardless of window/percent (§15.2)
  is_default                   INTEGER NOT NULL DEFAULT 0,
  is_active                    INTEGER NOT NULL DEFAULT 1,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refund_policies_instance ON refund_policies(target_learning_instance_id);
CREATE INDEX IF NOT EXISTS idx_refund_policies_programme ON refund_policies(target_programme_id);
CREATE INDEX IF NOT EXISTS idx_refund_policies_offering_type ON refund_policies(target_offering_type_id);

-- Refund records — a NEW row per processed refund, referencing the
-- original Payment it refunds. The original payments row is NEVER
-- mutated or deleted (constitutional requirement: "Preserve existing
-- payment records") — a refund is always an additional, auditable fact
-- layered on top of it, exactly like Promotion never overwrites
-- Enrollment history (§2.1's Enrollment/Promotion precedent).
CREATE TABLE IF NOT EXISTS refunds (
  id                       TEXT PRIMARY KEY,
  payment_id               TEXT NOT NULL REFERENCES payments(id),
  programme_enrollment_id  TEXT REFERENCES programme_enrollments(id),
  refund_policy_id         TEXT REFERENCES refund_policies(id), -- the policy actually applied, snapshotted by id for audit; NULL only for a manual override refund with no configured policy in scope
  amount_ghs               REAL NOT NULL,
  reason                   TEXT,
  status                   TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','rejected')),
  processed_by             TEXT REFERENCES users(id),
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_enrollment ON refunds(programme_enrollment_id);
`);

  // §17 Enrollment — Pricing Snapshot and Financial Policy Snapshot. Exist
  // because pricing policy changes over time while an already-enrolled
  // learner's terms must not silently change underneath them; these are
  // the authoritative record of what a specific learner was actually
  // charged and under what terms, from the moment of enrollment onward —
  // never a live re-evaluation of §15.13 after the fact.
  tryAlter("ALTER TABLE programme_enrollments ADD COLUMN pricing_snapshot TEXT"); // JSON — see pricingEngine.js buildPricingSnapshot()
  tryAlter("ALTER TABLE programme_enrollments ADD COLUMN financial_policy_snapshot TEXT"); // JSON: { paymentPlanId, installmentConfigurationId, refundPolicyId }

  // ----------------------------------------------------------------
  // Backfill 1 — consolidate Base Tuition Fee / Registration Fee onto the
  // Programme Run (learning_instances.fee_ghs/registration_fee_ghs), its
  // sole constitutional owner (§15.1, §19), completing what utils/fees.js
  // used to do per-call via a multi-source fallback chain (Class override
  // -> Offering Type settings -> legacy global Site Settings). This is the
  // exact same "backfill once, then the Run is self-sufficient" pattern
  // the v40 Registration Window migration used. Only ever fills a NULL —
  // a Run that already has its own fee_ghs/registration_fee_ghs keeps it
  // untouched, and legacy Site Settings/Offering Type fee keys are left
  // in place (read-only historical record), never deleted.
  // ----------------------------------------------------------------
  {
    const { getSetting } = require("../utils/settings");
    const { getOfferingTypeById } = require("../utils/offeringTypeSettings");
    const legacyFees = getSetting("fees", {});
    const programmeFees = getSetting("programmeFees", {});
    const programmeFeeDefaults = getSetting("programmeFeeDefaults", {});

    const runs = db.prepare(`SELECT * FROM learning_instances WHERE fee_ghs IS NULL OR registration_fee_ghs IS NULL`).all();
    const updateRun = db.prepare(`UPDATE learning_instances SET fee_ghs = ?, registration_fee_ghs = ?, updated_at = datetime('now') WHERE id = ?`);
    let consolidated = 0;
    runs.forEach((run) => {
      const offeringType = run.offering_type_id ? getOfferingTypeById(run.offering_type_id) : null;
      const typeFees = (offeringType && offeringType.settings && offeringType.settings.fees) || {};
      const perProgramme = (run.programme_id && programmeFees[run.programme_id]) || {};

      const resolvedTuition =
        run.fee_ghs != null
          ? run.fee_ghs
          : typeFees.monthlyGHS ?? perProgramme.termly ?? programmeFeeDefaults.termly ?? legacyFees.monthlyGHS ?? null;
      const resolvedRegistration =
        run.registration_fee_ghs != null
          ? run.registration_fee_ghs
          : typeFees.registrationGHS ?? typeFees.oneTimeFeeGHS ?? legacyFees.registrationGHS ?? null;

      if (resolvedTuition != null || resolvedRegistration != null) {
        updateRun.run(
          resolvedTuition != null ? Number(resolvedTuition) : run.fee_ghs,
          resolvedRegistration != null ? Number(resolvedRegistration) : run.registration_fee_ghs,
          run.id
        );
        consolidated += 1;
      }
    });
    console.log(`✅ Base Tuition Fee / Registration Fee ownership consolidated onto the Programme Run (${consolidated} Run(s) backfilled from legacy Offering Type/Site Settings fee configuration — ABRS v2.2 §15.1/§19).`);
  }

  // ----------------------------------------------------------------
  // Backfill 2 — migrate the legacy "ward/sibling discount" Site Settings
  // and per-Offering-Type siblingDiscountPercent into real, queryable
  // Discount Policy rows (§15.7), so the sibling discount becomes actual
  // configuration data the one Pricing Engine resolves generically via
  // the {"type":"sibling_rank_gte"} eligibility rule, instead of bespoke
  // code in utils/fees.js. Idempotent: guarded by a fixed `category`
  // marker so re-running this migration never creates duplicates.
  // ----------------------------------------------------------------
  {
    const { getSetting } = require("../utils/settings");
    const MARKER = "Sibling Discount (migrated from legacy Site Settings)";
    const alreadyMigrated = db.prepare(`SELECT 1 FROM discount_policies WHERE category = ? LIMIT 1`).get(MARKER);
    if (!alreadyMigrated) {
      const legacyFees = getSetting("fees", {});
      const insertPolicy = db.prepare(
        `INSERT INTO discount_policies (id, category, eligibility_rule, discount_type, discount_value, applies_to, target_offering_type_id, is_active)
         VALUES (?, ?, ?, 'percentage', ?, ?, ?, 1)`
      );
      const rule = JSON.stringify({ type: "sibling_rank_gte", rank: 2 });
      let migratedCount = 0;

      // Per-Offering-Type override (kept separate per type, since each
      // type may configure its own siblingDiscountPercent).
      const { getOfferingTypeById } = require("../utils/offeringTypeSettings");
      db.prepare(`SELECT id FROM learning_offering_types`)
        .all()
        .forEach((t) => {
          const offeringType = getOfferingTypeById(t.id);
          const pct = Number(offeringType && offeringType.settings && offeringType.settings.fees && offeringType.settings.fees.siblingDiscountPercent);
          if (pct > 0) {
            insertPolicy.run(uuid(), MARKER, rule, pct, "both", t.id);
            migratedCount += 1;
          }
        });

      // Legacy institution-wide fallback (registration/monthly discount
      // percentages), only where no Offering-Type-level policy already
      // covers it and the legacy value is actually set.
      const globalRegPct = Number(legacyFees.registrationDiscountPercent) || 0;
      const globalMonthlyPct = Number(legacyFees.monthlyDiscountPercent) || 0;
      if (globalRegPct > 0) {
        insertPolicy.run(uuid(), MARKER, rule, globalRegPct, "registration", null);
        migratedCount += 1;
      }
      if (globalMonthlyPct > 0 && globalMonthlyPct !== globalRegPct) {
        insertPolicy.run(uuid(), MARKER, rule, globalMonthlyPct, "tuition", null);
        migratedCount += 1;
      } else if (globalMonthlyPct > 0 && globalMonthlyPct === globalRegPct) {
        // Same percentage for both components — the registration row above
        // already used applies_to='registration'; add the tuition leg too
        // so both components are covered by explicit config rows.
        insertPolicy.run(uuid(), MARKER, rule, globalMonthlyPct, "tuition", null);
        migratedCount += 1;
      }
      console.log(`✅ Legacy sibling/ward discount settings migrated into ${migratedCount} Discount Policy row(s) (§15.7) — utils/fees.js no longer computes this bespoke; the Pricing Engine resolves it generically.`);
    }
  }

  console.log(
    "✅ Pricing & Financial Policy Framework ready (installment_configurations, payment_plans, promotional_campaigns, discount_policies/discount_grants, scholarship_policies/scholarship_grants, financial_aid_policies/financial_aid_grants, corporate_pricing, refund_policies, refunds; learning_instances.registration_fee_ghs/early_bird_*; programme_enrollments.pricing_snapshot/financial_policy_snapshot — ABRS v2.2 §15, resolves Appendix A-10/A-11)."
  );
};
