/**
 * Focused tests for the hosted-card payment readiness/testability review:
 * webhook idempotency (duplicate delivery, including the combined-parent
 * fan-out path) and charge.failed handling. No coverage of the webhook
 * route existed before this file.
 *
 * Reuses the real-server-process pattern (fresh temp DB, migrated, real
 * `node src/server.js`) established by the other payment/registration
 * test files. Payment rows are inserted directly (bypassing
 * POST /:userId/initiate and therefore Paystack entirely) so these tests
 * exercise the webhook route itself in isolation, with a real
 * PAYSTACK_SECRET_KEY set so verifyWebhookSignature's HMAC check is
 * exercised for real rather than skipped via the dev fallback.
 *
 * Does not re-test anything already covered: not MoMo initiation, not the
 * CARD initiation request shape (card-payment.test.js), not registration/
 * country validation, not currency defaulting.
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
const PAYSTACK_SECRET_KEY = "sk_test_webhook_fake_key_for_unit_test";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-webhook-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET: "webhook-test-secret-not-for-real-use",
    AI_CREDENTIALS_KEY: "webhook-test-ai-key-not-for-real-use",
    PAYSTACK_SECRET_KEY,
    DB_PATH: dbPath,
  };
  delete env.NODE_ENV;
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  openDefaultKidsStemRun(dbPath);
  return { dbDir, dbPath, env };
}

// Registration Source of Truth: registration is only ever permitted through
// an ACTIVE Programme Run, and Programme Runs are never auto-created by the
// system. Tests that register through the default (no programmeId/classId
// sent) Kids STEM fallback need one intentionally opened, exactly as an
// admin would in production, before any /register call in this file works.
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

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-webhook-uploads-"));
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

function insertPendingCardPayment(dbPath, { userId, amount, reference, learnerIds, learnerBreakdown }) {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, method, momo_number, status, paystack_ref, date, learner_ids, learner_breakdown)
       VALUES (?, ?, ?, 'registration', 'Card', NULL, 'pending', ?, datetime('now'), ?, ?)`
    ).run(uuid(), userId, amount, reference, learnerIds ? JSON.stringify(learnerIds) : null, learnerBreakdown ? JSON.stringify(learnerBreakdown) : null);
  } finally {
    db.close();
  }
}

function readUser(dbPath, userId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
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

function countFannedOutRows(dbPath, reference) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT COUNT(*) as n FROM payments WHERE paystack_ref LIKE ?").get(`${reference}::%`).n;
  } finally {
    db.close();
  }
}

async function registerAdult(baseUrl, overrides = {}) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "adult",
      courseIds: ["HW-05"],
      adult: { name: "Test Learner", email: `learner-${uuid()}@example.com`, password: "Passw0rd123", phone: "0501234567", ...overrides },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

async function registerParentWithChildren(baseUrl, childCount, overrides = {}) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "parent-learner",
      courseIds: ["HW-05"],
      parent: { name: "Test Parent", email: `parent-${uuid()}@example.com`, password: "Passw0rd123", phone: "0501234567", ...overrides },
      learners: Array.from({ length: childCount }, (_, i) => ({ name: `Test Child ${i + 1}` })),
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

test("webhook: duplicate charge.success delivery for a CARD payment activates the account exactly once (idempotent)", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const reg = await registerAdult(server.baseUrl, { country: "US", phone: "+14155550123" });
    const reference = `DTL-webhook-${uuid()}`;
    insertPendingCardPayment(dbPath, { userId: reg.learnerId, amount: 350, reference });

    const first = await postWebhook(server.baseUrl, { event: "charge.success", data: { reference } });
    assert.equal(first.status, 200);
    const afterFirst = readUser(dbPath, reg.learnerId);
    assert.equal(afterFirst.status, "active");
    assert.equal(readPaymentByRef(dbPath, reference).status, "successful");

    // Paystack does redeliver webhooks; a second delivery for the same
    // event must be a safe no-op, not a duplicate side effect or an error.
    const second = await postWebhook(server.baseUrl, { event: "charge.success", data: { reference } });
    assert.equal(second.status, 200);
    const afterSecond = readUser(dbPath, reg.learnerId);
    assert.equal(afterSecond.status, "active");
    assert.equal(afterSecond.balance_owed_ghs, 0);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("webhook: duplicate charge.success on a combined parent CARD registration does not duplicate the per-learner fan-out rows", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const reg = await registerParentWithChildren(server.baseUrl, 2, { country: "GB", phone: "+447911123456" });
    const learnerIds = reg.learners.map((l) => l.learnerId);
    const reference = `DTL-webhook-${uuid()}`;
    insertPendingCardPayment(dbPath, {
      userId: reg.parentId,
      amount: 700,
      reference,
      learnerIds,
      learnerBreakdown: learnerIds.map((id) => ({ id, amountGHS: 350 })),
    });

    await postWebhook(server.baseUrl, { event: "charge.success", data: { reference } });
    assert.equal(countFannedOutRows(dbPath, reference), 2, "one fanned-out row per learner after the first delivery");

    await postWebhook(server.baseUrl, { event: "charge.success", data: { reference } });
    assert.equal(countFannedOutRows(dbPath, reference), 2, "a second delivery must not create duplicate fan-out rows");

    for (const id of learnerIds) {
      assert.equal(readUser(dbPath, id).status, "active");
    }
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("webhook: charge.failed marks the payment failed and does not activate the account", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const reg = await registerAdult(server.baseUrl, { country: "US", phone: "+14155550123" });
    const reference = `DTL-webhook-${uuid()}`;
    insertPendingCardPayment(dbPath, { userId: reg.learnerId, amount: 350, reference });

    const res = await postWebhook(server.baseUrl, { event: "charge.failed", data: { reference } });
    assert.equal(res.status, 200);
    assert.equal(readPaymentByRef(dbPath, reference).status, "failed");
    assert.equal(readUser(dbPath, reg.learnerId).status, "pending_payment", "a failed charge must never activate the account");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("webhook: an invalid signature is rejected and never touches payment/account state", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const reg = await registerAdult(server.baseUrl, { country: "US", phone: "+14155550123" });
    const reference = `DTL-webhook-${uuid()}`;
    insertPendingCardPayment(dbPath, { userId: reg.learnerId, amount: 350, reference });

    const res = await fetch(`${server.baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-paystack-signature": "not-a-real-signature" },
      body: JSON.stringify({ event: "charge.success", data: { reference } }),
    });
    assert.equal(res.status, 401);
    assert.equal(readPaymentByRef(dbPath, reference).status, "pending");
    assert.equal(readUser(dbPath, reg.learnerId).status, "pending_payment");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
