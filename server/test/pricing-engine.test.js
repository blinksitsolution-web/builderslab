/**
 * ABRS v2.2 §15 (Pricing & Financial Policy Framework) compliance
 * coverage. Targets the two consistency defects this session's audit
 * found and fixed in utils/pricingEngine.js / utils/fees.js:
 *
 *   1. An Operational Group's Tuition Fee override (§11.3/§15.1) was
 *      honoured at enrollment time (the Pricing Snapshot) but silently
 *      dropped on every later recurring/ad hoc tuition payment, because
 *      utils/fees.js's resolveRunContext() never looked up the learner's
 *      own Enrollment to find which Operational Group governs them.
 *   2. The legacy own-robotics-kit surcharge / partner-school rate
 *      (applied after the Engine computes Final Amount Payable) was
 *      reflected in the actual amount charged but NOT in the persisted
 *      §17 Pricing Snapshot — two different numbers for one Enrollment.
 *
 * Both are "ONE and ONLY ONE pricing computation path" violations
 * (§2.1/§15.13/§20.2): the same learner priced two different ways by two
 * different call sites. Also includes a direct §15.13 resolution-order
 * sanity check (Base -> Operational Group Override -> Early Bird ->
 * Campaign -> Discount -> Scholarship -> Financial Aid) exercised
 * against a real temp DB, since no dedicated engine test existed before
 * this session.
 *
 * Uses direct require()s against a fresh migrated temp DB (no spawned
 * server needed — this is engine-level, not endpoint-level, coverage).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { v4: uuid } = require("uuid");

const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");

function freshDb() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-pricing-test-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = { ...process.env, NODE_ENV: "production", DB_PATH: dbPath, JWT_SECRET: "pricing-test-secret", AI_CREDENTIALS_KEY: "pricing-test-ai-key-not-for-real-use" };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  process.env.DB_PATH = dbPath;
  // Every required module below caches its own `require("../db/db")`
  // connection at first require — force a fresh module registry per test
  // so each test's own temp DB is what every module actually reads/writes,
  // matching the isolation every other real-server-process test file in
  // this suite gets via a spawned child process, without the overhead of
  // actually spawning one (this is engine-level unit coverage).
  Object.keys(require.cache).forEach((k) => delete require.cache[k]);
  const db = require("../src/db/db");
  const pricingEngine = require("../src/utils/pricingEngine");
  const fees = require("../src/utils/fees");
  return { dbDir, db, pricingEngine, fees };
}

function cleanup(dbDir) {
  fs.rmSync(dbDir, { recursive: true, force: true });
}

// Seeds a Programme -> active Programme Run (fee_ghs=1000) -> Operational
// Group (fee_ghs override=650) -> a learner already enrolled into it, plus
// a second, un-enrolled Operational Group-less class, for baseline
// comparison.
function seedRunWithOperationalGroupOverride(db) {
  const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
  const programmeId = uuid();
  db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Pricing Test Programme', 0)").run(programmeId, offeringType.id);

  const instanceId = uuid();
  db.prepare(
    `INSERT INTO learning_instances (id, offering_type_id, programme_id, status, fee_ghs, registration_fee_ghs)
     VALUES (?, ?, ?, 'active', 1000, 100)`
  ).run(instanceId, offeringType.id, programmeId);
  db.prepare(
    `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
     VALUES (?, ?, 'programme', ?, 1, 'active')`
  ).run(uuid(), instanceId, programmeId);

  const classId = uuid();
  db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Foundation', 0, ?)").run(classId, programmeId);

  const groupId = uuid();
  db.prepare(
    `INSERT INTO operational_groups (id, learning_instance_id, name, fee_ghs) VALUES (?, ?, 'Weekend Batch', 650)`
  ).run(groupId, instanceId);

  const learnerId = uuid();
  db.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, class_id, campus)
     VALUES (?, 'learner', 'Pricing Test Learner', 'pricing-test@example.test', 'x', 'active', 'unpaid', 1, 'PRC-0001', date('now'), ?, 'Main Campus')`
  ).run(learnerId, classId);

  const enrollmentId = uuid();
  db.prepare(
    `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id, operational_group_id)
     VALUES (?, ?, ?, ?, 1, 'active', 'unpaid', date('now'), ?, ?)`
  ).run(enrollmentId, learnerId, programmeId, classId, instanceId, groupId);

  return { programmeId, instanceId, classId, groupId, learnerId };
}

// ---------------------------------------------------------------------
// Fix 1 — Operational Group Tuition override must hold in recurring
// billing, not just at enrollment time.
// ---------------------------------------------------------------------

test("pricing: currentFees() honours the learner's Operational Group Tuition override (§11.3/§15.1), not just the Run's plain rate", () => {
  const { dbDir, db, fees } = freshDb();
  try {
    const fx = seedRunWithOperationalGroupOverride(db);
    const learner = db.prepare("SELECT * FROM users WHERE id = ?").get(fx.learnerId);

    const result = fees.currentFees(learner);
    // The Run's plain fee_ghs is 1000; the Operational Group this learner
    // is actually enrolled into overrides it to 650. Recurring billing
    // must charge 650, matching what their enrollment-time Pricing
    // Snapshot already recorded — not silently fall back to the Run rate.
    assert.equal(result.monthly, 650, "currentFees() must resolve the learner's own Operational Group override, not the Run's plain rate");
  } finally {
    cleanup(dbDir);
  }
});

test("pricing: a learner in a Programme Run with NO Operational Group override still gets the plain Run rate (regression guard)", () => {
  const { dbDir, db, fees } = freshDb();
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Plain Rate Programme', 0)").run(programmeId, offeringType.id);
    const instanceId = uuid();
    db.prepare(`INSERT INTO learning_instances (id, offering_type_id, programme_id, status, fee_ghs, registration_fee_ghs) VALUES (?, ?, ?, 'active', 800, 350)`).run(instanceId, offeringType.id, programmeId);
    db.prepare(`INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')`).run(uuid(), instanceId, programmeId);
    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Foundation', 0, ?)").run(classId, programmeId);
    const learnerId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, class_id)
       VALUES (?, 'learner', 'Plain Rate Learner', 'plain-rate@example.test', 'x', 'active', 'unpaid', 1, 'PRC-0002', date('now'), ?)`
    ).run(learnerId, classId);
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id)
       VALUES (?, ?, ?, ?, 1, 'active', 'unpaid', date('now'), ?)`
    ).run(uuid(), learnerId, programmeId, classId, instanceId);

    const learner = db.prepare("SELECT * FROM users WHERE id = ?").get(learnerId);
    const result = fees.currentFees(learner);
    assert.equal(result.monthly, 800);
  } finally {
    cleanup(dbDir);
  }
});

// ---------------------------------------------------------------------
// Fix 2 — Pricing Snapshot must equal the actual amount charged.
// ---------------------------------------------------------------------

test("pricing: the §17 Pricing Snapshot's registration figure matches the actual amount charged for an own_robotics_kit learner", () => {
  const { dbDir, db, pricingEngine } = freshDb();
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Kit Test Programme', 0)").run(programmeId, offeringType.id);
    const instanceId = uuid();
    db.prepare(`INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 300)`).run(instanceId, offeringType.id, programmeId);
    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Foundation', 0, ?)").run(classId, programmeId);

    const context = {
      learningInstanceId: instanceId,
      classId,
      legacyAdjustmentContext: { campus: "Main Campus", school_name: null, own_robotics_kit: true },
    };

    const snapshotJSON = pricingEngine.buildPricingSnapshot(context);
    const snapshot = JSON.parse(snapshotJSON);

    // Raw §15.13 registration figure (300) is preserved for audit...
    assert.equal(snapshot.registration.legacyAdjustment.preAdjustmentAmountGHS, 300);
    // ...but the figure actually used for finalAmountGHS/finalAmountPayableGHS
    // reflects the same +200 robotics-kit surcharge the learner is really
    // charged (utils/fees.js's applyLegacyRegistrationAdjustments, now the
    // single implementation pricingEngine.js also calls).
    assert.equal(snapshot.registration.finalAmountGHS, 500, "snapshot must reflect the surcharge actually charged, not the pre-adjustment figure");
    // finalAmountPayableGHS = tuition (180, the legacy site-wide default —
    // this Run never configured its own fee_ghs) + the now-adjusted
    // registration figure (500), confirming buildPricingSnapshot()
    // recomputes the total from the adjusted figure, not the raw one.
    assert.equal(snapshot.tuition.finalAmountGHS, 180);
    assert.equal(snapshot.finalAmountPayableGHS, 680);
    assert.ok(
      snapshot.registration.legacyAdjustment.notes.some((n) => n.type === "own_robotics_kit_surcharge"),
      "the adjustment must be recorded, clearly labeled as legacy/non-§15.13, not silently folded in"
    );
  } finally {
    cleanup(dbDir);
  }
});

test("pricing: a learner with no legacy-adjustment triggers gets an unmodified snapshot (regression guard)", () => {
  const { dbDir, db, pricingEngine } = freshDb();
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'No Kit Programme', 0)").run(programmeId, offeringType.id);
    const instanceId = uuid();
    db.prepare(`INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 300)`).run(instanceId, offeringType.id, programmeId);

    const snapshot = JSON.parse(
      pricingEngine.buildPricingSnapshot({
        learningInstanceId: instanceId,
        legacyAdjustmentContext: { campus: "Main Campus", school_name: null, own_robotics_kit: false },
      })
    );
    assert.equal(snapshot.registration.finalAmountGHS, 300);
    assert.equal(snapshot.registration.legacyAdjustment, undefined, "no adjustment applied => no legacyAdjustment key at all");
  } finally {
    cleanup(dbDir);
  }
});

// ---------------------------------------------------------------------
// §15.13 resolution order sanity check — Base -> Operational Group
// Override -> Early Bird -> Campaign -> Discount -> Scholarship ->
// Financial Aid, each step visibly acting on the previous step's output.
// ---------------------------------------------------------------------

test("pricing: §15.13 resolution order — Early Bird, Campaign, Discount, Scholarship and Financial Aid each apply in sequence against the prior step's output", () => {
  const { dbDir, db, pricingEngine } = freshDb();
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Order Test Programme', 0)").run(programmeId, offeringType.id);
    const instanceId = uuid();
    // Base 1000, Early Bird -> 20% off -> 800.
    db.prepare(
      `INSERT INTO learning_instances (id, offering_type_id, programme_id, status, fee_ghs, early_bird_deadline, early_bird_percent)
       VALUES (?, ?, ?, 'active', 1000, '2999-01-01T00:00:00.000Z', 20)`
    ).run(instanceId, offeringType.id, programmeId);

    // Campaign: 10% off tuition, institution-wide. 800 -> 720.
    db.prepare(
      `INSERT INTO promotional_campaigns (id, name, discount_type, discount_value, is_active) VALUES (?, 'Launch Promo', 'percentage', 10, 1)`
    ).run(uuid());

    const userId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date)
       VALUES (?, 'learner', 'Order Test Learner', 'order-test@example.test', 'x', 'active', 'unpaid', 1, 'PRC-0003', date('now'))`
    ).run(userId);

    // Discount Policy: always-eligible, fixed GHS 50 off tuition. 720 -> 670.
    db.prepare(
      `INSERT INTO discount_policies (id, category, eligibility_rule, discount_type, discount_value, applies_to, is_active)
       VALUES (?, 'Loyalty', '{"type":"always"}', 'fixed_amount', 50, 'tuition', 1)`
    ).run(uuid());

    // Scholarship: 50% off whatever remains. 670 -> 335.
    const scholarshipPolicyId = uuid();
    db.prepare(`INSERT INTO scholarship_policies (id, name, type, value, applies_to, is_active) VALUES (?, 'Merit', 'percentage', 50, 'tuition', 1)`).run(scholarshipPolicyId);
    db.prepare(`INSERT INTO scholarship_grants (id, scholarship_policy_id, user_id, is_active) VALUES (?, ?, ?, 1)`).run(uuid(), scholarshipPolicyId, userId);

    // Financial Aid: fixed GHS 100 off whatever remains after Scholarship. 335 -> 235.
    const aidPolicyId = uuid();
    db.prepare(`INSERT INTO financial_aid_policies (id, name, type, value, applies_to, is_active) VALUES (?, 'Need-Based Aid', 'fixed_amount', 100, 'tuition', 1)`).run(aidPolicyId);
    db.prepare(`INSERT INTO financial_aid_grants (id, financial_aid_policy_id, user_id, is_active) VALUES (?, ?, ?, 1)`).run(uuid(), aidPolicyId, userId);

    const quote = pricingEngine.resolveComponentPricing("tuition", { learningInstanceId: instanceId, userId });

    assert.equal(quote.baseAmountGHS, 1000);
    assert.equal(quote.earlyBird.type, "percent");
    assert.equal(quote.campaigns.length, 1);
    assert.equal(quote.discounts.length, 1);
    assert.equal(quote.scholarships.length, 1);
    assert.equal(quote.financialAid.length, 1);
    // Step-by-step: 1000 -(20%)-> 800 -(10%)-> 720 -(-50)-> 670 -(50%)-> 335 -(-100)-> 235.
    assert.equal(quote.finalAmountGHS, 235, "each policy type must apply in exact §15.13 order against the prior step's output");
  } finally {
    cleanup(dbDir);
  }
});

test("pricing: an Operational Group Tuition override is the sole authoritative Base figure and bypasses Corporate Pricing entirely (§11.3/§15.1/§15.13)", () => {
  const { dbDir, db, pricingEngine } = freshDb();
  try {
    const fx = seedRunWithOperationalGroupOverride(db);
    const clientId = uuid();
    db.prepare("INSERT INTO corporate_clients (id, name) VALUES (?, 'Test Corp')").run(clientId);
    // A Corporate rate that would otherwise apply — but the OG override
    // (650) must win outright, never treated as a further reduction on
    // top of a corporate base (§15.13's explicit rule).
    db.prepare(
      `INSERT INTO corporate_pricing (id, corporate_client_id, learning_instance_id, rate_type, rate_value, is_active)
       VALUES (?, ?, ?, 'fixed_amount', 400, 1)`
    ).run(uuid(), clientId, fx.instanceId);

    const quote = pricingEngine.resolveComponentPricing("tuition", {
      learningInstanceId: fx.instanceId,
      operationalGroupId: fx.groupId,
      corporateClientId: clientId,
    });
    assert.equal(quote.corporatePricingApplied, null, "Corporate Pricing must not apply when an explicit Operational Group override exists");
    assert.equal(quote.operationalGroupOverrideGHS, 650);
    assert.equal(quote.finalAmountGHS, 650);
  } finally {
    cleanup(dbDir);
  }
});
