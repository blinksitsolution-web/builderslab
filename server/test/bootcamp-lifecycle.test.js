/**
 * Bootcamp Lifecycle Integration Tests
 *
 * Verifies:
 * 1. Capacity enforcement — transactional rejection when Operational Group is full
 * 2. Bootcamp fee resolution — uses tuition (one-time) fee, not registration fee
 * 3. Payment activation — bootcamp payment type activates account + enrolment
 * 4. Admin participant creation with waivePayment:true — immediate activation + audit log
 *
 * Follows the same server-spawn + isolated DB pattern as all other integration
 * tests in this suite (card-payment.test.js, delivery-mode-registration.test.js, etc.)
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
const JWT_SECRET = "bootcamp-lifecycle-test-secret-key";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-bootcamp-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "bootcamp-test-ai-key",
    DB_PATH: dbPath,
  };
  delete env.NODE_ENV;
  delete env.PAYSTACK_SECRET_KEY; // dev fallback auto-completes payments
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-bootcamp-uploads-"));
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

// Seeds Bootcamp offering type, programme, run (with learning_instance_targets),
// and two operational groups — Cohort A (capacity 2) and Cohort B (uncapped).
// Returns all seeded IDs for use in tests.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    // Resolve Bootcamp offering type from the seeded learning_offering_types table
    const bootcampOT = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'bootcamp'").get();
    if (!bootcampOT) throw new Error("Bootcamp offering type not found — has migration seeded it?");

    const programmeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Cybersecurity Bootcamp', 0)"
    ).run(programmeId, bootcampOT.id);

    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Cohort Class', 0, ?)").run(classId, programmeId);

    const runId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name, registration_fee_ghs) VALUES (?, ?, ?, 'active', 'Fall 2026 Bootcamp Run', 350)"
    ).run(runId, bootcampOT.id, programmeId);

    // The run must have a primary target so resolveActiveInstanceForRegistration finds it
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), runId, programmeId);

    // Set instance fee (tuition = bootcamp one-time fee) via the config column
    // operational_groups.fee_ghs overrides this for capacity-limited cohorts
    db.prepare("UPDATE learning_instances SET fee_ghs = 600 WHERE id = ?").run(runId);

    // Cohort A — capacity 2, fee override 550
    const cohortAId = uuid();
    db.prepare(
      "INSERT INTO operational_groups (id, learning_instance_id, name, is_active) VALUES (?, ?, 'Cohort A', 1)"
    ).run(cohortAId, runId);
    // Set capacity and fee_ghs via ALTER-TABLE'd columns
    db.prepare("UPDATE operational_groups SET capacity = 2, fee_ghs = 550 WHERE id = ?").run(cohortAId);

    // Cohort B — uncapped
    const cohortBId = uuid();
    db.prepare(
      "INSERT INTO operational_groups (id, learning_instance_id, name, is_active) VALUES (?, ?, 'Cohort B', 1)"
    ).run(cohortBId, runId);

    // Admin user for participant-creation tests
    const adminId = uuid();
    const adminEmail = `bootcamp-admin-${adminId.slice(0, 6)}@dalijaytechhub.online`;
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date) VALUES (?, 'admin', 'BC Admin', ?, 'hash', 'active', 'current', date('now'))"
    ).run(adminId, adminEmail);

    return { programmeId, classId, runId, cohortAId, cohortBId, adminId };
  } finally {
    db.close();
  }
}

test("Bootcamp capacity enforcement — third registrant into a full Cohort A is rejected with 409", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });

  t: try {
    assert.ok(await waitForReady(server.baseUrl, 10000), `Server failed to start:\n${server.getStderr()}`);

    function adultPayload(email, cohortId) {
      return {
        kind: "adult",
        classId: fx.classId,
        operationalGroupId: cohortId,
        adult: {
          name: "Bootcamp Learner",
          email,
          phone: "0501234567",
          password: "Passw0rd123!",
          town: "Accra",
          country: "GH",
        },
      };
    }

    // Register learner 1 — should succeed
    const res1 = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload(`bc-learner1-${uuid().slice(0, 6)}@test.com`, fx.cohortAId)),
    });
    const body1 = await res1.json();
    assert.equal(res1.status, 200, `Learner 1 registration failed: ${JSON.stringify(body1)}`);

    // Register learner 2 — should succeed (fills capacity)
    const res2 = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload(`bc-learner2-${uuid().slice(0, 6)}@test.com`, fx.cohortAId)),
    });
    const body2 = await res2.json();
    assert.equal(res2.status, 200, `Learner 2 registration failed: ${JSON.stringify(body2)}`);

    // Register learner 3 — should be rejected (exceeds capacity of 2)
    const res3 = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload(`bc-learner3-${uuid().slice(0, 6)}@test.com`, fx.cohortAId)),
    });
    const body3 = await res3.json();
    assert.equal(res3.status, 409, `Expected 409 capacity rejection, got ${res3.status}: ${JSON.stringify(body3)}`);
    assert.match(body3.error, /capacity/i, "Error message must mention capacity");

    // Verify no third account was created
    const db = new Database(dbPath, { readonly: true });
    const enrollCount = db.prepare("SELECT COUNT(*) AS c FROM programme_enrollments WHERE operational_group_id = ?").get(fx.cohortAId);
    db.close();
    assert.equal(enrollCount.c, 2, "Exactly 2 enrolments should exist in Cohort A after the rejection");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("Bootcamp payment activation — bootcamp type payment activates account and primary enrolment", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });

  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), `Server failed to start:\n${server.getStderr()}`);

    const learnerEmail = `bc-paytest-${uuid().slice(0, 6)}@test.com`;
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "adult",
        classId: fx.classId,
        operationalGroupId: fx.cohortBId,
        adult: {
          name: "Pay Test Learner",
          email: learnerEmail,
          phone: "0501234568",
          password: "Passw0rd123!",
          town: "Accra",
          country: "GH",
        },
      }),
    });
    const regBody = await regRes.json();
    assert.equal(regRes.status, 200, `Registration failed: ${JSON.stringify(regBody)}`);
    const learnerId = regBody.learnerId;
    assert.ok(learnerId, "Must get learnerId from registration");

    // Confirm account starts pending
    {
      const db = new Database(dbPath, { readonly: true });
      const user = db.prepare("SELECT status, payment_status FROM users WHERE id = ?").get(learnerId);
      db.close();
      assert.equal(user.status, "pending_payment");
    }

    // Initiate + auto-complete bootcamp payment (dev mode — no PAYSTACK_SECRET_KEY)
    const payRes = await fetch(`${server.baseUrl}/api/payments/${learnerId}/initiate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: sessionCookie(learnerId, "learner"),
      },
      body: JSON.stringify({
        type: "bootcamp",
        method: "MOBILE_MONEY",
        network: "MTN",
        momoNumber: "0501234568",
      }),
    });
    const payBody = await payRes.json();
    assert.equal(payRes.status, 200, `Payment failed: ${JSON.stringify(payBody)}`);
    assert.equal(payBody.ok, true);
    // In dev mode with no Paystack key, the payment auto-completes
    assert.equal(payBody.status, "success");

    // Verify account is now active
    const db = new Database(dbPath, { readonly: true });
    const user = db.prepare("SELECT status, payment_status FROM users WHERE id = ?").get(learnerId);
    assert.equal(user.status, "active", "User status must be active after bootcamp payment");
    assert.equal(user.payment_status, "current", "payment_status must be current after bootcamp payment");

    const enrol = db.prepare("SELECT status, payment_status FROM programme_enrollments WHERE user_id = ? AND is_primary = 1").get(learnerId);
    assert.ok(enrol, "Primary enrolment must exist");
    assert.equal(enrol.status, "active", "Enrolment status must be active after bootcamp payment");
    assert.equal(enrol.payment_status, "current", "Enrolment payment_status must be current after bootcamp payment");
    db.close();
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("Admin participant creation with waivePayment:true — immediately active + audit trail", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });

  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), `Server failed to start:\n${server.getStderr()}`);

    const adminCookie = sessionCookie(fx.adminId, "admin");
    const participantEmail = `bc-waived-${uuid().slice(0, 6)}@test.com`;

    const res = await fetch(`${server.baseUrl}/api/users/participants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        name: "Waived Bootcamp Participant",
        email: participantEmail,
        phone: "0501234999",
        programmeId: fx.programmeId,
        learningInstanceId: fx.runId,
        operationalGroupId: fx.cohortBId,
        waivePayment: true,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `Admin participant creation failed: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    const participantId = body.id;

    const db = new Database(dbPath, { readonly: true });
    const user = db.prepare("SELECT status, payment_status FROM users WHERE id = ?").get(participantId);
    assert.equal(user.status, "active", "Waived participant must start as active");
    assert.equal(user.payment_status, "current", "Waived participant payment_status must be current");

    const enrol = db.prepare("SELECT status, payment_status FROM programme_enrollments WHERE user_id = ? AND is_primary = 1").get(participantId);
    assert.ok(enrol, "Primary enrolment must exist");
    assert.equal(enrol.status, "active", "Enrolment must be active immediately for waived participant");
    assert.equal(enrol.payment_status, "current", "Enrolment payment_status must be current for waived participant");

    const auditRow = db.prepare("SELECT * FROM audit_log WHERE entity_id = ? AND action = 'admin_participant_payment_waived'").get(participantId);
    assert.ok(auditRow, "Audit log entry must be created for waived payment admin action");
    db.close();
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("Admin participant creation without waivePayment — stays pending_payment as normal", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });

  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), `Server failed to start:\n${server.getStderr()}`);

    const adminCookie = sessionCookie(fx.adminId, "admin");

    const res = await fetch(`${server.baseUrl}/api/users/participants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        name: "Pending Bootcamp Participant",
        email: `bc-pending-${uuid().slice(0, 6)}@test.com`,
        phone: "0501234888",
        programmeId: fx.programmeId,
        learningInstanceId: fx.runId,
        operationalGroupId: fx.cohortBId,
        // waivePayment omitted
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `Admin participant creation failed: ${JSON.stringify(body)}`);

    const db = new Database(dbPath, { readonly: true });
    const user = db.prepare("SELECT status, payment_status FROM users WHERE id = ?").get(body.id);
    assert.equal(user.status, "pending_payment", "Participant without waiver must start pending_payment");
    assert.equal(user.payment_status, "unpaid", "Participant without waiver must start unpaid");
    db.close();
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
