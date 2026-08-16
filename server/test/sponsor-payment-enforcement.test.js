/**
 * Sponsorship/payment correction.
 *
 * Locks in the required business rule:
 *  - a sponsor is responsible for payment for every sponsored learner;
 *  - there is no general sponsor-payment waiver — attaching a sponsor
 *    (PATCH /api/users/:userId/sponsor) must NOT flip payment_status to
 *    something unrestricted or activate a pending account by itself;
 *  - a sponsored learner whose sponsor hasn't paid stays server-side
 *    restricted from learning content (GET /api/notes), same as any
 *    other unpaid learner — not just a frontend badge;
 *  - once a real payment is recorded against that learner (the existing
 *    admin PATCH /api/payments/:userId/status flow), access opens up;
 *  - a Hub/admin Access Override (PATCH /:userId/access-override) is the
 *    only mechanism that grants free access with no payment at all, and
 *    stays fully independent of sponsor_id.
 *
 * Same real-server-process pattern as sponsor-credential-visibility.test.js
 * and period-payment-enforcement.test.js.
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
const JWT_SECRET = "sponsor-payment-enforcement-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-sponsor-payment-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "sponsor-payment-enforcement-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-sponsor-payment-uploads-"));
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

function seedAdmin(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', ?, 'x', 'active', 'current', 1, ?, date('now'), ?)"
    ).run(adminId, `sponsor-payment-admin-${adminId}@example.test`, `ADM-SP-${adminId.slice(0, 8)}`, superAdminTemplate ? superAdminTemplate.id : null);
    return adminId;
  } finally {
    db.close();
  }
}

function seedSponsor(dbPath) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare("INSERT INTO sponsors (id, name, type, is_active) VALUES (?, 'Test Sponsor Org', 'ngo', 1)").run(id);
    return id;
  } finally {
    db.close();
  }
}

// A learner in the exact state a normal, not-yet-paid self-registration
// leaves them in — 'pending_payment' / 'unpaid' — so this test starts from
// the same baseline every ordinary registrant does, before a sponsor is
// ever involved.
function seedUnpaidLearner(dbPath) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, student_code)
       VALUES (?, 'learner', 'Unpaid Learner', ?, ?, 'pending_payment', 'unpaid', date('now'), ?)`
    ).run(id, `learner-${id}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${id.slice(0, 8)}`);
    return id;
  } finally {
    db.close();
  }
}

test("sponsor-payment-enforcement: attaching a sponsor does NOT waive payment or activate a pending account", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const adminId = seedAdmin(dbPath);
    const sponsorId = seedSponsor(dbPath);
    const learnerId = seedUnpaidLearner(dbPath);

    const attachRes = await fetch(`${server.baseUrl}/api/users/${learnerId}/sponsor`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(adminId, "admin") },
      body: JSON.stringify({ sponsorId }),
    });
    assert.equal(attachRes.status, 200);

    const db = new Database(dbPath);
    const row = db.prepare("SELECT status, payment_status, sponsor_id, balance_owed_ghs FROM users WHERE id = ?").get(learnerId);
    db.close();
    assert.equal(row.sponsor_id, sponsorId, "sponsor should be attached");
    assert.equal(row.payment_status, "unpaid", "attaching a sponsor must not waive payment_status");
    assert.equal(row.status, "pending_payment", "attaching a sponsor must not auto-activate the account");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-payment-enforcement: a sponsored learner whose sponsor hasn't paid is still server-side blocked from learning content", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const adminId = seedAdmin(dbPath);
    const sponsorId = seedSponsor(dbPath);
    const learnerId = seedUnpaidLearner(dbPath);

    await fetch(`${server.baseUrl}/api/users/${learnerId}/sponsor`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(adminId, "admin") },
      body: JSON.stringify({ sponsorId }),
    });

    // Server-side enforcement, not just a frontend status — GET /api/notes
    // is gated by requireActiveAccessSelf.
    const notesRes = await fetch(`${server.baseUrl}/api/notes`, {
      headers: { Cookie: cookieFor(learnerId, "learner") },
    });
    assert.equal(notesRes.status, 403, "a sponsored-but-unpaid learner must still be access-restricted");
    const body = await notesRes.json();
    assert.equal(body.code, "ACCESS_RESTRICTED");

    // The admin now records that the sponsor actually paid (existing
    // Payments tooling — no new payment path needed).
    const payRes = await fetch(`${server.baseUrl}/api/payments/${learnerId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(adminId, "admin") },
      body: JSON.stringify({ status: "current", type: "registration", amountPaid: 350, method: "Cash", note: "Sponsor paid via bank transfer" }),
    });
    assert.equal(payRes.status, 200);

    const notesResAfter = await fetch(`${server.baseUrl}/api/notes`, {
      headers: { Cookie: cookieFor(learnerId, "learner") },
    });
    assert.equal(notesResAfter.status, 200, "access opens up once the sponsor's payment is actually recorded");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-payment-enforcement: a Hub-granted access override is independent of, and distinguishable from, sponsorship", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const adminId = seedAdmin(dbPath);
    const sponsorId = seedSponsor(dbPath);
    const learnerId = seedUnpaidLearner(dbPath);

    await fetch(`${server.baseUrl}/api/users/${learnerId}/sponsor`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(adminId, "admin") },
      body: JSON.stringify({ sponsorId }),
    });

    // Still restricted — sponsor alone never grants access.
    const before = await fetch(`${server.baseUrl}/api/notes`, { headers: { Cookie: cookieFor(learnerId, "learner") } });
    assert.equal(before.status, 403);

    // The Hub explicitly grants free access — independent of the sponsor.
    const overrideRes = await fetch(`${server.baseUrl}/api/users/${learnerId}/access-override`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieFor(adminId, "admin") },
      body: JSON.stringify({ override: true, reason: "Hub-granted free access — community outreach" }),
    });
    assert.equal(overrideRes.status, 200);

    const after = await fetch(`${server.baseUrl}/api/notes`, { headers: { Cookie: cookieFor(learnerId, "learner") } });
    assert.equal(after.status, 200, "an explicit Hub access override grants access even with an unpaid sponsor on file");

    const db = new Database(dbPath);
    const row = db.prepare("SELECT payment_status, sponsor_id, access_override FROM users WHERE id = ?").get(learnerId);
    db.close();
    // Distinguishable in the data: sponsor_id set AND payment_status still
    // unpaid AND access_override = 1 — never conflated into one state.
    assert.equal(row.sponsor_id, sponsorId);
    assert.equal(row.payment_status, "unpaid");
    assert.equal(row.access_override, 1);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-payment-enforcement: existing payment enforcement for a non-sponsored learner is unaffected", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const learnerId = seedUnpaidLearner(dbPath);

    const res = await fetch(`${server.baseUrl}/api/notes`, { headers: { Cookie: cookieFor(learnerId, "learner") } });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, "ACCESS_RESTRICTED");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
