/**
 * Focused tests for the international-learner-support follow-up:
 * `users.country` persistence and server-side validation on
 * POST /api/auth/register.
 *
 * Same real-server-process pattern as delivery-mode-registration.test.js
 * (fresh temp DB, migrated, real `node src/server.js`) — reused here in a
 * self-contained way (no cross-file imports of that file's internals)
 * since these are two independently focused test files.
 *
 * Does NOT re-verify anything already covered elsewhere: not delivery
 * mode, not payments.currency, not phone-format rejection (the server
 * has never format-validated phone — that's enforced client-side only;
 * see country-validators-client.test.js for the client-side checks).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const Database = require("better-sqlite3");
const { v4: uuid } = require("uuid");

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-country-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET: "country-test-secret-not-for-real-use",
    AI_CREDENTIALS_KEY: "country-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  openDefaultKidsStemRun(dbPath);
  return { dbDir, dbPath, env };
}

// Registration Source of Truth: registration is only ever permitted through
// an ACTIVE Programme Run, and Programme Runs are never auto-created by the
// system. This test registers through the default (no programmeId/classId
// sent) Kids STEM fallback, so one must be intentionally opened first,
// exactly as an admin would in production.
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
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-country-uploads-"));
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

function adultPayload(overrides = {}) {
  return {
    kind: "adult",
    adult: {
      name: "Test Learner",
      email: `learner-${uuid()}@example.com`,
      password: "Passw0rd123",
      phone: "0501234567",
      ...overrides,
    },
  };
}

function parentPayload(overrides = {}) {
  return {
    kind: "parent-learner",
    parent: {
      name: "Test Parent",
      email: `parent-${uuid()}@example.com`,
      password: "Passw0rd123",
      phone: "0501234567",
      ...overrides.parent,
    },
    learners: overrides.learners || [{ name: "Test Child" }],
    courseIds: overrides.courseIds || ["HW-05"],
  };
}

test("country-registration: adult registration with no country field defaults to GH (pre-country frontend builds keep working)", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload()),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const user = readUser(dbPath, body.learnerId);
    assert.equal(user.country, "GH", "omitting country entirely must still default to GH, unchanged from before this feature existed");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("country-registration: adult registration with an explicit non-Ghana country persists it (lowercase input normalized to uppercase)", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ country: "us", phone: "+14155550123" })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const user = readUser(dbPath, body.learnerId);
    assert.equal(user.country, "US");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("country-registration: a malformed country code is rejected server-side (never silently coerced) and no account is created", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const email = `learner-${uuid()}@example.com`;
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ country: "USA", email })),
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(body.error, /country/i);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
      assert.equal(row, undefined, "a rejected registration must not create a partial account");
    } finally {
      db.close();
    }
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("country-registration: parent-learner registration persists the selected country on both the parent and the learner row", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parentPayload({ parent: { country: "GB", phone: "+447911123456" } })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const parent = readUser(dbPath, body.parentId);
    assert.equal(parent.country, "GB");
    const learnerId = body.learners[0].learnerId;
    const learner = readUser(dbPath, learnerId);
    assert.equal(learner.country, "GB", "a learner shares the registering parent's country, same pattern as phone");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("country-registration: existing GH-flow registration (no country sent) still works end-to-end, unaffected", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parentPayload()),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const parent = readUser(dbPath, body.parentId);
    assert.equal(parent.country, "GH");
    assert.equal(parent.phone, "0501234567", "existing Ghanaian registration behaviour is otherwise untouched");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
