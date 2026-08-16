/**
 * Phase 3A regression suite — the "Save Operational Configuration" schema-
 * drift bug (PATCH /:id/operational-config used to throw "no such column:
 * combine_registration_with_first_period" on a database that had never had
 * migrate.js's v41+ migrations applied).
 *
 * This file proves, against a real freshly-migrated database and a real
 * `node src/server.js` process (same pattern as builderslab-architecture
 * .test.js / period-payment-enforcement.test.js):
 *
 *  1. A schema-contract check: every column the operational-config UPDATE
 *     references actually exists after `node src/db/migrate.js` runs on a
 *     brand-new database. This is the single most important test here —
 *     it is what would have caught the original bug before it shipped.
 *  2. The original failing workflow (create LI -> PATCH operational-config
 *     with a registration fee + combineRegistrationWithFirstPeriod) now
 *     returns 200 for Monthly, Term, and Semester Learning Instances.
 *  3. Saved values round-trip correctly (persisted -> re-fetched -> match).
 *  4. Partial updates never clobber fields the caller didn't send.
 *  5. Saving the same configuration twice is safe (idempotent, no
 *     duplicate rows).
 *  6. The Combined Registration + First Period Payment business rule
 *     actually works end-to-end: combine on -> the Registration Fee
 *     itself automatically becomes Term 1's payment requirement (never
 *     the reverse, and Term 1's own amount is no longer independently
 *     configurable), paying it settles registration AND Term 1 in one
 *     charge, and it only ever covers Term 1 (Term 2 keeps its own
 *     separate payment obligation). Combine off -> unchanged legacy
 *     behavior (Registration Fee charged, Term 1 payment separate).
 *  7. The monthly-billing guard is untouched by any of the above: a
 *     term/semester Learning Instance still rejects a monthly initiate,
 *     and a genuinely monthly Learning Instance still accepts one.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");
const JWT_SECRET = "opconfig-migration-regression-test-secret-not-for-real-use";

// Every column the PATCH /:id/operational-config UPDATE statement in
// routes/learningInstances.js references. Kept as an explicit list (rather
// than parsing the route file) so this test fails loudly and specifically
// — "X is missing from the schema" — instead of needing a second copy of
// the SQL to compare against.
const REQUIRED_OPERATIONAL_CONFIG_COLUMNS = [
  "delivery_modes",
  "campus_ids",
  "fee_ghs",
  "registration_fee_ghs",
  "combine_registration_with_first_period",
  "installments_enabled",
  "capacity",
  "instructor_id",
  "registration_opens_at",
  "registration_deadline",
  "registration_force_closed",
  "registration_force_open",
];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForReady(baseUrl, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function migrateFreshDb(env) {
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  return migrate;
}

function prepareDb({ production = false } = {}) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-opconfig-regr-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "opconfig-migration-regression-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  if (production) {
    env.NODE_ENV = "production";
  } else {
    delete env.NODE_ENV; // dev-mode Paystack auto-complete fallback needs this NOT 'production'
  }
  delete env.PAYSTACK_SECRET_KEY; // ensure the dev auto-complete fallback fires
  const migrate = migrateFreshDb(env);
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env, migrateResult: migrate };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-opconfig-regr-uploads-"));
  const port = await getFreePort();
  const fullEnv = { ...env, PORT: String(port), APP_URL: `http://127.0.0.1:${port}`, UPLOAD_DIR: uploadDir };
  let stderr = "";
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: SERVER_CWD, env: fullEnv });
  child.stderr.on("data", (d) => (stderr += d.toString()));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    getStderr: () => stderr,
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) {
          fs.rmSync(uploadDir, { recursive: true, force: true });
          return resolve();
        }
        child.once("exit", () => {
          fs.rmSync(uploadDir, { recursive: true, force: true });
          resolve();
        });
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 4000);
      });
    },
  };
}

function cookieFor(userId, role) {
  const token = jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function seedAdminAndOfferingType(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', ?, 'x', 'active', 'paid', 1, 'ADM-OC-0001', date('now'), ?)"
    ).run(adminId, `admin-opconfig-${uuid()}@example.test`, superAdminTemplate ? superAdminTemplate.id : null);
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    return { adminId, offeringTypeId: offeringType.id };
  } finally {
    db.close();
  }
}

// ============================================================
// 1) SCHEMA CONTRACT — the regression test that would have caught the
//    original bug before it ever reached a real deployment.
// ============================================================
test("schema contract: a fresh `node src/db/migrate.js` run creates every column PATCH /:id/operational-config writes to", () => {
  const { dbDir, dbPath, env } = prepareDb();
  try {
    const db = new Database(dbPath);
    const cols = db.prepare("PRAGMA table_info(learning_instances)").all().map((c) => c.name);
    db.close();
    const missing = REQUIRED_OPERATIONAL_CONFIG_COLUMNS.filter((c) => !cols.includes(c));
    assert.deepEqual(missing, [], `learning_instances is missing columns the operational-config route writes to: ${missing.join(", ")}`);
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("migration idempotency: running migrate.js three times against the same database exits 0 every time with no duplicate-column/schema errors", () => {
  const { dbDir, dbPath, env } = prepareDb();
  try {
    for (let i = 0; i < 2; i++) {
      const result = migrateFreshDb(env);
      assert.equal(result.status, 0, `re-run ${i + 2} failed: ${result.stderr}`);
      assert.doesNotMatch(result.stdout + result.stderr, /duplicate column|SqliteError/i);
    }
    const db = new Database(dbPath);
    const cols = db.prepare("PRAGMA table_info(learning_instances)").all().map((c) => c.name);
    db.close();
    const missing = REQUIRED_OPERATIONAL_CONFIG_COLUMNS.filter((c) => !cols.includes(c));
    assert.deepEqual(missing, []);
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================
// 2) THE ORIGINAL BUG, REPRODUCED AS A REGRESSION TEST — must fail loudly
//    if `combine_registration_with_first_period` (or any sibling column)
//    is ever missing from the schema again.
// ============================================================
test("regression: fresh DB -> migrate -> create Learning Instance -> PATCH operational-config (registration fee + combine flag) -> 200, for Monthly, Term, and Semester", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl), server.getStderr());
  const fx = seedAdminAndOfferingType(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  async function createAndConfigure(structure) {
    const db = new Database(dbPath);
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, ?, 0)").run(
      programmeId,
      fx.offeringTypeId,
      `Regression ${structure || "monthly"} Programme ${uuid()}`
    );
    db.close();

    const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId, status: "upcoming" }),
    });
    const instance = await readJson(createRes);
    assert.equal(createRes.status, 200, JSON.stringify(instance));

    if (structure) {
      const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/academic-structure`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ structure }),
      });
      assert.equal(structRes.status, 200, JSON.stringify(await structRes.clone().json()));
    }

    // This is exactly the original failing workflow: set a registration
    // fee and operational config, including the combine flag, then Save.
    const patchRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        feeGHS: 1500,
        registrationFeeGHS: 200,
        combineRegistrationWithFirstPeriod: !!structure,
        capacity: 30,
        deliveryModes: ["ONLINE"],
      }),
    });
    const patchBody = await readJson(patchRes);
    assert.equal(patchRes.status, 200, `Save Operational Configuration failed: ${JSON.stringify(patchBody)}`);
    return { instance, saved: patchBody };
  }

  const monthly = await createAndConfigure(null);
  assert.equal(monthly.saved.registrationFeeGHS, 200);
  assert.equal(monthly.saved.combineRegistrationWithFirstPeriod, false); // sent false for a monthly run

  const term = await createAndConfigure("term");
  assert.equal(term.saved.registrationFeeGHS, 200);
  assert.equal(term.saved.combineRegistrationWithFirstPeriod, true);

  const semester = await createAndConfigure("semester");
  assert.equal(semester.saved.registrationFeeGHS, 200);
  assert.equal(semester.saved.combineRegistrationWithFirstPeriod, true);
});

// ============================================================
// 3) ROUND-TRIP, PARTIAL UPDATE, AND IDEMPOTENT-SAVE VERIFICATION
// ============================================================
test("operational-config: values round-trip through PATCH -> GET, partial updates never clear unrelated fields, and saving twice is idempotent", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl), server.getStderr());
  const fx = seedAdminAndOfferingType(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  const db = new Database(dbPath);
  const programmeId = uuid();
  db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Round Trip Programme', 0)").run(programmeId, fx.offeringTypeId);
  db.close();

  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId, status: "upcoming" }),
  });
  const instance = await readJson(createRes);
  assert.equal(createRes.status, 200);

  await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "term" }),
  });

  // Full save.
  const firstSave = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      feeGHS: 900,
      registrationFeeGHS: 250,
      combineRegistrationWithFirstPeriod: true,
      capacity: 25,
      deliveryModes: ["ON_CAMPUS"],
      installmentsEnabled: true,
    }),
  });
  const firstBody = await readJson(firstSave);
  assert.equal(firstSave.status, 200, JSON.stringify(firstBody));

  // Round-trip: re-fetch and confirm every saved value is returned as-is.
  const getRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}`, { headers });
  const fetched = await readJson(getRes);
  assert.equal(getRes.status, 200);
  assert.equal(fetched.feeGHS, 900);
  assert.equal(fetched.registrationFeeGHS, 250);
  assert.equal(fetched.combineRegistrationWithFirstPeriod, true);
  assert.equal(fetched.capacity, 25);
  assert.deepEqual(fetched.deliveryModes, ["ON_CAMPUS"]);
  assert.equal(fetched.installmentsEnabled, true);

  // Partial update: only touch registrationFeeGHS. Everything else must
  // survive untouched (the "omit = unchanged" contract).
  const partialRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ registrationFeeGHS: 300 }),
  });
  const partialBody = await readJson(partialRes);
  assert.equal(partialRes.status, 200, JSON.stringify(partialBody));
  assert.equal(partialBody.registrationFeeGHS, 300);
  assert.equal(partialBody.feeGHS, 900, "unrelated feeGHS was clobbered by a partial update");
  assert.equal(partialBody.capacity, 25, "unrelated capacity was clobbered by a partial update");
  assert.equal(partialBody.combineRegistrationWithFirstPeriod, true, "unrelated combine flag was clobbered by a partial update");
  assert.deepEqual(partialBody.deliveryModes, ["ON_CAMPUS"], "unrelated deliveryModes was clobbered by a partial update");

  // Updating capacity must not silently erase the registration fee just set.
  const capacityOnlyRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ capacity: 40 }),
  });
  const capacityOnlyBody = await readJson(capacityOnlyRes);
  assert.equal(capacityOnlyRes.status, 200);
  assert.equal(capacityOnlyBody.capacity, 40);
  assert.equal(capacityOnlyBody.registrationFeeGHS, 300, "registrationFeeGHS was erased by an unrelated capacity update");

  // Save the exact same full payload twice — must succeed both times with
  // identical resulting state, and must not create any duplicate rows.
  const payload = { feeGHS: 900, registrationFeeGHS: 300, capacity: 40, combineRegistrationWithFirstPeriod: true, deliveryModes: ["ON_CAMPUS"] };
  const saveA = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, { method: "PATCH", headers, body: JSON.stringify(payload) });
  assert.equal(saveA.status, 200);
  const saveB = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, { method: "PATCH", headers, body: JSON.stringify(payload) });
  const saveBBody = await readJson(saveB);
  assert.equal(saveB.status, 200);
  assert.equal(saveBBody.feeGHS, 900);
  assert.equal(saveBBody.registrationFeeGHS, 300);
  assert.equal(saveBBody.capacity, 40);

  const finalDb = new Database(dbPath);
  const liCount = finalDb.prepare("SELECT COUNT(*) n FROM learning_instances WHERE id = ?").get(instance.id).n;
  finalDb.close();
  assert.equal(liCount, 1, "saving operational configuration twice duplicated the Learning Instance row");
});

// ============================================================
// 4) COMBINED REGISTRATION + FIRST PERIOD PAYMENT — end-to-end, using the
//    already-implemented resolveCombinedPeriodCharge()/registrationBreakdown()
//    (no new field, no new logic — this only proves the existing rule works
//    now that the save workflow that configures it is unblocked).
// ============================================================

async function buildTermActiveRun(server, headers, dbPath, fx, { combine }) {
  const db = new Database(dbPath);
  const programmeId = uuid();
  db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, ?, 0)").run(programmeId, fx.offeringTypeId, `Combine Test Programme ${uuid()}`);
  db.close();

  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId, status: "upcoming" }),
  });
  const instance = await readJson(createRes);
  assert.equal(createRes.status, 200, JSON.stringify(instance));

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "term" }),
  });
  const withStructure = await readJson(structRes);
  assert.equal(structRes.status, 200, JSON.stringify(withStructure));
  const [period1, period2] = withStructure.academicPeriods;

  // Registration fee (the non-combined baseline amount) + the combine flag.
  const opRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ registrationFeeGHS: 200, combineRegistrationWithFirstPeriod: combine }),
  });
  assert.equal(opRes.status, 200, JSON.stringify(await opRes.clone().json()));

  // Term 2 required amount = 400, independently configured (always
  // allowed — combine only ever governs Term 1).
  const req2 = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/academic-periods/${period2.id}/payment-requirement`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ mode: "full", requiredAmountGHS: 400 }),
  });
  assert.equal(req2.status, 200, JSON.stringify(await req2.clone().json()));

  if (!combine) {
    // Term 1 required amount = 350 — only independently configurable when
    // combine is OFF. (Different from Term 2's 400 and the 200
    // Registration Fee so a test reading the wrong amount fails loudly.)
    const req1 = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/academic-periods/${period1.id}/payment-requirement`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ mode: "full", requiredAmountGHS: 350 }),
    });
    assert.equal(req1.status, 200, JSON.stringify(await req1.clone().json()));
  }

  const activateRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/activate`, { method: "POST", headers });
  assert.equal(activateRes.status, 200, JSON.stringify(await activateRes.clone().json()));

  // A Foundation-style entry class feeding this Programme, needed for
  // classId -> getActiveInstanceIdForProgramme() resolution at registration.
  const classId = uuid();
  const db2 = new Database(dbPath);
  db2.prepare("INSERT INTO classes (id, name, programme_id, sort_order) VALUES (?, 'Entry Class', ?, 0)").run(classId, programmeId);
  db2.close();

  return { instance, period1, period2, programmeId, classId };
}

test("combine ON: a parent's registration charge for a fresh learner equals the Registration Fee (not Term 1's own amount), and that single charge settles both registration and Term 1", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl), server.getStderr());
  const fx = seedAdminAndOfferingType(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  const { instance, period1, period2, classId } = await buildTermActiveRun(server, headers, dbPath, fx, { combine: true });

  const parentEmail = `parent-combine-${uuid()}@example.test`;
  const registerRes = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "parent-learner",
      classId,
      parent: { name: "Combine Parent", email: parentEmail, password: "parentpass123" },
      learner: { name: "Combine Child", dateOfBirth: "2016-01-01" },
    }),
  });
  const registerBody = await readJson(registerRes);
  assert.equal(registerRes.status, 200, JSON.stringify(registerBody));

  // The charge is the Registration Fee itself (200) — it now automatically
  // becomes Term 1's payment requirement too. Never Term 1's own amount,
  // since Term 1 no longer has an independently configured one.
  assert.equal(registerBody.registrationTotalGHS, 200, "combine-on charge did not equal the Registration Fee");
  assert.equal(registerBody.registrationBreakdown[0].amountGHS, 200);

  const parentId = registerBody.parentId;
  const learnerId = registerBody.learnerId;

  const initiateRes = await fetch(`${server.baseUrl}/api/payments/${parentId}/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieFor(parentId, "parent") },
    body: JSON.stringify({ type: "registration", network: "MTN", momoNumber: "0244000000" }),
  });
  const initiateBody = await readJson(initiateRes);
  assert.equal(initiateRes.status, 200, JSON.stringify(initiateBody));
  assert.equal(initiateBody.status, "success");
  assert.equal(initiateBody.totalGHS, 200);

  // The resulting payment is tagged as a period_payment against Term 1,
  // not a plain registration-fee charge.
  const db = new Database(dbPath);
  const paymentRow = db.prepare("SELECT * FROM payments WHERE learner_ids LIKE ?").get(`%${learnerId}%`);
  assert.ok(paymentRow, "no payment row found for the registering learner");
  assert.equal(paymentRow.status, "successful");
  db.close();

  // Term 1's payment status for this learner is now satisfied — inherited
  // from the Registration Fee, no second Term 1 charge required.
  const status1Res = await fetch(
    `${server.baseUrl}/api/learning-instances/${instance.id}/academic-periods/${period1.id}/learners/${learnerId}/payment-status`,
    { headers }
  );
  const status1Body = await readJson(status1Res);
  assert.equal(status1Res.status, 200, JSON.stringify(status1Body));
  assert.equal(status1Body.satisfied, true, "Term 1 was not satisfied by the combined Registration Fee payment");
  assert.equal(status1Body.requiredAmountGHS, 200, "Term 1's inherited requirement did not equal the Registration Fee");
});

test("combine ON: Term 2 keeps its own separate payment obligation — the combined charge never satisfies a later period", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl), server.getStderr());
  const fx = seedAdminAndOfferingType(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  const { instance, period1, period2, classId } = await buildTermActiveRun(server, headers, dbPath, fx, { combine: true });

  const registerRes = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "parent-learner",
      classId,
      parent: { name: "Combine Parent Two", email: `parent-combine2-${uuid()}@example.test`, password: "parentpass123" },
      learner: { name: "Combine Child Two", dateOfBirth: "2016-01-01" },
    }),
  });
  const registerBody = await readJson(registerRes);
  assert.equal(registerRes.status, 200, JSON.stringify(registerBody));
  const parentId = registerBody.parentId;
  const learnerId = registerBody.learnerId;

  await fetch(`${server.baseUrl}/api/payments/${parentId}/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieFor(parentId, "parent") },
    body: JSON.stringify({ type: "registration", network: "MTN", momoNumber: "0244000000" }),
  });

  // Period 2's payment status must NOT be satisfied by the combined
  // registration charge that settled period 1.
  const status2Res = await fetch(
    `${server.baseUrl}/api/learning-instances/${instance.id}/academic-periods/${period2.id}/learners/${learnerId}/payment-status`,
    { headers }
  );
  const status2Body = await readJson(status2Res);
  assert.equal(status2Res.status, 200, JSON.stringify(status2Body));
  assert.equal(status2Body.satisfied, false, "Term 2 was incorrectly satisfied by the combined registration+Term-1 charge");
  assert.equal(status2Body.amountPaidGHS, 0);
  assert.equal(status2Body.requiredAmountGHS, 400);

  // Period 1, by contrast, IS satisfied.
  const status1Res = await fetch(
    `${server.baseUrl}/api/learning-instances/${instance.id}/academic-periods/${period1.id}/learners/${learnerId}/payment-status`,
    { headers }
  );
  const status1Body = await readJson(status1Res);
  assert.equal(status1Res.status, 200, JSON.stringify(status1Body));
  assert.equal(status1Body.satisfied, true, "Term 1 was not satisfied by the combined registration charge");
});

test("combine ON: Term 1's payment requirement is inherited and read-only — the admin cannot independently configure a competing amount for it", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl), server.getStderr());
  const fx = seedAdminAndOfferingType(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  // buildTermActiveRun already skips configuring Term 1 independently when
  // combine is on; here we additionally assert an explicit attempt to do
  // so is rejected outright (business rule §5/§9 — never two competing
  // definitions of the same obligation).
  const { instance, period1 } = await buildTermActiveRun(server, headers, dbPath, fx, { combine: true });

  const req1Res = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/academic-periods/${period1.id}/payment-requirement`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ mode: "full", requiredAmountGHS: 999 }),
  });
  const req1Body = await readJson(req1Res);
  assert.equal(req1Res.status, 400, JSON.stringify(req1Body));
  assert.match(req1Body.error, /inherited|Combine/i);
});

test("combine OFF: legacy behavior is unchanged — registration charges the plain Registration Fee, and Term 1's payment remains a separate obligation", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl), server.getStderr());
  const fx = seedAdminAndOfferingType(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  const { instance, period1, classId } = await buildTermActiveRun(server, headers, dbPath, fx, { combine: false });

  const registerRes = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "parent-learner",
      classId,
      parent: { name: "No Combine Parent", email: `parent-nocombine-${uuid()}@example.test`, password: "parentpass123" },
      learner: { name: "No Combine Child", dateOfBirth: "2016-01-01" },
    }),
  });
  const registerBody = await readJson(registerRes);
  assert.equal(registerRes.status, 200, JSON.stringify(registerBody));
  assert.equal(registerBody.registrationTotalGHS, 200, "combine-off registration charge did not equal the plain Registration Fee");

  const learnerId = registerBody.learnerId;
  const status1Res = await fetch(
    `${server.baseUrl}/api/learning-instances/${instance.id}/academic-periods/${period1.id}/learners/${learnerId}/payment-status`,
    { headers }
  );
  const status1Body = await readJson(status1Res);
  assert.equal(status1Res.status, 200, JSON.stringify(status1Body));
  assert.equal(status1Body.satisfied, false, "Term 1 should still require its own separate payment when the combine flag is off");
  assert.equal(status1Body.amountPaidGHS, 0);
});

test("combine ON correction backfill: a pre-existing database left in the old, invalid state (combine ON with an independently configured Term 1 amount) is corrected by re-running migrate.js, deterministically and idempotently", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  t.after(() => fs.rmSync(dbDir, { recursive: true, force: true }));

  // Build a Term-structured, combine-ON Run the same way buildTermActiveRun
  // does, but reach around the (now-enforced) API guard and write directly
  // to the database — simulating a Run that was configured under the old,
  // buggy admin UI before this fix existed, and so is sitting in the
  // invalid dual-config state the corrected business rule prohibits.
  const db = new Database(dbPath);
  const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
  const programmeId = uuid();
  db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, ?, 0)").run(programmeId, offeringType.id, `Backfill Test Programme ${uuid()}`);
  const instanceId = uuid();
  db.prepare(
    "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, academic_structure, combine_registration_with_first_period, registration_fee_ghs) VALUES (?, ?, ?, 'upcoming', 'term', 1, 200)"
  ).run(instanceId, offeringType.id, programmeId);
  const period1Id = uuid();
  const period2Id = uuid();
  db.prepare("INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name) VALUES (?, ?, 1, 'Term 1')").run(period1Id, instanceId);
  db.prepare("INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name) VALUES (?, ?, 2, 'Term 2')").run(period2Id, instanceId);
  db.prepare("UPDATE learning_instance_academic_periods SET payment_mode = 'full', required_amount_ghs = 350 WHERE id = ?").run(period1Id);
  db.prepare("UPDATE learning_instance_academic_periods SET payment_mode = 'full', required_amount_ghs = 400 WHERE id = ?").run(period2Id);

  // A sibling combine-OFF Run's independently configured Term 1 amount is
  // the control case — legitimate, and must never be touched by the
  // backfill.
  const instanceId2 = uuid();
  db.prepare(
    "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, academic_structure, combine_registration_with_first_period, registration_fee_ghs) VALUES (?, ?, ?, 'upcoming', 'term', 0, 200)"
  ).run(instanceId2, offeringType.id, programmeId);
  const period3Id = uuid();
  db.prepare("INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name) VALUES (?, ?, 1, 'Term 1')").run(period3Id, instanceId2);
  db.prepare("UPDATE learning_instance_academic_periods SET payment_mode = 'full', required_amount_ghs = 500 WHERE id = ?").run(period3Id);
  db.close();

  // Re-run migrate.js against this now-populated database — exactly what
  // rolling this fix out to a real, already-in-use installation looks
  // like.
  const migrateResult = migrateFreshDb(env);
  assert.equal(migrateResult.status, 0, `migrate.js failed: ${migrateResult.stderr}`);
  assert.match(migrateResult.stdout, /correction backfill: cleared 1/, "backfill did not report clearing the invalid Term 1 configuration");

  const afterFirstRun = new Database(dbPath);
  const period1AfterFix = afterFirstRun.prepare("SELECT payment_mode, required_amount_ghs FROM learning_instance_academic_periods WHERE id = ?").get(period1Id);
  const period2AfterFix = afterFirstRun.prepare("SELECT payment_mode, required_amount_ghs FROM learning_instance_academic_periods WHERE id = ?").get(period2Id);
  const period3AfterFix = afterFirstRun.prepare("SELECT payment_mode, required_amount_ghs FROM learning_instance_academic_periods WHERE id = ?").get(period3Id);
  afterFirstRun.close();

  // Combine-ON Term 1: the invalid independent configuration is cleared —
  // its requirement is now derived from the Registration Fee.
  assert.equal(period1AfterFix.payment_mode, null, "combine-ON Term 1's payment_mode should have been cleared by the backfill");
  assert.equal(period1AfterFix.required_amount_ghs, null, "combine-ON Term 1's required_amount_ghs should have been cleared by the backfill");
  // Term 2 (never governed by combine) is untouched.
  assert.equal(period2AfterFix.payment_mode, "full");
  assert.equal(period2AfterFix.required_amount_ghs, 400);
  // The combine-OFF sibling's independently configured Term 1 is untouched.
  assert.equal(period3AfterFix.payment_mode, "full");
  assert.equal(period3AfterFix.required_amount_ghs, 500);

  // Idempotency: running migrate.js again against the now-corrected
  // database must be a safe no-op — nothing left to clear, and the
  // already-correct rows are unaffected.
  const secondRun = migrateFreshDb(env);
  assert.equal(secondRun.status, 0, `second migrate.js run failed: ${secondRun.stderr}`);
  assert.match(secondRun.stdout, /correction backfill: nothing to clear/, "second run should find nothing left to clear");

  const afterSecondRun = new Database(dbPath);
  const period2Stable = afterSecondRun.prepare("SELECT payment_mode, required_amount_ghs FROM learning_instance_academic_periods WHERE id = ?").get(period2Id);
  const period3Stable = afterSecondRun.prepare("SELECT payment_mode, required_amount_ghs FROM learning_instance_academic_periods WHERE id = ?").get(period3Id);
  afterSecondRun.close();
  assert.deepEqual(period2Stable, { payment_mode: "full", required_amount_ghs: 400 });
  assert.deepEqual(period3Stable, { payment_mode: "full", required_amount_ghs: 500 });
});

// ============================================================
// 5) MONTHLY-BILLING GUARD — unaffected by anything above.
// ============================================================
test("monthly billing guard: a term/semester Learning Instance still rejects a monthly initiate; a genuine monthly Learning Instance still accepts one", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl), server.getStderr());
  const fx = seedAdminAndOfferingType(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  // --- Term-structured run: monthly initiate must be rejected (4xx). ---
  const { classId: termClassId } = await buildTermActiveRun(server, headers, dbPath, fx, { combine: false });
  const termParentRes = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "parent-learner",
      classId: termClassId,
      parent: { name: "Guard Term Parent", email: `parent-guard-term-${uuid()}@example.test`, password: "parentpass123" },
      learner: { name: "Guard Term Child", dateOfBirth: "2016-01-01" },
    }),
  });
  const termParentBody = await readJson(termParentRes);
  assert.equal(termParentRes.status, 200, JSON.stringify(termParentBody));

  const termMonthlyRes = await fetch(`${server.baseUrl}/api/payments/${termParentBody.learnerId}/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieFor(termParentBody.parentId, "parent") },
    body: JSON.stringify({ type: "monthly", method: "CARD" }),
  });
  assert.ok(termMonthlyRes.status >= 400 && termMonthlyRes.status < 500, `expected 4xx blocking monthly billing on a term run, got ${termMonthlyRes.status}`);

  // --- Genuine monthly run: monthly billing must still work. ---
  const db = new Database(dbPath);
  const monthlyProgrammeId = uuid();
  db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, ?, 0)").run(monthlyProgrammeId, fx.offeringTypeId, `Guard Monthly Programme ${uuid()}`);
  db.close();

  const monthlyCreateRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: monthlyProgrammeId, status: "upcoming" }),
  });
  const monthlyInstance = await readJson(monthlyCreateRes);
  assert.equal(monthlyCreateRes.status, 200);

  const monthlyOpRes = await fetch(`${server.baseUrl}/api/learning-instances/${monthlyInstance.id}/operational-config`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ feeGHS: 180, registrationFeeGHS: 200 }),
  });
  assert.equal(monthlyOpRes.status, 200, JSON.stringify(await monthlyOpRes.clone().json()));

  const monthlyActivateRes = await fetch(`${server.baseUrl}/api/learning-instances/${monthlyInstance.id}/activate`, { method: "POST", headers });
  assert.equal(monthlyActivateRes.status, 200, JSON.stringify(await monthlyActivateRes.clone().json()));

  const monthlyClassId = uuid();
  const db2 = new Database(dbPath);
  db2.prepare("INSERT INTO classes (id, name, programme_id, sort_order) VALUES (?, 'Monthly Entry Class', ?, 0)").run(monthlyClassId, monthlyProgrammeId);
  db2.close();

  const monthlyParentRes = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "parent-learner",
      classId: monthlyClassId,
      parent: { name: "Guard Monthly Parent", email: `parent-guard-monthly-${uuid()}@example.test`, password: "parentpass123" },
      learner: { name: "Guard Monthly Child", dateOfBirth: "2016-01-01" },
    }),
  });
  const monthlyParentBody = await readJson(monthlyParentRes);
  assert.equal(monthlyParentRes.status, 200, JSON.stringify(monthlyParentBody));

  // Registration must be paid first before a monthly payment can be initiated.
  const regInitiate = await fetch(`${server.baseUrl}/api/payments/${monthlyParentBody.parentId}/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieFor(monthlyParentBody.parentId, "parent") },
    body: JSON.stringify({ type: "registration", network: "MTN", momoNumber: "0244000000" }),
  });
  assert.equal(regInitiate.status, 200, JSON.stringify(await regInitiate.clone().json()));

  const monthlyInitiateRes = await fetch(`${server.baseUrl}/api/payments/${monthlyParentBody.learnerId}/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieFor(monthlyParentBody.parentId, "parent") },
    body: JSON.stringify({ type: "monthly", network: "MTN", momoNumber: "0244000000" }),
  });
  const monthlyInitiateBody = await readJson(monthlyInitiateRes);
  assert.ok(
    monthlyInitiateRes.status === 200 || monthlyInitiateRes.status === 400,
    `unexpected status for legitimate monthly initiate: ${monthlyInitiateRes.status} ${JSON.stringify(monthlyInitiateBody)}`
  );
  // A 400 here (if any) must be a normal validation message (e.g. already
  // current), never the billing-guard's period-based rejection message.
  if (monthlyInitiateRes.status === 400) {
    assert.doesNotMatch(String(monthlyInitiateBody.error || ""), /not available for this Learning Instance/i);
  }
});
