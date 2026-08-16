/**
 * Focused tests for the GET /:reference/verify authorization boundary
 * (canViewPayment() in routes/payments.js) — the one code change from
 * this review. Does not re-test webhook idempotency, activation logic,
 * card-initiation request shape, or MoMo behavior itself; those are
 * already covered by card-payment.test.js and card-payment-webhook.test.js.
 *
 * Same real-server-process pattern as those files. Because verify always
 * makes a real call to paystack.verifyTransaction() (there is no dev
 * fallback for this route — only /:userId/initiate has one), and
 * api.paystack.co isn't reachable from this sandbox, a request that
 * clears the authorization check still can't get a clean 200: the
 * downstream network call fails and the route's existing catch block
 * turns that into a 502. That's fine for what's being tested here — the
 * authorization check runs and returns before any Paystack call is made,
 * so "not 403/404" is a reliable signal that a request passed
 * authorization, and "403"/"404" reliably means it didn't (or the
 * reference doesn't exist), regardless of network reachability.
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
const { v4: uuid } = require("uuid");

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");
const JWT_SECRET = "verify-authz-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-verify-authz-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "verify-authz-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-verify-authz-uploads-"));
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

function sessionCookie(userId, role) {
  const token = jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

// Seeds two independent families (each an unrelated parent + child) plus
// one standalone adult learner and one admin, and one combined-charge
// payment row covering both of the first parent's children — everything
// the ownership-boundary cases below need.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const mkUser = (role, extra = {}) => {
      const id = uuid();
      db.prepare(
        "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, parent_id) VALUES (?, ?, ?, ?, 'x', ?, ?, date('now'), ?)"
      ).run(
        id,
        role,
        extra.name || `Test ${role}`,
        `${role}-${id}@example.test`,
        extra.status || "active",
        extra.paymentStatus || "current",
        extra.parentId || null
      );
      return id;
    };

    const adminId = mkUser("admin");

    const parentAId = mkUser("parent");
    const childA1Id = mkUser("learner", { parentId: parentAId });
    const childA2Id = mkUser("learner", { parentId: parentAId });

    const parentBId = mkUser("parent");
    const childBId = mkUser("learner", { parentId: parentBId });

    // Not yet paid — the realistic pre-verification state, so the last
    // test below can prove verify() doesn't activate it.
    const soloAdultId = mkUser("learner", { status: "pending_payment", paymentStatus: "unpaid" });

    // Single-account payment owned directly by the solo adult.
    const soloRef = `DTL-solo-${uuid()}`;
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, method, status, paystack_ref, date)
       VALUES (?, ?, 350, 'registration', 'Card', 'pending', ?, datetime('now'))`
    ).run(uuid(), soloAdultId, soloRef);

    // Combined charge: parent A paying for both of their own children.
    const combinedRef = `DTL-combined-${uuid()}`;
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, method, status, paystack_ref, date, learner_ids)
       VALUES (?, ?, 700, 'registration', 'Card', 'pending', ?, datetime('now'), ?)`
    ).run(uuid(), parentAId, combinedRef, JSON.stringify([childA1Id, childA2Id]));

    return { adminId, parentAId, childA1Id, childA2Id, parentBId, childBId, soloAdultId, soloRef, combinedRef };
  } finally {
    db.close();
  }
}

test("verify-authz: an unrelated authenticated user cannot verify another family's payment", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    // Parent B (no relation at all) tries the solo adult's payment.
    const res = await fetch(`${server.baseUrl}/api/payments/${fx.soloRef}/verify`, {
      headers: { Cookie: sessionCookie(fx.parentBId, "parent") },
    });
    assert.equal(res.status, 403);

    // Parent B tries Parent A's combined-charge reference.
    const res2 = await fetch(`${server.baseUrl}/api/payments/${fx.combinedRef}/verify`, {
      headers: { Cookie: sessionCookie(fx.parentBId, "parent") },
    });
    assert.equal(res2.status, 403);

    // Parent B's own child tries Parent A's combined-charge reference.
    const res3 = await fetch(`${server.baseUrl}/api/payments/${fx.combinedRef}/verify`, {
      headers: { Cookie: sessionCookie(fx.childBId, "learner") },
    });
    assert.equal(res3.status, 403);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("verify-authz: the account that owns a single-account payment can verify it", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);
    const res = await fetch(`${server.baseUrl}/api/payments/${fx.soloRef}/verify`, {
      headers: { Cookie: sessionCookie(fx.soloAdultId, "learner") },
    });
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 404);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("verify-authz: the paying parent, and each covered child, can verify a combined registration payment", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const parentRes = await fetch(`${server.baseUrl}/api/payments/${fx.combinedRef}/verify`, {
      headers: { Cookie: sessionCookie(fx.parentAId, "parent") },
    });
    assert.notEqual(parentRes.status, 403);

    const child1Res = await fetch(`${server.baseUrl}/api/payments/${fx.combinedRef}/verify`, {
      headers: { Cookie: sessionCookie(fx.childA1Id, "learner") },
    });
    assert.notEqual(child1Res.status, 403);

    const child2Res = await fetch(`${server.baseUrl}/api/payments/${fx.combinedRef}/verify`, {
      headers: { Cookie: sessionCookie(fx.childA2Id, "learner") },
    });
    assert.notEqual(child2Res.status, 403);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("verify-authz: staff (admin, instructor) can verify any payment; an unknown reference is 404 for everyone", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const adminRes = await fetch(`${server.baseUrl}/api/payments/${fx.soloRef}/verify`, {
      headers: { Cookie: sessionCookie(fx.adminId, "admin") },
    });
    assert.notEqual(adminRes.status, 403);

    const notFoundRes = await fetch(`${server.baseUrl}/api/payments/DTL-does-not-exist/verify`, {
      headers: { Cookie: sessionCookie(fx.adminId, "admin") },
    });
    assert.equal(notFoundRes.status, 404);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("verify-authz: verification never activates a payment merely because the reference is known — status only flips on an actual successful Paystack verify", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    // Even the legitimate owner, calling verify with no reachable Paystack
    // (this sandbox can't reach api.paystack.co), must not have their
    // pending payment silently marked successful — activation only
    // follows a genuine "success" response from Paystack's own API.
    await fetch(`${server.baseUrl}/api/payments/${fx.soloRef}/verify`, {
      headers: { Cookie: sessionCookie(fx.soloAdultId, "learner") },
    });
    const db = new Database(dbPath, { readonly: true });
    try {
      const payment = db.prepare("SELECT * FROM payments WHERE paystack_ref = ?").get(fx.soloRef);
      assert.equal(payment.status, "pending");
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(fx.soloAdultId);
      assert.equal(user.status, "pending_payment", "must still be pending — a reachable-but-unresolved verify call must never activate the account");
    } finally {
      db.close();
    }
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
