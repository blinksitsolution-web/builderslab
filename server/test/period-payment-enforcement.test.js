/**
 * Phase 6 — Period-specific payment requirements and enforcement.
 *
 * Locks in:
 *  - a Learning Instance with no academic structure configured is never
 *    gated by this (every historical/legacy instance keeps working);
 *  - once a period has a payment requirement configured, a learner who
 *    hasn't satisfied it is blocked from the authoritative learning-
 *    content access path (GET /api/modules/:courseId/lessons) with a 402,
 *    even though they're correctly enrolled;
 *  - a period whose configured target list does not include this Module
 *    blocks access with a 403 ('not_active_for_period'), independent of
 *    payment;
 *  - once the learner's payment (recorded via the admin manual
 *    period-payment endpoint, or the Paystack-style initiate + dev-mode
 *    auto-complete flow) reaches the required amount, access is granted;
 *  - instructors/admins are never blocked by any of this;
 *  - a period payment settles ONLY that period (never flips the account's
 *    global payment_status), and paying again doesn't duplicate anything —
 *    it just tops up the same period's running total.
 *
 * Same real-server-process pattern as learning-instance-academic-structure
 * .test.js / module-access-enrollment.test.js.
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
const JWT_SECRET = "period-payment-enforcement-test-secret-not-for-real-use";

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

function prepareDb({ production = true } = {}) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-period-payment-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "period-payment-enforcement-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  if (production) {
    env.NODE_ENV = "production";
  } else {
    delete env.NODE_ENV;
    delete env.PAYSTACK_SECRET_KEY; // ensure the dev fallback fires
  }
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-period-payment-uploads-"));
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

// IOT-02 is seeded with is_open = 0 (see migrate.js), so it never gets an
// auto-created Learning Instance from the v24 registration-catalogue
// backfill — this test needs full manual control over the instance
// (create 'upcoming' -> set structure -> activate), which an
// already-active auto-created instance would conflict with.
const TEST_MODULE_ID = "IOT-02";

function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'period-payment-admin@example.com', 'x', 'active', 'current', 1, 'ADM-PP-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    const learnerId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, student_code)
       VALUES (?, 'learner', 'Test Learner', ?, ?, 'active', 'current', date('now'), ?)`
    ).run(learnerId, `learner-${learnerId}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${learnerId.slice(0, 8)}`);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(learnerId, TEST_MODULE_ID);

    return { adminId, offeringTypeId: offeringType.id, learnerId };
  } finally {
    db.close();
  }
}

// Creates an 'upcoming' Module Learning Instance for TEST_MODULE_ID, sets a
// 'semester' academic structure, points period 1's targets at the
// instance's own primary target, activates the run, and returns
// everything a test needs (instance id + both period ids + the target id).
async function readJson(res) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return body;
}

async function createStructuredActiveInstance(baseUrl, headers) {
  const createRes = await fetch(`${baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: headers.__offeringTypeId, courseId: TEST_MODULE_ID, name: "Period Payment Test Run", status: "upcoming" }),
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
  const targetsBody = await readJson(targetsRes);
  assert.equal(targetsRes.status, 200, JSON.stringify(targetsBody));

  const activateRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/activate`, { method: "POST", headers });
  const activateBody = await readJson(activateRes);
  assert.equal(activateRes.status, 200, JSON.stringify(activateBody));

  return { instanceId: created.id, period1Id: period1.id, period2Id: period2.id, primaryTargetId };
}

test("period-payment enforcement: an instance with no academic structure is never gated (backward compatible)", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);

  // HW-05 is_open=1 -> auto-backfilled Active instance with no academic
  // structure configured (never touched by this test) -> access must work
  // exactly as it always has.
  const db = new Database(dbPath);
  db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(fx.learnerId, "HW-05");
  db.close();

  const res = await fetch(`${server.baseUrl}/api/modules/HW-05/lessons`, {
    headers: { Cookie: cookieFor(fx.learnerId, "learner") },
  });
  assert.equal(res.status, 200);
});

test("period-payment enforcement: a learner is blocked (402) when the current period's payment requirement isn't satisfied, and let through once it is", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  const { instanceId, period1Id } = await createStructuredActiveInstance(server.baseUrl, headers);

  // Configure period 1 with a GHS 50 deposit requirement.
  const reqRes = await fetch(`${server.baseUrl}/api/learning-instances/${instanceId}/academic-periods/${period1Id}/payment-requirement`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ mode: "deposit", requiredAmountGHS: 50 }),
  });
  const reqBody = await readJson(reqRes);
  assert.equal(reqRes.status, 200, JSON.stringify(reqBody));
  assert.equal(reqBody.period.paymentMode, "deposit");

  // Learner is correctly enrolled but hasn't paid anything toward this
  // period yet -> blocked, not a bare enrollment 403.
  const blockedRes = await fetch(`${server.baseUrl}/api/modules/${TEST_MODULE_ID}/lessons`, {
    headers: { Cookie: cookieFor(fx.learnerId, "learner") },
  });
  const blockedBody = await readJson(blockedRes);
  assert.equal(blockedRes.status, 402, JSON.stringify(blockedBody));
  assert.equal(blockedBody.code, "PERIOD_PAYMENT_REQUIRED");
  assert.equal(blockedBody.paymentStatus.requiredAmountGHS, 50);
  assert.equal(blockedBody.paymentStatus.amountPaidGHS, 0);
  assert.equal(blockedBody.paymentStatus.satisfied, false);

  // Admin records a GHS 20 partial payment toward the period — still not enough.
  const partialRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/period-payment`, {
    method: "POST",
    headers,
    body: JSON.stringify({ learningInstanceId: instanceId, periodId: period1Id, amountGHS: 20, method: "Cash" }),
  });
  const partialBody = await readJson(partialRes);
  assert.equal(partialRes.status, 200, JSON.stringify(partialBody));
  assert.equal(partialBody.paymentStatus.satisfied, false);

  const stillBlockedRes = await fetch(`${server.baseUrl}/api/modules/${TEST_MODULE_ID}/lessons`, {
    headers: { Cookie: cookieFor(fx.learnerId, "learner") },
  });
  assert.equal(stillBlockedRes.status, 402);

  // Admin tops up the remaining GHS 30 — now satisfied, access granted.
  const topUpRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/period-payment`, {
    method: "POST",
    headers,
    body: JSON.stringify({ learningInstanceId: instanceId, periodId: period1Id, amountGHS: 30, method: "Cash" }),
  });
  const topUpBody = await readJson(topUpRes);
  assert.equal(topUpRes.status, 200, JSON.stringify(topUpBody));
  assert.equal(topUpBody.paymentStatus.satisfied, true);
  assert.equal(topUpBody.paymentStatus.amountPaidGHS, 50);
  assert.equal(topUpBody.paymentStatus.outstandingGHS, 0);

  const allowedRes = await fetch(`${server.baseUrl}/api/modules/${TEST_MODULE_ID}/lessons`, {
    headers: { Cookie: cookieFor(fx.learnerId, "learner") },
  });
  assert.equal(allowedRes.status, 200);

  // Two separate payments toward the same period must not have been
  // fanned out/duplicated into anything touching the account's own
  // global payment status.
  const db = new Database(dbPath);
  const learnerRow = db.prepare("SELECT payment_status FROM users WHERE id = ?").get(fx.learnerId);
  assert.equal(learnerRow.payment_status, "current"); // unchanged from seeded value — never flipped by a period payment
  const periodPaymentRows = db.prepare("SELECT * FROM payments WHERE learning_instance_academic_period_id = ?").all(period1Id);
  assert.equal(periodPaymentRows.length, 2);
  db.close();
});

test("period-payment enforcement: a Module not in the current period's configured target list is blocked (403), independent of payment", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  // Create the run, set academic structure, but point period 1's targets
  // at an EMPTY-then-different set (attach a second Module target and
  // assign ONLY that one to period 1, leaving TEST_MODULE_ID's own
  // primary target out of period 1's list).
  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, courseId: TEST_MODULE_ID, name: "Period Target Mismatch Run", status: "upcoming" }),
  });
  const created = await readJson(createRes);

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await readJson(structRes);
  const [period1] = withStructure.academicPeriods;

  // Attach GFX-06 (is_open = 0, no conflicting active instance) as a
  // secondary target, then assign ONLY that secondary target to period 1
  // — TEST_MODULE_ID's own primary target is deliberately left off.
  const addTargetRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/targets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ courseId: "GFX-06" }),
  });
  const withSecondTarget = await readJson(addTargetRes);
  assert.equal(addTargetRes.status, 201, JSON.stringify(withSecondTarget));
  const secondaryTarget = withSecondTarget.targets.find((t) => t.courseId === "GFX-06");

  const targetsRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/targets`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ targetIds: [secondaryTarget.id] }),
  });
  const targetsBody2 = await readJson(targetsRes);
  assert.equal(targetsRes.status, 200, JSON.stringify(targetsBody2));

  const activateRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/activate`, { method: "POST", headers });
  const activateBody = await readJson(activateRes);
  assert.equal(activateRes.status, 200, JSON.stringify(activateBody));

  const res = await fetch(`${server.baseUrl}/api/modules/${TEST_MODULE_ID}/lessons`, {
    headers: { Cookie: cookieFor(fx.learnerId, "learner") },
  });
  const body = await readJson(res);
  assert.equal(res.status, 403, JSON.stringify(body));
  assert.equal(body.code, "NOT_ACTIVE_FOR_PERIOD");
});

test("period-payment enforcement: instructors and admins are never blocked by a period payment requirement", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  const { instanceId, period1Id } = await createStructuredActiveInstance(server.baseUrl, headers);
  await fetch(`${server.baseUrl}/api/learning-instances/${instanceId}/academic-periods/${period1Id}/payment-requirement`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ mode: "full", requiredAmountGHS: 500 }),
  });

  const adminRes = await fetch(`${server.baseUrl}/api/modules/${TEST_MODULE_ID}/lessons`, {
    headers: { Cookie: cookieFor(fx.adminId, "admin") },
  });
  assert.equal(adminRes.status, 200);
});

test("period-payment: the Paystack-style initiate flow (dev-mode auto-complete) charges only the outstanding delta and satisfies the requirement", async (t) => {
  const { dbDir, dbPath, env } = prepareDb({ production: false });
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
    body: JSON.stringify({ mode: "deposit", requiredAmountGHS: 40 }),
  });

  const learnerHeaders = { "Content-Type": "application/json", Cookie: cookieFor(fx.learnerId, "learner") };
  const initiateRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/initiate`, {
    method: "POST",
    headers: learnerHeaders,
    body: JSON.stringify({
      type: "period",
      method: "MOBILE_MONEY",
      network: "MTN",
      momoNumber: "0244000000",
      learningInstanceId: instanceId,
      learningInstanceAcademicPeriodId: period1Id,
    }),
  });
  const initiateBody = await readJson(initiateRes);
  assert.equal(initiateRes.status, 200, JSON.stringify(initiateBody));
  assert.equal(initiateBody.totalGHS, 40);

  const statusRes = await fetch(`${server.baseUrl}/api/learning-instances/${instanceId}/academic-periods/${period1Id}/learners/${fx.learnerId}/payment-status`, {
    headers: adminHeaders,
  });
  const statusBody = await readJson(statusRes);
  assert.equal(statusRes.status, 200, JSON.stringify(statusBody));
  assert.equal(statusBody.satisfied, true);
  assert.equal(statusBody.amountPaidGHS, 40);

  // Re-initiating once already satisfied must be rejected rather than
  // charging (and duplicating) the same period payment again.
  const secondInitiateRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/initiate`, {
    method: "POST",
    headers: learnerHeaders,
    body: JSON.stringify({
      type: "period",
      method: "MOBILE_MONEY",
      network: "MTN",
      momoNumber: "0244000000",
      learningInstanceId: instanceId,
      learningInstanceAcademicPeriodId: period1Id,
    }),
  });
  assert.equal(secondInitiateRes.status, 409);
});
