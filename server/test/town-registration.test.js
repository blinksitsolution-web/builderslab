/**
 * Stage 4G — Town/City of residence at registration, alongside the
 * existing `country` field (see country-registration.test.js, untouched
 * by this change).
 *
 * `users.town` is a new nullable column (migrate.js's v22 migration) —
 * populated by POST /api/auth/register's `parent.town` / `adult.town`
 * (routes/auth.js's resolveTown()), inherited by every learner in a
 * parent-learner registration exactly like `country` already is. Absent
 * entirely, it stores NULL rather than being rejected, so any caller
 * that predates this field (old frontend builds, other tests) keeps
 * working — the "must provide it" requirement is enforced in the actual
 * registration form (RegisterPage.jsx's `required` Town field), not the
 * API.
 *
 * Same real-server-process pattern as country-registration.test.js.
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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-town-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET: "town-test-secret-not-for-real-use",
    AI_CREDENTIALS_KEY: "town-test-ai-key-not-for-real-use",
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
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-town-uploads-"));
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

test("town-registration: adult registration persists country and town together", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ country: "GH", town: "Kumasi" })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const user = readUser(dbPath, body.learnerId);
    assert.equal(user.country, "GH");
    assert.equal(user.town, "Kumasi");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("town-registration: parent registration persists town on both the parent and every learner", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        parentPayload({
          parent: { town: "Takoradi" },
          learners: [{ name: "Child One" }, { name: "Child Two" }],
        })
      ),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const learnerRow = readUser(dbPath, body.learnerId);
    assert.equal(learnerRow.town, "Takoradi");

    const db = new Database(dbPath, { readonly: true });
    const parentRow = db.prepare("SELECT * FROM users WHERE id = ?").get(learnerRow.parent_id);
    const allLearners = db.prepare("SELECT * FROM users WHERE parent_id = ?").all(parentRow.id);
    db.close();
    assert.equal(parentRow.town, "Takoradi");
    assert.equal(allLearners.length, 2);
    allLearners.forEach((l) => assert.equal(l.town, "Takoradi"));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("town-registration: omitting town entirely stores NULL rather than being rejected (backward compatibility)", async () => {
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
    assert.equal(user.town, null);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("town-registration: a whitespace-only town is treated the same as omitted (stores NULL, not blank spaces)", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ town: "   " })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const user = readUser(dbPath, body.learnerId);
    assert.equal(user.town, null);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("town-registration: an account created before this migration (town column absent from the INSERT) is unaffected by the new column", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    // Simulate a pre-existing row written before `town` existed: insert
    // directly without the column, same as the historical INSERT shape.
    const db = new Database(dbPath);
    const id = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, is_adult, country)
       VALUES (?, 'learner', 'Legacy Learner', ?, 'x', 'active', 'current', date('now'), 1, 'GH')`
    ).run(id, `legacy-${id}@example.com`);
    db.close();

    const row = readUser(dbPath, id);
    assert.equal(row.town, null, "a pre-existing row simply has NULL town, not an error");
    assert.equal(row.country, "GH", "country is untouched by this change");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
