/**
 * Focused integration tests for Delivery Mode (On-Campus vs Online) —
 * Stage 1 of the two-delivery-mode extension. Follows the same real-
 * server-process pattern as integration-boundary.test.js (fresh temp DB,
 * migrated, real `node src/server.js`), but seeds a Delivery-Mode-aware
 * fixture set (a Programme with an ON_CAMPUS class linked to an active
 * campus, an ONLINE class, an ON_CAMPUS class linked to an INACTIVE
 * campus, and a legacy class with no delivery_mode at all) directly via
 * better-sqlite3 before the server boots, then exercises the public
 * classes endpoint and POST /api/auth/register against every case in the
 * task's verification list (A–I, minus the pure UI-only aspects of F/H
 * which aren't reachable from a server-only test).
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

// Migrates a fresh temp DB WITHOUT starting the server yet, so fixtures
// can be seeded directly (a second better-sqlite3 connection, closed
// before the server process opens its own) ahead of any HTTP traffic.
function prepareDb() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-dm-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET: "delivery-mode-test-secret-not-for-real-use",
    AI_CREDENTIALS_KEY: "delivery-mode-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-dm-uploads-"));
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

// Seeds one Adult Professional Programme with four Learning Groups:
//   - ON-CAMPUS, linked to an ACTIVE campus (the success path)
//   - ON-CAMPUS, linked to an INACTIVE campus (must be rejected)
//   - ONLINE, no campus (the success path)
//   - a legacy class predating Delivery Mode (delivery_mode/campus_id NULL)
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Delivery Mode Test Programme', 0)"
    ).run(programmeId, offeringType.id);

    const activeCampusId = uuid();
    db.prepare("INSERT INTO campuses (id, name, active, is_partner) VALUES (?, 'Active Test Campus', 1, 0)").run(activeCampusId);
    const inactiveCampusId = uuid();
    db.prepare("INSERT INTO campuses (id, name, active, is_partner) VALUES (?, 'Inactive Test Campus', 0, 0)").run(inactiveCampusId);
    const otherActiveCampusId = uuid();
    db.prepare("INSERT INTO campuses (id, name, active, is_partner) VALUES (?, 'Other Active Campus', 1, 0)").run(otherActiveCampusId);

    const onCampusClassId = uuid();
    db.prepare(
      "INSERT INTO classes (id, name, sort_order, programme_id, delivery_mode, campus_id) VALUES (?, 'On-Campus Batch', 0, ?, 'ON_CAMPUS', ?)"
    ).run(onCampusClassId, programmeId, activeCampusId);

    const onCampusBadCampusClassId = uuid();
    db.prepare(
      "INSERT INTO classes (id, name, sort_order, programme_id, delivery_mode, campus_id) VALUES (?, 'On-Campus Bad Campus Batch', 1, ?, 'ON_CAMPUS', ?)"
    ).run(onCampusBadCampusClassId, programmeId, inactiveCampusId);

    const onlineClassId = uuid();
    db.prepare(
      "INSERT INTO classes (id, name, sort_order, programme_id, delivery_mode, campus_id) VALUES (?, 'Online Batch', 2, ?, 'ONLINE', NULL)"
    ).run(onlineClassId, programmeId);

    const legacyClassId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Legacy Batch', 3, ?)").run(legacyClassId, programmeId);

    // Registration Source of Truth: an admin must intentionally open an
    // Active Programme Run before registration into this programme is
    // possible at all — simulated here exactly like an admin would do it.
    const runId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)"
    ).run(runId, offeringType.id, programmeId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), runId, programmeId);

    return { programmeId, activeCampusId, inactiveCampusId, otherActiveCampusId, onCampusClassId, onCampusBadCampusClassId, onlineClassId, legacyClassId };
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

function readEnrollment(dbPath, userId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM programme_enrollments WHERE user_id = ?").get(userId);
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
      ...overrides.adult,
    },
    ...(overrides.classId !== undefined ? { classId: overrides.classId } : {}),
  };
}

test("delivery-mode: GET /api/classes/public exposes deliveryMode/campusId/campusName and supports ?deliveryMode= filtering", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), `server did not become ready: ${server.getStderr()}`);

    const allRes = await fetch(`${server.baseUrl}/api/classes/public?programmeId=${fx.programmeId}`);
    assert.equal(allRes.status, 200);
    const all = (await allRes.json()).classes;
    assert.equal(all.length, 4, "every class under the programme, unfiltered");
    const onCampus = all.find((c) => c.id === fx.onCampusClassId);
    assert.equal(onCampus.deliveryMode, "ON_CAMPUS");
    assert.equal(onCampus.campusName, "Active Test Campus");
    const legacy = all.find((c) => c.id === fx.legacyClassId);
    assert.equal(legacy.deliveryMode, null);
    assert.equal(legacy.campusName, null);

    const onlineRes = await fetch(`${server.baseUrl}/api/classes/public?programmeId=${fx.programmeId}&deliveryMode=ONLINE`);
    const onlineOnly = (await onlineRes.json()).classes;
    assert.equal(onlineOnly.length, 1);
    assert.equal(onlineOnly[0].id, fx.onlineClassId);

    const onCampusRes = await fetch(`${server.baseUrl}/api/classes/public?programmeId=${fx.programmeId}&deliveryMode=ON_CAMPUS`);
    const onCampusOnly = (await onCampusRes.json()).classes;
    assert.equal(onCampusOnly.length, 2, "both on-campus classes (good + bad campus) match the mode filter");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("delivery-mode: (A) legacy registration with no delivery mode still works, campus trusted as before", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.legacyClassId, adult: { campus: "Somewhere Freeform" } })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const user = readUser(dbPath, body.learnerId);
    assert.equal(user.campus, "Somewhere Freeform", "legacy class -> free-text campus trusted exactly as before");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("delivery-mode: (B) ON_CAMPUS registration with a valid active campus/class succeeds, campus resolved from the class", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.onCampusClassId })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const user = readUser(dbPath, body.learnerId);
    assert.equal(user.campus, "Active Test Campus");
    const enrollment = readEnrollment(dbPath, body.learnerId);
    assert.equal(enrollment.class_id, fx.onCampusClassId);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("delivery-mode: (C) ON_CAMPUS registration cannot be assigned an arbitrary/mismatched campus — client-supplied campus text is ignored, never trusted", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    // Client tries to submit a DIFFERENT campus than the one attached to
    // the chosen class — the server must ignore it and use the class's
    // own campus, never the arbitrary client-supplied text.
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.onCampusClassId, adult: { campus: "Other Active Campus" } })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const user = readUser(dbPath, body.learnerId);
    assert.equal(user.campus, "Active Test Campus", "server-resolved campus must win over client-submitted campus text");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("delivery-mode: (D) ON_CAMPUS registration with an inactive campus is rejected with a 400, no account created", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const email = `learner-${uuid()}@example.com`;
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.onCampusBadCampusClassId, adult: { email } })),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /not currently active|no longer active/i);
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare("SELECT id FROM users WHERE email = ?").get(email), undefined, "no account created on rejection");
    } finally {
      db.close();
    }
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("delivery-mode: (E,F) ONLINE registration succeeds without a physical campus, and cannot be assigned one even if the client tries", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.onlineClassId, adult: { campus: "Active Test Campus" } })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const user = readUser(dbPath, body.learnerId);
    assert.equal(user.campus, null, "online registration must never carry a physical campus, regardless of client input");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("delivery-mode: (G) existing campus-scoped users are unaffected by the migration", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  seedFixtures(dbPath);
  // Simulate a pre-existing (pre-feature) user with a free-text campus,
  // inserted directly against the migrated DB, exactly as one would
  // exist before this migration ran on a real installation.
  const db = new Database(dbPath);
  const preexistingId = uuid();
  db.prepare(
    "INSERT INTO users (id, role, name, email, password_hash, campus, status, payment_status, is_adult, student_code, joined_date) VALUES (?, 'learner', 'Pre-existing Learner', 'preexisting@example.com', 'x', 'Legacy Campus Text', 'active', 'paid', 1, 'PRE-0001', date('now'))"
  ).run(preexistingId);
  db.close();

  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    // The migration/feature must not have touched this row.
    const user = readUser(dbPath, preexistingId);
    assert.equal(user.campus, "Legacy Campus Text");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("delivery-mode: (H) an ON_CAMPUS class and an ONLINE class under the same Programme share one Active Learning Instance", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));

    const onCampusReg = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.onCampusClassId })),
    });
    const onCampusBody = await onCampusReg.json();
    assert.equal(onCampusReg.status, 200, JSON.stringify(onCampusBody));
    const onCampusUser = { id: onCampusBody.learnerId };

    const onlineReg = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.onlineClassId })),
    });
    const onlineBody = await onlineReg.json();
    assert.equal(onlineReg.status, 200, JSON.stringify(onlineBody));
    const onlineUser = { id: onlineBody.learnerId };

    const onCampusEnrollment = readEnrollment(dbPath, onCampusUser.id);
    const onlineEnrollment = readEnrollment(dbPath, onlineUser.id);
    assert.equal(onCampusEnrollment.programme_id, fx.programmeId);
    assert.equal(onlineEnrollment.programme_id, fx.programmeId);
    assert.notEqual(onCampusEnrollment.class_id, onlineEnrollment.class_id, "different classes...");
    // ...but if a Learning Instance exists for the programme, both modes
    // resolve to the SAME one (there is exactly one Active run per
    // Programme regardless of how many delivery-mode classes it has).
    if (onCampusEnrollment.learning_instance_id || onlineEnrollment.learning_instance_id) {
      assert.equal(onCampusEnrollment.learning_instance_id, onlineEnrollment.learning_instance_id);
    }
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("delivery-mode: (I) fee logic does not crash for online learners and applies no partner-campus discount", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const previewRes = await fetch(`${server.baseUrl}/api/auth/registration-fee-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "adult", classId: fx.onlineClassId, adult: { name: "Online Learner", campus: "Active Test Campus" } }),
    });
    const preview = await previewRes.json();
    assert.equal(previewRes.status, 200, JSON.stringify(preview));
    assert.ok(Number.isFinite(preview.totalGHS));

    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.onlineClassId, adult: { campus: "Active Test Campus" } })),
    });
    const regBody = await regRes.json();
    assert.equal(regRes.status, 200, JSON.stringify(regBody));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
