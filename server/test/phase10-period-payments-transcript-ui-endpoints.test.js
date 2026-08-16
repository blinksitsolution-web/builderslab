/**
 * Phase 10 — Learner/parent-facing period UI support endpoints.
 *
 * The Phase 10 Payments/Transcripts UI needs a way for a learner/parent
 * (not just staff) to discover which of their own Learning Instances have
 * an academic-period structure, and what their period payment status is,
 * without exposing the full staff-only Learning Instance catalog. Locks
 * in the three additive endpoints/fields this phase adds for that:
 *
 *  - GET /api/grades/:userId/transcript-options (self/parent/staff) —
 *    lists only the calling learner's own Learning Instances that have an
 *    academic structure configured, each with its academic periods, for
 *    building a period selector;
 *  - GET /api/payments/:userId/period-status (self/parent/staff) — the
 *    same required/paid/outstanding/status breakdown the staff-only
 *    per-period endpoint already returns (utils/periodPayments.js's
 *    getPeriodPaymentStatus), but self-service and covering every
 *    period-structured instance the learner has a record in at once;
 *  - GET /api/payments/user/:userId now resolves academicPeriodName on
 *    each payment row (existing shape otherwise unchanged) — legacy/
 *    non-period-scoped rows keep academicPeriodName: null.
 *
 * A learner with no linkage yet to a period-structured instance
 * (no payment/enrolment/certificate row referencing it) correctly sees
 * neither in these lists — these endpoints only ever surface instances
 * the learner actually has a record in, never the full catalog.
 *
 * Same real-server-process pattern as period-payment-enforcement.test.js /
 * period-scoped-transcripts-and-certificates.test.js.
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
const JWT_SECRET = "phase10-period-ui-endpoints-test-secret-not-for-real-use";

// Real OS-assigned free port (bind to port 0, read back what the kernel
// gave us, close, then immediately hand it to the spawned server) instead
// of a blind random guess in a fixed range. The old `4200 + random*3000`
// scheme had only ~3000 possible values, so with 24 test files spawning
// several real server processes each (many run concurrently under
// `node --test`), collisions were a real birthday-paradox risk: two
// processes would occasionally pick the same "random" port, the second
// server would fail to bind (EADDRINUSE) and silently never come up, and
// the test would only fail after burning its full health-check timeout —
// exactly the flaky, hard-to-reproduce failure this replaces.
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

async function waitForReady(baseUrl, timeoutMs) {
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

function prepareDb() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-phase10-period-ui-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "phase10-period-ui-endpoints-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-phase10-period-ui-uploads-"));
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
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return body;
}

// IOT-02 is seeded with is_open = 0 (see migrate.js), so it never gets an
// auto-created Learning Instance from the v24 registration-catalogue
// backfill — this test needs full manual control over the instance.
const TEST_MODULE_ID = "IOT-02";

function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'phase10-period-ui-admin@example.com', 'x', 'active', 'current', 1, 'ADM-P10-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    const learnerId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, joined_date, student_code)
       VALUES (?, 'learner', 'Test Learner', ?, ?, 'active', 'current', 1, date('now'), ?)`
    ).run(learnerId, `learner-${learnerId}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${learnerId.slice(0, 8)}`);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(learnerId, TEST_MODULE_ID);

    return { adminId, offeringTypeId: offeringType.id, learnerId };
  } finally {
    db.close();
  }
}

async function createStructuredActiveInstance(baseUrl, headers) {
  const createRes = await fetch(`${baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: headers.__offeringTypeId, courseId: TEST_MODULE_ID, name: "Phase 10 Period UI Test Run", status: "upcoming" }),
  });
  const created = await readJson(createRes);
  assert.equal(createRes.status, 200, JSON.stringify(created));

  const structRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await readJson(structRes);
  assert.equal(structRes.status, 200, JSON.stringify(withStructure));
  const [period1, period2] = withStructure.academicPeriods;
  const primaryTargetId = withStructure.targets[0].id;

  const targetsRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/targets`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ targetIds: [primaryTargetId] }),
  });
  assert.equal(targetsRes.status, 200);

  const activateRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/activate`, { method: "POST", headers });
  assert.equal(activateRes.status, 200, JSON.stringify(await readJson(activateRes)));

  return { instanceId: created.id, period1Id: period1.id, period2Id: period2.id };
}

test("transcript-options / period-status: a learner with no record in a period-structured instance sees neither (never the full staff catalog)", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const adminHeaders = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };
  await createStructuredActiveInstance(server.baseUrl, adminHeaders);

  const learnerHeaders = { Cookie: cookieFor(fx.learnerId, "learner") };
  const optionsRes = await fetch(`${server.baseUrl}/api/grades/${fx.learnerId}/transcript-options`, { headers: learnerHeaders });
  const optionsBody = await readJson(optionsRes);
  assert.equal(optionsRes.status, 200, JSON.stringify(optionsBody));
  assert.deepEqual(optionsBody.learningInstances, []);

  const statusRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/period-status`, { headers: learnerHeaders });
  const statusBody = await readJson(statusRes);
  assert.equal(statusRes.status, 200, JSON.stringify(statusBody));
  assert.deepEqual(statusBody.periodPayments, []);
});

test("transcript-options / period-status: once the learner has a record tied to the instance, both self-service endpoints surface it (and only that learner's own instance)", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const adminHeaders = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };
  const { instanceId, period1Id, period2Id } = await createStructuredActiveInstance(server.baseUrl, adminHeaders);

  // Configure period 1 with a GHS 40 full-payment requirement; period 2
  // deliberately left unconfigured (mode: null / satisfied: true expected).
  const reqRes = await fetch(`${server.baseUrl}/api/learning-instances/${instanceId}/academic-periods/${period1Id}/payment-requirement`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ mode: "full", requiredAmountGHS: 40 }),
  });
  assert.equal(reqRes.status, 200, JSON.stringify(await readJson(reqRes)));

  // Admin records a GHS 15 partial payment toward period 1 — this is also
  // what links the learner to the instance for getLearnerLearningInstances
  // (payments.learning_instance_id), matching how a real cash/MoMo period
  // payment would be recorded.
  const payRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/period-payment`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ learningInstanceId: instanceId, periodId: period1Id, amountGHS: 15, method: "Cash" }),
  });
  assert.equal(payRes.status, 200, JSON.stringify(await readJson(payRes)));

  const learnerHeaders = { Cookie: cookieFor(fx.learnerId, "learner") };

  // transcript-options: instance + both periods listed.
  const optionsRes = await fetch(`${server.baseUrl}/api/grades/${fx.learnerId}/transcript-options`, { headers: learnerHeaders });
  const optionsBody = await readJson(optionsRes);
  assert.equal(optionsRes.status, 200, JSON.stringify(optionsBody));
  assert.equal(optionsBody.learningInstances.length, 1);
  assert.equal(optionsBody.learningInstances[0].id, instanceId);
  const periodIds = optionsBody.learningInstances[0].academicPeriods.map((p) => p.id);
  assert.deepEqual(periodIds.sort(), [period1Id, period2Id].sort());

  // period-status: period 1 partial/unsatisfied with the right figures,
  // period 2 not_required/satisfied.
  const statusRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/period-status`, { headers: learnerHeaders });
  const statusBody = await readJson(statusRes);
  assert.equal(statusRes.status, 200, JSON.stringify(statusBody));
  assert.equal(statusBody.periodPayments.length, 2);

  const p1Status = statusBody.periodPayments.find((p) => p.academicPeriod.id === period1Id);
  assert.equal(p1Status.learningInstance.id, instanceId);
  assert.equal(p1Status.requiredAmountGHS, 40);
  assert.equal(p1Status.amountPaidGHS, 15);
  assert.equal(p1Status.outstandingGHS, 25);
  assert.equal(p1Status.status, "partial");
  assert.equal(p1Status.satisfied, false);

  const p2Status = statusBody.periodPayments.find((p) => p.academicPeriod.id === period2Id);
  assert.equal(p2Status.mode, null);
  assert.equal(p2Status.status, "not_required");
  assert.equal(p2Status.satisfied, true);

  // A parent-scoped call (if this learner had one) or a different learner
  // must never see this instance — sanity-checked here via a second,
  // unrelated learner seeing an empty list.
  const otherLearnerId = uuid();
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, joined_date, student_code)
     VALUES (?, 'learner', 'Other Learner', ?, ?, 'active', 'current', 1, date('now'), ?)`
  ).run(otherLearnerId, `other-${otherLearnerId}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${otherLearnerId.slice(0, 8)}`);
  db.close();
  const otherRes = await fetch(`${server.baseUrl}/api/payments/${otherLearnerId}/period-status`, { headers: { Cookie: cookieFor(otherLearnerId, "learner") } });
  const otherBody = await readJson(otherRes);
  assert.equal(otherRes.status, 200, JSON.stringify(otherBody));
  assert.deepEqual(otherBody.periodPayments, []);
});

test("payments history: a period-scoped payment row resolves academicPeriodName; a legacy/non-period row keeps it null", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const adminHeaders = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };
  const { instanceId, period1Id } = await createStructuredActiveInstance(server.baseUrl, adminHeaders);

  await fetch(`${server.baseUrl}/api/learning-instances/${instanceId}/academic-periods/${period1Id}/payment-requirement`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ mode: "full", requiredAmountGHS: 40 }),
  });
  const payRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/period-payment`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ learningInstanceId: instanceId, periodId: period1Id, amountGHS: 40, method: "Cash" }),
  });
  assert.equal(payRes.status, 200, JSON.stringify(await readJson(payRes)));

  // Also record a legacy/non-period admin-status payment (existing PATCH
  // /:userId/status path) to confirm it keeps academicPeriodName: null.
  const legacyRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/status`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ status: "current", type: "monthly", amountPaid: 100, method: "Cash" }),
  });
  assert.equal(legacyRes.status, 200, JSON.stringify(await readJson(legacyRes)));

  const historyRes = await fetch(`${server.baseUrl}/api/payments/user/${fx.learnerId}`, { headers: { Cookie: cookieFor(fx.learnerId, "learner") } });
  const historyBody = await readJson(historyRes);
  assert.equal(historyRes.status, 200, JSON.stringify(historyBody));

  const periodRow = historyBody.payments.find((p) => p.learning_instance_academic_period_id === period1Id);
  assert.ok(periodRow, "expected the period payment row in history");
  assert.equal(periodRow.academicPeriodName, "Semester 1");

  const legacyRow = historyBody.payments.find((p) => p.type === "monthly");
  assert.ok(legacyRow, "expected the legacy monthly payment row in history");
  assert.equal(legacyRow.academicPeriodName, null);
});

test("admin ledger: GET /api/payments also resolves academicPeriodName on a period-scoped row", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const adminHeaders = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };
  const { instanceId, period1Id } = await createStructuredActiveInstance(server.baseUrl, adminHeaders);

  await fetch(`${server.baseUrl}/api/learning-instances/${instanceId}/academic-periods/${period1Id}/payment-requirement`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ mode: "full", requiredAmountGHS: 40 }),
  });
  const payRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/period-payment`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ learningInstanceId: instanceId, periodId: period1Id, amountGHS: 40, method: "Cash" }),
  });
  assert.equal(payRes.status, 200, JSON.stringify(await readJson(payRes)));

  const ledgerRes = await fetch(`${server.baseUrl}/api/payments?learnerId=${fx.learnerId}`, { headers: adminHeaders });
  const ledgerBody = await readJson(ledgerRes);
  assert.equal(ledgerRes.status, 200, JSON.stringify(ledgerBody));
  const row = ledgerBody.payments.find((p) => p.learning_instance_academic_period_id === period1Id);
  assert.ok(row, "expected the period payment row in the admin ledger");
  assert.equal(row.academicPeriodName, "Semester 1");
});
