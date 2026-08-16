/**
 * Stage 4A — Improve single-learner credential visibility.
 *
 * Before this: POST /:parentId/children generated a one-time plaintext
 * password (learnerPassword) that only ever existed in that single API
 * response — nothing persisted it, and the frontend that called it
 * (AddChildPage.jsx) didn't even display it. Once the page navigated
 * away, it was genuinely gone.
 *
 * This adds `users.temp_password_plaintext` (set at creation, cleared at
 * the learner's own first successful login — see routes/auth.js) and a
 * dedicated GET /:parentId/children/credentials endpoint so a parent/
 * coordinator can come back later and still see it, without weakening
 * the actual login check (still bcrypt against password_hash) or
 * leaking the plaintext through any other user-fetching endpoint.
 *
 * Same real-server-process pattern as adult-learner-transcript-certificate
 * -access.test.js.
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
const JWT_SECRET = "sponsor-credential-visibility-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-sponsor-cred-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "sponsor-credential-visibility-test-ai-key-not-for-real-use",
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
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-sponsor-cred-uploads-"));
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

function seedParent(dbPath, extra = {}) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date) VALUES (?, 'parent', ?, ?, ?, 'active', 'current', date('now'))"
    ).run(id, extra.name || "Test Parent", `parent-${id}@example.test`, bcrypt.hashSync("parentpass123", 12));
    return id;
  } finally {
    db.close();
  }
}

function seedSponsor(dbPath, extra = {}) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare("INSERT INTO sponsors (id, name, type, is_active) VALUES (?, ?, 'ngo', 1)").run(id, extra.name || "Test Sponsor");
    return id;
  } finally {
    db.close();
  }
}

function attachSponsorToParent(dbPath, parentId, sponsorId) {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE users SET sponsor_id = ? WHERE id = ?").run(sponsorId, parentId);
  } finally {
    db.close();
  }
}

function grantAccessOverride(dbPath, userId) {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE users SET access_override = 1, access_override_reason = 'test grant' WHERE id = ?").run(userId);
  } finally {
    db.close();
  }
}

function openModuleId(dbPath) {
  const db = new Database(dbPath);
  try {
    return db.prepare("SELECT id FROM courses WHERE is_open = 1 LIMIT 1").get().id;
  } finally {
    db.close();
  }
}

test("sponsor-credential-visibility: a newly-added child's credentials survive and are viewable later", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const parentId = seedParent(dbPath);
    const courseId = openModuleId(dbPath);

    const addRes = await fetch(`${server.baseUrl}/api/users/${parentId}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(parentId, "parent") },
      body: JSON.stringify({ learnerType: "child", name: "Test Child", courseIds: [courseId] }),
    });
    assert.equal(addRes.status, 200);
    const added = await addRes.json();
    assert.ok(added.learnerPassword);

    const credsRes = await fetch(`${server.baseUrl}/api/users/${parentId}/children/credentials`, {
      headers: { Cookie: sessionCookie(parentId, "parent") },
    });
    assert.equal(credsRes.status, 200);
    const { learners } = await credsRes.json();
    assert.equal(learners.length, 1);
    assert.equal(learners[0].id, added.learnerId);
    assert.equal(learners[0].password, added.learnerPassword);
    assert.equal(learners[0].credentialsAvailable, true);
    assert.equal(learners[0].username, added.learnerLoginEmail);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-credential-visibility: the plaintext password disappears after the learner's own first login", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const parentId = seedParent(dbPath);
    const courseId = openModuleId(dbPath);

    const addRes = await fetch(`${server.baseUrl}/api/users/${parentId}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(parentId, "parent") },
      body: JSON.stringify({ learnerType: "child", name: "Test Child", courseIds: [courseId] }),
    });
    const added = await addRes.json();

    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: added.learnerLoginEmail, password: added.learnerPassword }),
    });
    assert.equal(loginRes.status, 200);

    const credsRes = await fetch(`${server.baseUrl}/api/users/${parentId}/children/credentials`, {
      headers: { Cookie: sessionCookie(parentId, "parent") },
    });
    const { learners } = await credsRes.json();
    assert.equal(learners[0].password, null);
    assert.equal(learners[0].credentialsAvailable, false);

    // And login still works completely normally afterwards — clearing
    // the plaintext column never touches password_hash / the actual
    // login check.
    const secondLogin = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: added.learnerLoginEmail, password: added.learnerPassword }),
    });
    assert.equal(secondLogin.status, 200);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-credential-visibility: an unrelated parent cannot view another parent's learner credentials", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const parentId = seedParent(dbPath, { name: "Owner Parent" });
    const otherParentId = seedParent(dbPath, { name: "Other Parent" });
    const courseId = openModuleId(dbPath);

    await fetch(`${server.baseUrl}/api/users/${parentId}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(parentId, "parent") },
      body: JSON.stringify({ learnerType: "child", name: "Test Child", courseIds: [courseId] }),
    });

    const res = await fetch(`${server.baseUrl}/api/users/${parentId}/children/credentials`, {
      headers: { Cookie: sessionCookie(otherParentId, "parent") },
    });
    assert.equal(res.status, 403);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-credential-visibility: the credentials view includes the learner's programme/class name (Stage 4B)", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const parentId = seedParent(dbPath);
    const courseId = openModuleId(dbPath);

    await fetch(`${server.baseUrl}/api/users/${parentId}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(parentId, "parent") },
      body: JSON.stringify({ learnerType: "child", name: "Test Child", courseIds: [courseId] }),
    });

    const credsRes = await fetch(`${server.baseUrl}/api/users/${parentId}/children/credentials`, {
      headers: { Cookie: sessionCookie(parentId, "parent") },
    });
    const { learners } = await credsRes.json();
    // Kids STEM's default entry class is "Foundation" (seeded by
    // migrate.js) unless the request named a specific programme/class.
    assert.equal(learners[0].className, "Foundation");
    assert.ok("programmeName" in learners[0]);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-credential-visibility: the plaintext password never leaks through the general user-fetch endpoint", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const parentId = seedParent(dbPath);
    const courseId = openModuleId(dbPath);

    const addRes = await fetch(`${server.baseUrl}/api/users/${parentId}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(parentId, "parent") },
      body: JSON.stringify({ learnerType: "child", name: "Test Child", courseIds: [courseId] }),
    });
    const added = await addRes.json();

    const userRes = await fetch(`${server.baseUrl}/api/users/${added.learnerId}`, {
      headers: { Cookie: sessionCookie(parentId, "parent") },
    });
    assert.equal(userRes.status, 200);
    const { user } = await userRes.json();
    assert.equal(user.temp_password_plaintext, undefined);
    assert.equal(user.password_hash, undefined);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-credential-visibility (Stage 4C): credentials view distinguishes sponsor-paid, admin-free-access, and self-paid learners", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const courseId = openModuleId(dbPath);

    // Sponsor-paid: coordinator's own account carries sponsor_id, so any
    // child they add inherits it and payment is waived.
    const sponsorId = seedSponsor(dbPath, { name: "Acme Foundation" });
    const coordinatorId = seedParent(dbPath, { name: "Coordinator" });
    attachSponsorToParent(dbPath, coordinatorId, sponsorId);
    const sponsoredRes = await fetch(`${server.baseUrl}/api/users/${coordinatorId}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(coordinatorId, "parent") },
      body: JSON.stringify({ learnerType: "child", name: "Sponsored Child", courseIds: [courseId] }),
    });
    assert.equal(sponsoredRes.status, 200);

    // Ordinary parent, no sponsor: self/parent-paid.
    const parentId = seedParent(dbPath, { name: "Ordinary Parent" });
    const paidRes = await fetch(`${server.baseUrl}/api/users/${parentId}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(parentId, "parent") },
      body: JSON.stringify({ learnerType: "child", name: "Self Paid Child", courseIds: [courseId] }),
    });
    assert.equal(paidRes.status, 200);
    const paidAdded = await paidRes.json();
    // Hub/admin grants a free-access override directly on this learner
    // (independent of any sponsor).
    grantAccessOverride(dbPath, paidAdded.learnerId);

    const sponsoredCreds = await fetch(`${server.baseUrl}/api/users/${coordinatorId}/children/credentials`, {
      headers: { Cookie: sessionCookie(coordinatorId, "parent") },
    });
    const { learners: sponsoredLearners } = await sponsoredCreds.json();
    assert.equal(sponsoredLearners[0].accessType, "sponsor");
    assert.equal(sponsoredLearners[0].sponsorName, "Acme Foundation");

    const paidCreds = await fetch(`${server.baseUrl}/api/users/${parentId}/children/credentials`, {
      headers: { Cookie: sessionCookie(parentId, "parent") },
    });
    const { learners: paidLearners } = await paidCreds.json();
    assert.equal(paidLearners[0].accessType, "admin_free_access");
    assert.equal(paidLearners[0].sponsorName, null);

    // The coordinator never sees the unrelated parent's learner (ownership
    // model unchanged by this task).
    assert.equal(sponsoredLearners.length, 1);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
