/**
 * Issue #5 — Failed Registration Payment Recovery.
 *
 * Scenario: a Parent registers a learner; the initial registration charge
 * fails ("Charge Attempted") but the account is still created
 * (pending_payment/unpaid, exactly as routes/auth.js always does). The
 * Parent later pays through the ONLY route the Parent Payments UI offers a
 * pending_payment ward whose Programme has no academic-period structure —
 * the generic "Pay this month's fee" action (type: "monthly",
 * routes/payments.js's single-account /:userId/initiate path) — and that
 * payment succeeds.
 *
 * Required result (utils/paymentActivation.js): this must complete
 * registration exactly as if the original registration payment had
 * succeeded — enrollment, active status, financial status, and Admin
 * enrolled/active counts must all reflect a normal successful registration,
 * not just a payment marked current. Must also be idempotent against a
 * redelivered webhook.
 *
 * Does not re-test anything already covered by card-payment-webhook.test.js
 * (basic webhook idempotency/signature/failed-charge handling) or
 * enrollment-activation.test.js (the Enrollment Activation pipeline
 * itself) — only the specific recovery gap this Issue closes.
 *
 * Same real-server-process pattern (fresh temp DB, migrated, real
 * `node src/server.js`) as those files.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const Database = require("better-sqlite3");
const { v4: uuid } = require("uuid");

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");
const PAYSTACK_SECRET_KEY = "sk_test_registration_recovery_fake_key_for_unit_test";

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

// Registration Source of Truth: registration only ever succeeds through an
// ACTIVE Programme Run, and Programme Runs are never auto-created — every
// default (no programmeId/classId) "parent-learner" registration in this
// file needs the Kids STEM run intentionally opened first, exactly as an
// admin would in production (same helper as card-payment-webhook.test.js).
function openDefaultKidsStemRun(dbPath) {
  const db = new Database(dbPath);
  try {
    const programme = db
      .prepare(
        `SELECT p.id, p.offering_type_id FROM programmes p
         JOIN learning_offering_types t ON t.id = p.offering_type_id
         WHERE t.slug = 'kids_stem' LIMIT 1`
      )
      .get();
    if (!programme) return;
    const existing = db
      .prepare("SELECT id FROM learning_instances WHERE programme_id = ? AND status = 'active'")
      .get(programme.id);
    if (existing) return;
    const runId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)"
    ).run(runId, programme.offering_type_id, programme.id);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), runId, programme.id);
  } finally {
    db.close();
  }
}

// `withPaystackKey`: the webhook route (POST /api/payments/webhook) needs a
// configured PAYSTACK_SECRET_KEY to verify its HMAC signature, while the
// dev-mode auto-complete fallback on POST /:userId/initiate only ever
// triggers when NO key is configured — the two are mutually exclusive
// within a single server process, so each test below picks whichever one
// it actually needs to exercise (webhook redelivery vs. the plain
// initiate-endpoint flow), same split card-payment-webhook.test.js and
// card-payment.test.js already use for the same reason.
function prepareDb({ withPaystackKey = false } = {}) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-regrecovery-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET: "regrecovery-test-secret-not-for-real-use",
    AI_CREDENTIALS_KEY: "regrecovery-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  delete env.NODE_ENV;
  if (withPaystackKey) {
    env.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET_KEY;
  } else {
    delete env.PAYSTACK_SECRET_KEY;
  }
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  openDefaultKidsStemRun(dbPath);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-regrecovery-uploads-"));
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

function readUser(dbPath, userId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  } finally {
    db.close();
  }
}

function readPrimaryEnrollment(dbPath, userId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM programme_enrollments WHERE user_id = ? AND is_primary = 1").get(userId);
  } finally {
    db.close();
  }
}

function readEnrollment(dbPath, userId, courseId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?").get(userId, courseId);
  } finally {
    db.close();
  }
}

function countAdminEnrolledActive(dbPath, classId) {
  // Same shape the Admin Overview "enrolled/active" counts are read from:
  // users.status alongside the primary programme_enrollments row.
  const db = new Database(dbPath, { readonly: true });
  try {
    const enrolled = db
      .prepare("SELECT COUNT(*) AS n FROM programme_enrollments WHERE class_id = ? AND status IN ('active','pending_payment')")
      .get(classId).n;
    const active = db.prepare("SELECT COUNT(*) AS n FROM users WHERE class_id = ? AND status = 'active'").get(classId).n;
    return { enrolled, active };
  } finally {
    db.close();
  }
}

function readPaymentByRef(dbPath, ref) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM payments WHERE paystack_ref = ?").get(ref);
  } finally {
    db.close();
  }
}

function countEnrollmentRows(dbPath, userId, courseId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM enrollments WHERE user_id = ? AND course_id = ?").get(userId, courseId).n;
  } finally {
    db.close();
  }
}

function signedWebhookBody(eventPayload) {
  const raw = Buffer.from(JSON.stringify(eventPayload));
  const signature = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(raw).digest("hex");
  return { raw, signature };
}

async function postWebhook(baseUrl, eventPayload) {
  const { raw, signature } = signedWebhookBody(eventPayload);
  return fetch(`${baseUrl}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": signature },
    body: raw,
  });
}

function insertPendingMonthlyPayment(dbPath, { userId, amount, reference }) {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, method, momo_number, status, paystack_ref, date)
       VALUES (?, ?, ?, 'monthly', 'MTN MoMo', '0501234567', 'pending', ?, datetime('now'))`
    ).run(uuid(), userId, amount, reference);
  } finally {
    db.close();
  }
}

async function registerParentWithOneChild(baseUrl, overrides = {}) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "parent-learner",
      courseIds: ["HW-05"],
      parent: { name: "Test Parent", email: `parent-${uuid()}@example.com`, password: "Passw0rd123", phone: "0501234567", ...overrides },
      learners: [{ name: "Test Child" }],
    }),
  });
  const body = await res.json();
  const cookie = res.headers.get("set-cookie");
  assert.equal(res.status, 200, JSON.stringify(body));
  return { body, cookie };
}

test("registration recovery: 'Pay this month's fee' after a failed registration charge completes registration exactly like a first-attempt success, and survives a redelivered webhook", async () => {
  const { dbDir, dbPath, env } = prepareDb({ withPaystackKey: true });
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());

    // 1. Parent registers a learner. Registration itself never touches
    //    payment (routes/auth.js) — the account is created pending_payment/
    //    unpaid regardless of what happens to the charge next, exactly
    //    matching "the initial registration payment fails but the account
    //    is nevertheless created".
    const { body: reg } = await registerParentWithOneChild(server.baseUrl, { country: "GH" });
    const learnerId = reg.learnerId;

    const beforeUser = readUser(dbPath, learnerId);
    assert.equal(beforeUser.status, "pending_payment");
    assert.equal(beforeUser.payment_status, "unpaid");
    const beforePrimary = readPrimaryEnrollment(dbPath, learnerId);
    assert.ok(beforePrimary, "a primary programme_enrollments row must exist from registration");
    assert.equal(beforePrimary.status, "pending_payment");
    assert.equal(countEnrollmentRows(dbPath, learnerId, "HW-05"), 0, "no course access before any successful payment");

    const { active: activeBefore } = countAdminEnrolledActive(dbPath, beforeUser.class_id);

    // 2. No registration-type payment is ever recorded successful for this
    //    learner (the charge attempt failed / was never retried through the
    //    combined registration flow). The Parent instead pays through the
    //    generic single-account path — the same request shape
    //    PayMonthlyFeeModal/initiateMonthlyPayment sends ("Pay this month's
    //    fee" — the only payment action ParentPaymentsPage offers when the
    //    ward's Programme has no academic-period structure, which the Kids
    //    STEM Foundation class used here does not). Inserted directly
    //    (bypassing the real Paystack call, same convention
    //    card-payment-webhook.test.js's insertPendingCardPayment uses) so
    //    the webhook route below can be exercised with real signature
    //    verification.
    const reference = `DTL-recovery-${uuid()}`;
    insertPendingMonthlyPayment(dbPath, { userId: learnerId, amount: 60, reference });

    const first = await postWebhook(server.baseUrl, { event: "charge.success", data: { reference } });
    assert.equal(first.status, 200);

    // 3. Required result: registration completes exactly as a first-attempt
    //    success would have.
    const afterUser = readUser(dbPath, learnerId);
    assert.equal(afterUser.status, "active", "learner must become active");
    assert.equal(afterUser.payment_status, "current", "financial status must reflect the successful payment");
    assert.equal(afterUser.balance_owed_ghs, 0);

    const afterPrimary = readPrimaryEnrollment(dbPath, learnerId);
    assert.equal(afterPrimary.status, "active", "primary enrolment must activate");
    assert.equal(afterPrimary.payment_status, "current");

    assert.equal(countEnrollmentRows(dbPath, learnerId, "HW-05"), 1, "learner must be enrolled into the requested course exactly once");

    const { active: activeAfter } = countAdminEnrolledActive(dbPath, afterUser.class_id);
    assert.equal(activeAfter, activeBefore + 1, "Admin active-learner count must increase by exactly one");
    assert.equal(beforePrimary.status, "pending_payment", "sanity: enrolment was only pending before payment");
    assert.equal(afterPrimary.status, "active", "Admin 'enrolled' figure now reflects an ACTIVE enrolment, not merely a pending one");

    // 4. Idempotency: a redelivered webhook for the same successful payment
    //    (Paystack does redeliver) must not duplicate enrollment/
    //    activation/payment records.
    const second = await postWebhook(server.baseUrl, { event: "charge.success", data: { reference } });
    assert.equal(second.status, 200);

    const finalUser = readUser(dbPath, learnerId);
    assert.equal(finalUser.status, "active");
    assert.equal(finalUser.balance_owed_ghs, 0);
    assert.equal(countEnrollmentRows(dbPath, learnerId, "HW-05"), 1, "a redelivered webhook must not create a duplicate enrollment row");
    assert.equal(readPaymentByRef(dbPath, reference).status, "successful");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("registration recovery: an ordinary monthly payment on an ALREADY-active account is unaffected (no false recovery)", async () => {
  const { dbDir, dbPath, env } = prepareDb({ withPaystackKey: false });
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { body: reg, cookie } = await registerParentWithOneChild(server.baseUrl, { country: "GH" });
    const learnerId = reg.learnerId;

    // First payment completes registration (recovery path, as above).
    const firstPay = await fetch(`${server.baseUrl}/api/payments/${learnerId}/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ type: "monthly", network: "MTN", momoNumber: "0501234567" }),
    });
    assert.equal(firstPay.status, 200);
    assert.equal(readUser(dbPath, learnerId).status, "active");
    assert.equal(countEnrollmentRows(dbPath, learnerId, "HW-05"), 1);

    // A later, ordinary recurring monthly payment on the now-active account
    // must behave exactly as before this fix: mark payment current, do NOT
    // re-run curriculum activation or touch status again in a way that
    // would create a second enrollment row.
    const secondPay = await fetch(`${server.baseUrl}/api/payments/${learnerId}/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ type: "monthly", network: "MTN", momoNumber: "0501234567" }),
    });
    assert.equal(secondPay.status, 200);

    const afterUser = readUser(dbPath, learnerId);
    assert.equal(afterUser.status, "active");
    assert.equal(afterUser.payment_status, "current");
    assert.equal(countEnrollmentRows(dbPath, learnerId, "HW-05"), 1, "an ordinary later payment must not duplicate the enrollment row");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
