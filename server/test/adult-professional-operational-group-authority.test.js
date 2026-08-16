/**
 * Adult Professional — Operational Group Authority at registration.
 *
 * routes/auth.js's adult registration path validates a submitted
 * operationalGroupId against the resolved Programme Run
 * (adultLearningInstanceIdPreCheck !== group.learning_instance_id -> 400),
 * but no existing test exercised this directly. This locks it in against
 * the real registration endpoint: an Operational Group that belongs to a
 * DIFFERENT Programme Run (even one for the very same Adult Professional
 * Course) must never be attachable to a registration into another Run —
 * closing the "arbitrary operational group ID" tampering path called out
 * across the audit prompts' security sections.
 *
 * Same real-server-process pattern as adult-professional-course-id-
 * authority.test.js.
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
const JWT_SECRET = "adult-operational-group-authority-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-adult-og-authority-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "adult-operational-group-authority-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-adult-og-authority-uploads-"));
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

// One Adult Professional Course with a SINGLE active Run (so registration
// never hits the "which Run?" ambiguity path at all — this isolates the
// Operational Group check specifically), and two Operational Groups: one
// that genuinely belongs to this Run, and one that belongs to a
// DIFFERENT Run (of a different Adult Professional Course entirely).
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();

    const programmeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'OG Authority Test Programme', 0)"
    ).run(programmeId, offeringType.id);
    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Batch A', 0, ?)").run(classId, programmeId);

    const runId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name, registration_fee_ghs) VALUES (?, ?, ?, 'active', 'The Only Run', 350)"
    ).run(runId, offeringType.id, programmeId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), runId, programmeId);

    const ownGroupId = uuid();
    db.prepare(
      "INSERT INTO operational_groups (id, learning_instance_id, name, is_active) VALUES (?, ?, 'Own Batch', 1)"
    ).run(ownGroupId, runId);

    // A totally separate Adult Professional Course + its own Run + its own
    // Operational Group — the group an attacker will try to inject.
    const otherProgrammeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Unrelated OG Programme', 1)"
    ).run(otherProgrammeId, offeringType.id);
    const otherRunId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name, registration_fee_ghs) VALUES (?, ?, ?, 'active', 'Unrelated Run', 350)"
    ).run(otherRunId, offeringType.id, otherProgrammeId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), otherRunId, otherProgrammeId);
    const foreignGroupId = uuid();
    db.prepare(
      "INSERT INTO operational_groups (id, learning_instance_id, name, is_active) VALUES (?, ?, 'Foreign Batch', 1)"
    ).run(foreignGroupId, otherRunId);

    return { programmeId, classId, runId, ownGroupId, foreignGroupId };
  } finally {
    db.close();
  }
}

function adultPayload({ classId, operationalGroupId }) {
  return {
    kind: "adult",
    classId,
    ...(operationalGroupId !== undefined ? { operationalGroupId } : {}),
    adult: {
      name: "Test Learner",
      email: `learner-${uuid()}@example.com`,
      password: "Passw0rd123",
      phone: "0501234567",
    },
  };
}

function readEnrollment(dbPath, userId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM programme_enrollments WHERE user_id = ?").get(userId);
  } finally {
    db.close();
  }
}

test("adult-professional operational-group-authority: an Operational Group belonging to a DIFFERENT Run is rejected, no account created", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.classId, operationalGroupId: fx.foreignGroupId })),
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));

    const db = new Database(dbPath, { readonly: true });
    const user = db.prepare("SELECT * FROM users WHERE email LIKE 'learner-%'").get();
    db.close();
    assert.equal(user, undefined, "no account should have been created for a rejected registration");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("adult-professional operational-group-authority: the Run's own Operational Group is still accepted", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.classId, operationalGroupId: fx.ownGroupId })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const enrollment = readEnrollment(dbPath, body.learnerId);
    assert.equal(enrollment.operational_group_id, fx.ownGroupId);
    assert.equal(enrollment.learning_instance_id, fx.runId);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
