/**
 * Phase 8 — registration/enrolment must use period-specific targets.
 *
 * Locks in that a Module/Programme belonging to an active Learning
 * Instance generally, but NOT configured as one of the CURRENT academic
 * period's active targets, is not presented/accepted as a registration or
 * enrolment option — in the three places this task named:
 *   - GET /api/modules/open (the registration catalogue)
 *   - POST /api/auth/register (Kids STEM module selection, final validation)
 *   - POST /api/enrolments/ (an existing account self-enrolling into an
 *     additional Programme)
 *
 * A Learning Instance with no academic structure configured, or a period
 * with no targets configured yet, is never additionally restricted by this
 * — same back-compat rule as Phase 6's enforcement (module-access
 * -enrollment.test.js / period-payment-enforcement.test.js already cover
 * that side; this file only covers the NEW period-target-mismatch case).
 *
 * Same real-server-process pattern as period-payment-enforcement.test.js.
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
const JWT_SECRET = "period-target-registration-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-period-target-reg-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = { ...process.env, JWT_SECRET, AI_CREDENTIALS_KEY: "period-target-reg-test-ai-key-not-for-real-use", DB_PATH: dbPath, NODE_ENV: "production" };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-period-target-reg-uploads-"));
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

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// IOT-02 ships is_open = 0 (see migrate.js), so it never gets an
// auto-created Active Learning Instance from the v24 registration-
// catalogue backfill — flipping is_open on afterward (below) gives this
// test full manual control over building a structured run without
// conflicting with any auto-backfilled instance.
const TEST_MODULE_ID = "IOT-02";

function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE courses SET is_open = 1 WHERE id = ?").run(TEST_MODULE_ID);

    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'period-target-reg-admin@example.com', 'x', 'active', 'current', 1, 'ADM-PTR-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    return { adminId, offeringTypeId: offeringType.id };
  } finally {
    db.close();
  }
}

async function readJsonRes(res, expectedStatus, headers) {
  const body = await readJson(res);
  assert.equal(res.status, expectedStatus, JSON.stringify(body));
  return body;
}

// Creates an 'upcoming' Module Learning Instance for TEST_MODULE_ID, sets a
// 'semester' structure, assigns a SECONDARY module (GFX-06, also is_open=0
// by default so it never conflicts) to period 1 while deliberately leaving
// TEST_MODULE_ID's own primary target off period 1's list, then activates
// the run — so TEST_MODULE_ID is a real target of the run generally, but
// not of the period currently underway.
async function createRunWithModuleExcludedFromCurrentPeriod(baseUrl, headers) {
  const createRes = await fetch(`${baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: headers.__offeringTypeId, courseId: TEST_MODULE_ID, name: "Period Target Registration Test Run", status: "upcoming" }),
  });
  const created = await readJsonRes(createRes, 200);

  const structRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await readJsonRes(structRes, 200);
  const [period1] = withStructure.academicPeriods;

  const addTargetRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/targets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ courseId: "GFX-06" }),
  });
  const withSecondTarget = await readJsonRes(addTargetRes, 201);
  const secondaryTarget = withSecondTarget.targets.find((t) => t.courseId === "GFX-06");

  const targetsRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/targets`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ targetIds: [secondaryTarget.id] }),
  });
  await readJsonRes(targetsRes, 200);

  const activateRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/activate`, { method: "POST", headers });
  await readJsonRes(activateRes, 200);

  return { instanceId: created.id };
}

test("period-target registration: GET /api/modules/open excludes a Module not in the current period's configured targets", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  await createRunWithModuleExcludedFromCurrentPeriod(server.baseUrl, headers);

  const openRes = await fetch(`${server.baseUrl}/api/modules/open`);
  const openBody = await readJsonRes(openRes, 200);
  const ids = openBody.courses.map((m) => m.id);
  assert.ok(!ids.includes(TEST_MODULE_ID), `expected ${TEST_MODULE_ID} to be excluded, got: ${ids.join(", ")}`);
});

test("period-target registration: POST /api/auth/register rejects a Module not in the current period's configured targets", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  await createRunWithModuleExcludedFromCurrentPeriod(server.baseUrl, headers);

  const registerRes = await fetch(`${server.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "parent-learner",
      parent: { name: "Test Parent", email: `parent-${uuid()}@example.test`, password: "parentpass123" },
      learner: { name: "Test Child", dateOfBirth: "2015-01-01" },
      courseIds: [TEST_MODULE_ID],
    }),
  });
  const registerBody = await readJson(registerRes);
  assert.equal(registerRes.status, 400, JSON.stringify(registerBody));
  assert.match(registerBody.error, /open for enrolment right now/i);
});

test("period-target registration: POST /api/enrolments/ rejects a Programme not in the current period's configured targets", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());

  const db = new Database(dbPath);
  const adminId = uuid();
  const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
  db.prepare(
    "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'period-target-reg-admin2@example.com', 'x', 'active', 'current', 1, 'ADM-PTR-0002', date('now'), ?)"
  ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

  // A fresh Offering Type + Programme (self-registration allowed, both
  // audiences) so this test controls the whole Programme setup rather
  // than depending on any pre-seeded one's exact settings.
  const offeringTypeId = uuid();
  db.prepare(
    "INSERT INTO learning_offering_types (id, name, slug, icon, color, is_active, sort_order, settings) VALUES (?, 'Period Target Test Offering', 'period-target-test-offering', '🎯', '#000000', 1, 99, ?)"
  ).run(offeringTypeId, JSON.stringify({ enrollment: { selfRegistrationAllowed: true, parentAccountRequired: "optional" } }));
  const programmeId = uuid();
  db.prepare(
    "INSERT INTO programmes (id, offering_type_id, name, is_active) VALUES (?, ?, 'Period Target Test Programme', 1)"
  ).run(programmeId, offeringTypeId);
  const classId = uuid();
  db.prepare("INSERT INTO classes (id, programme_id, name) VALUES (?, ?, 'Cohort A')").run(classId, programmeId);

  const learnerId = uuid();
  db.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, joined_date, student_code)
     VALUES (?, 'learner', 'Test Learner', ?, ?, 'active', 'current', 1, date('now'), ?)`
  ).run(learnerId, `learner-${learnerId}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${learnerId.slice(0, 8)}`);
  db.close();

  const headers = { "Content-Type": "application/json", Cookie: cookieFor(adminId, "admin"), __offeringTypeId: offeringTypeId };

  // Build a structured, active run for this Programme with a secondary
  // Programme covering period 1 instead, same pattern as
  // createRunWithModuleExcludedFromCurrentPeriod but for a Programme target.
  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId, programmeId, name: "Period Target Programme Run", status: "upcoming" }),
  });
  const created = await readJsonRes(createRes, 200);
  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await readJsonRes(structRes, 200);
  const [period1] = withStructure.academicPeriods;

  const secondProgrammeId = uuid();
  const db2 = new Database(dbPath);
  db2.prepare("INSERT INTO programmes (id, offering_type_id, name, is_active) VALUES (?, ?, 'Other Programme', 1)").run(secondProgrammeId, offeringTypeId);
  db2.close();
  const addTargetRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/targets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ programmeId: secondProgrammeId }),
  });
  const withSecondTarget = await readJsonRes(addTargetRes, 201);
  const secondaryTarget = withSecondTarget.targets.find((t) => t.programmeId === secondProgrammeId);

  const targetsRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/targets`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ targetIds: [secondaryTarget.id] }),
  });
  await readJsonRes(targetsRes, 200);

  const activateRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/activate`, { method: "POST", headers });
  await readJsonRes(activateRes, 200);

  const enrolRes = await fetch(`${server.baseUrl}/api/enrolments/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieFor(learnerId, "learner") },
    body: JSON.stringify({ targetUserId: learnerId, programmeId, classId }),
  });
  const enrolBody = await readJson(enrolRes);
  assert.equal(enrolRes.status, 400, JSON.stringify(enrolBody));
  assert.match(enrolBody.error, /current academic period/i);
});
