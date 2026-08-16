/**
 * Bootcamp Participation Structure scoping + ACCESS_RESTRICTED regression tests.
 *
 * Covers two related defects:
 *
 * 1. BOOTCAMP — INDIVIDUAL COURSE SAVE ERROR / INVALID STRUCTURE ALLOWED:
 *    Bootcamp does not use Participation Structures at all (Learning
 *    Instance -> Operational Group -> Batch/Cohort -> Campus -> Registration
 *    Fee instead). No legacy Participation Structure enum value —
 *    structured_school_club, structured_other, or individual_course — is
 *    ever valid for Bootcamp, at either the Learning Instance config write
 *    path (routes/learningInstances.js) or the registration write path
 *    (routes/auth.js, routes/enrolments.js), and the registration-config
 *    read path (getEffectiveProgrammeParticipationStructures) must never
 *    synthesize any of the three for a Bootcamp Programme either. Kids STEM
 *    behaviour (all three values, per its existing rules) must be completely
 *    unaffected.
 *
 * 2. BOOTCAMP — INVALID STRUCTURE ALLOWED + LEARNER RESTRICTED: a fully
 *    paid, active/current Bootcamp registration must never appear
 *    access-restricted, and (defense in depth for any legacy row that
 *    somehow still carries a stale structured_* participation_structure
 *    value) isStructuredJourneyEnrollment must never classify a Bootcamp
 *    enrolment as a structured Builders' Lab journey.
 *
 * Follows the same server-spawn + isolated DB pattern as
 * bootcamp-lifecycle.test.js.
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
const JWT_SECRET = "bootcamp-ps-scoping-test-secret-key";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-ps-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = { ...process.env, JWT_SECRET, AI_CREDENTIALS_KEY: "bc-ps-test-ai-key", DB_PATH: dbPath };
  delete env.NODE_ENV;
  delete env.PAYSTACK_SECRET_KEY; // dev fallback auto-completes payments
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-ps-uploads-"));
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

// Seeds a Bootcamp offering type + programme + active run + operational
// group, plus an admin user — same shape as bootcamp-lifecycle.test.js.
function seedBootcampFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const bootcampOT = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'bootcamp'").get();
    if (!bootcampOT) throw new Error("Bootcamp offering type not found — has migration seeded it?");

    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Cybersecurity Bootcamp', 0)").run(
      programmeId,
      bootcampOT.id
    );

    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Cohort Class', 0, ?)").run(classId, programmeId);

    const runId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name, registration_fee_ghs) VALUES (?, ?, ?, 'active', 'Fall 2026 Bootcamp Run', 350)"
    ).run(runId, bootcampOT.id, programmeId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), runId, programmeId);
    db.prepare("UPDATE learning_instances SET fee_ghs = 600 WHERE id = ?").run(runId);

    const cohortId = uuid();
    db.prepare("INSERT INTO operational_groups (id, learning_instance_id, name, is_active) VALUES (?, ?, 'Cohort B', 1)").run(cohortId, runId);

    const adminId = uuid();
    const adminEmail = `bc-ps-admin-${adminId.slice(0, 6)}@dalijaytechhub.online`;
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, role_template_id) VALUES (?, 'admin', 'BC PS Admin', ?, 'hash', 'active', 'current', date('now'), ?)"
    ).run(adminId, adminEmail, superAdminTemplate?.id || null);

    return { bootcampOfferingTypeId: bootcampOT.id, programmeId, classId, runId, cohortId, adminId };
  } finally {
    db.close();
  }
}

test("Bootcamp Learning Instance — participation structure is rejected for every legacy value, including individual_course", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedBootcampFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), `Server failed to start:\n${server.getStderr()}`);
    const adminCookie = sessionCookie(fx.adminId, "admin");

    for (const value of ["individual_course", "structured_school_club", "structured_other"]) {
      const res = await fetch(`${server.baseUrl}/api/learning-instances`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({
          offeringTypeId: fx.bootcampOfferingTypeId,
          programmeId: fx.programmeId,
          name: `Bootcamp Run — ${value}`,
          participationStructure: value,
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 400, `Expected 400 for participationStructure=${value}, got ${res.status}: ${JSON.stringify(body)}`);
    }

    // Bootcamp + no participation structure at all -> succeeds (this is
    // BOOTCAMP — INDIVIDUAL COURSE SAVE ERROR's actual required outcome
    // under the corrected "Bootcamp doesn't use Participation Structures"
    // model: Save works, without individual_course ever being accepted).
    const okRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        offeringTypeId: fx.bootcampOfferingTypeId,
        programmeId: fx.programmeId,
        name: "Bootcamp Run — no participation structure",
      }),
    });
    const okBody = await okRes.json();
    assert.equal(okRes.status, 200, `Expected 200 with no participationStructure, got ${okRes.status}: ${JSON.stringify(okBody)}`);
    assert.equal(okBody.participationStructure, null, "Created Bootcamp instance must have a null participationStructure");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("Bootcamp registration — structured_other (\"structured online\") is rejected and never creates an enrolment", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedBootcampFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), `Server failed to start:\n${server.getStderr()}`);

    const email = `bc-ps-invalid-${uuid().slice(0, 6)}@test.com`;
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "adult",
        classId: fx.classId,
        operationalGroupId: fx.cohortId,
        participationStructure: "structured_other",
        adult: { name: "Invalid PS Learner", email, phone: "0501234567", password: "Passw0rd123!", town: "Accra", country: "GH" },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 400, `Expected 400, got ${res.status}: ${JSON.stringify(body)}`);

    const db = new Database(dbPath, { readonly: true });
    const created = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    db.close();
    assert.equal(created, undefined, "No account/enrolment should have been created for the rejected registration");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("Bootcamp registration + payment — no participation structure needed, and a fully paid learner is never access-restricted", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedBootcampFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), `Server failed to start:\n${server.getStderr()}`);

    const email = `bc-ps-valid-${uuid().slice(0, 6)}@test.com`;
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "adult",
        classId: fx.classId,
        operationalGroupId: fx.cohortId,
        adult: { name: "Valid Bootcamp Learner", email, phone: "0501234567", password: "Passw0rd123!", town: "Accra", country: "GH" },
      }),
    });
    const regBody = await regRes.json();
    assert.equal(regRes.status, 200, `Registration failed: ${JSON.stringify(regBody)}`);
    const learnerId = regBody.learnerId;

    const payRes = await fetch(`${server.baseUrl}/api/payments/${learnerId}/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(learnerId, "learner") },
      body: JSON.stringify({ type: "bootcamp", method: "MOBILE_MONEY", network: "MTN", momoNumber: "0501234567" }),
    });
    const payBody = await payRes.json();
    assert.equal(payRes.status, 200, `Payment failed: ${JSON.stringify(payBody)}`);

    // DB-level state: both users and programme_enrollments must be
    // synchronized to active/current (the actual chain the ticket asked us
    // to trace: registration -> payment activation -> enrollment/user
    // status -> accessRestriction()).
    const db = new Database(dbPath, { readonly: true });
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(learnerId);
    const enrolment = db.prepare("SELECT * FROM programme_enrollments WHERE user_id = ? AND is_primary = 1").get(learnerId);
    db.close();
    assert.equal(user.status, "active");
    assert.equal(user.payment_status, "current");
    assert.equal(enrolment.status, "active");
    assert.equal(enrolment.payment_status, "current");
    assert.equal(enrolment.participation_structure, null, "Bootcamp enrolment must never carry a participation structure");

    // API-level: the learner's own view must report accessRestricted:false —
    // this is the exact field the learner portal reads (see
    // client/src/pages/learner/LearnerDashboard.jsx's learner.accessRestricted).
    const meRes = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: { Cookie: sessionCookie(learnerId, "learner") },
    });
    const meBody = await meRes.json();
    assert.equal(meRes.status, 200, `GET /auth/me failed: ${JSON.stringify(meBody)}`);
    assert.equal(meBody.user.accessRestricted, false, `Fully paid Bootcamp learner must not be access-restricted: ${JSON.stringify(meBody)}`);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("getEffectiveProgrammeParticipationStructures returns no options for a Bootcamp programme, and Kids STEM is unaffected", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedBootcampFixtures(dbPath);
  // Load the util module fresh against this test's isolated DB_PATH.
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve("../src/db/db")];
  delete require.cache[require.resolve("../src/utils/learningInstances")];
  delete require.cache[require.resolve("../src/utils/offeringTypeSettings")];
  const { getEffectiveProgrammeParticipationStructures, isParticipationStructureAllowedForOfferingType } = require("../src/utils/learningInstances");
  const { getOfferingTypeById, getDefaultProgrammeForOfferingSlug } = require("../src/utils/offeringTypeSettings");
  try {
    const bootcampStructures = getEffectiveProgrammeParticipationStructures(fx.programmeId);
    assert.deepEqual(bootcampStructures, [], "Bootcamp programme must synthesize zero Participation Structure options");

    const bootcampOfferingType = getOfferingTypeById(fx.bootcampOfferingTypeId);
    for (const value of ["individual_course", "structured_school_club", "structured_other"]) {
      assert.equal(
        isParticipationStructureAllowedForOfferingType(bootcampOfferingType, value),
        false,
        `Bootcamp must never accept participationStructure=${value}`
      );
    }
    assert.equal(isParticipationStructureAllowedForOfferingType(bootcampOfferingType, null), true, "null must remain allowed for Bootcamp");

    // Kids STEM must be completely unaffected by any of the above.
    const kidsStemProgramme = getDefaultProgrammeForOfferingSlug("kids_stem");
    assert.ok(kidsStemProgramme, "Kids STEM default programme must exist (seeded by migrate.js)");
    const kidsStemOfferingType = getOfferingTypeById(kidsStemProgramme.offering_type_id);
    assert.equal(isParticipationStructureAllowedForOfferingType(kidsStemOfferingType, "individual_course"), true, "Kids STEM must still allow individual_course");
    assert.equal(isParticipationStructureAllowedForOfferingType(kidsStemOfferingType, "structured_school_club"), true, "Kids STEM must still allow structured_school_club");
    assert.equal(isParticipationStructureAllowedForOfferingType(kidsStemOfferingType, "structured_other"), true, "Kids STEM must still allow structured_other");
    const kidsStemStructures = getEffectiveProgrammeParticipationStructures(kidsStemProgramme.id);
    const kidsStemKeys = kidsStemStructures.map((s) => s.key).sort();
    assert.deepEqual(kidsStemKeys, ["individual_course", "structured_other", "structured_school_club"], "Kids STEM's legacy fallback menu must be unchanged");
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("isStructuredJourneyEnrollment never classifies a Bootcamp enrolment as a structured journey, even with a legacy stale value", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedBootcampFixtures(dbPath);
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve("../src/db/db")];
  delete require.cache[require.resolve("../src/utils/learningInstances")];
  const db = new Database(dbPath);
  try {
    // Simulate a legacy/stale row from before the write-side scoping fix
    // existed: a Bootcamp enrolment that somehow still carries a
    // structured_* participation_structure value directly in the DB
    // (bypassing all application-level validation, exactly as old,
    // already-persisted data would).
    const learnerId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date) VALUES (?, 'learner', 'Legacy Bootcamp Learner', ?, 'hash', 'active', 'current', date('now'))"
    ).run(learnerId, `legacy-bc-${learnerId.slice(0, 6)}@test.com`);
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, is_primary, status, payment_status, joined_date, learning_instance_id, participation_structure)
       VALUES (?, ?, ?, 1, 'active', 'current', date('now'), ?, 'structured_other')`
    ).run(uuid(), learnerId, fx.programmeId, fx.runId);

    const { isStructuredJourneyEnrollment } = require("../src/utils/learningInstances");
    assert.equal(
      isStructuredJourneyEnrollment(learnerId, fx.runId),
      false,
      "A Bootcamp enrolment must never be treated as a structured Builders' Lab journey, regardless of what's stored on participation_structure"
    );
  } finally {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
