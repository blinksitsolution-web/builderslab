/**
 * Regression test — Bootcamp content wrongly gated by an unrelated Kids
 * STEM/structured Learning Instance's academic-period payment requirement.
 *
 * Root cause (utils/periodPayments.js's resolveInstanceForPeriodAccess):
 * Bootcamp Learning Instances never have an academicStructure configured
 * (Bootcamp has no term/semester concept — its model is Learning Instance
 * -> Operational Group -> Registration Fee only). The per-learner
 * enrollment-instance loop used to `continue` past a matching enrollment
 * instance the moment it saw `!instance.academicStructure`, treating "found
 * the learner's own Learning Instance but it has no periods" the same as
 * "this row doesn't match at all" — which let it fall through to the
 * GLOBAL, offering-type-blind fallback (getActiveInstanceIdForCourse). That
 * fallback picks the most-recently-activated Active Learning Instance
 * targeting the same courseId with no regard for the learner's own
 * enrollment or offering type — so a fully-paid Bootcamp learner whose
 * course is *also* targeted by an unrelated, more-recently-created Kids
 * STEM structured run got their content request evaluated against THAT
 * run's academic-period payment requirement instead, and was blocked with
 * 402 PERIOD_PAYMENT_REQUIRED despite having nothing to do with that run.
 *
 * This locks in: a Bootcamp learner, fully paid on their own Bootcamp
 * enrollment (no academic structure to satisfy), can access their course's
 * lessons even when the same course is also targeted by an unrelated Kids
 * STEM Learning Instance with an unsatisfied period-payment requirement —
 * and that the Kids STEM enforcement itself is completely unaffected for a
 * learner who actually belongs to it.
 *
 * Same real-server-process pattern as period-payment-enforcement.test.js /
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
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");
const JWT_SECRET = "bootcamp-cross-li-period-payment-test-secret-not-for-real-use";

// IOT-02 is seeded with is_open = 0, so it never gets an auto-created
// Learning Instance from the v24 registration-catalogue backfill — this
// test needs full manual control over both Learning Instances that target
// it (Bootcamp's own run, and the unrelated Kids STEM structured run).
const SHARED_COURSE_ID = "IOT-02";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-bootcamp-cross-li-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "bootcamp-cross-li-period-payment-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  delete env.NODE_ENV;
  delete env.PAYSTACK_SECRET_KEY;
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-bootcamp-cross-li-uploads-"));
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

// Bootcamp side: a Programme Run using the same "Learning Instance ->
// Operational Group -> Registration Fee" model as bootcamp-lifecycle.test.js
// — deliberately created FIRST (older created_at) so the global
// most-recently-activated fallback would prefer the Kids STEM run below if
// the bug were still present. Activates SHARED_COURSE_ID onto the run via
// learning_instance_courses (the Bootcamp run-scoped-curriculum path) and
// fully enrolls + pays a learner into it — no academic structure is ever
// configured on this run, matching real Bootcamp runs.
function seedBootcampFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const bootcampOT = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'bootcamp'").get();
    if (!bootcampOT) throw new Error("Bootcamp offering type not found — has migration seeded it?");

    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'IoT Bootcamp', 0)").run(programmeId, bootcampOT.id);

    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Cohort Class', 0, ?)").run(classId, programmeId);

    const runId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name, registration_fee_ghs) VALUES (?, ?, ?, 'active', 'IoT Bootcamp Run', 350)"
    ).run(runId, bootcampOT.id, programmeId);

    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), runId, programmeId);

    // Bootcamp's run-scoped-curriculum activation — the SAME course this
    // test's unrelated Kids STEM run below also targets.
    db.prepare("INSERT INTO learning_instance_courses (id, learning_instance_id, course_id) VALUES (?, ?, ?)").run(uuid(), runId, SHARED_COURSE_ID);

    // A fully-paid Bootcamp learner, correctly enrolled into the Bootcamp
    // run above (both the legacy `enrollments` ownership row the lessons
    // route requires, and the authoritative programme_enrollments row
    // resolveInstanceForPeriodAccess reads).
    const learnerId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, class_id, student_code)
       VALUES (?, 'learner', 'Bootcamp Learner', ?, ?, 'active', 'current', date('now'), ?, ?)`
    ).run(learnerId, `bc-learner-${learnerId.slice(0, 8)}@example.test`, bcrypt.hashSync("learnerpass123", 12), classId, `BC-${learnerId.slice(0, 8)}`);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(learnerId, SHARED_COURSE_ID);
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id)
       VALUES (?, ?, ?, ?, 1, 'active', 'current', date('now'), ?)`
    ).run(uuid(), learnerId, programmeId, classId, runId);

    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', ?, 'x', 'active', 'current', 1, ?, date('now'), ?)"
    ).run(adminId, `cross-li-admin-${adminId.slice(0, 8)}@example.test`, `ADM-CLI-${adminId.slice(0, 8)}`, superAdminTemplate ? superAdminTemplate.id : null);

    const kidsStemOT = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    return { runId, learnerId, adminId, kidsStemOfferingTypeId: kidsStemOT.id };
  } finally {
    db.close();
  }
}

// Unrelated Kids STEM side: an active, structured (semester) run created
// AFTER the Bootcamp run above, targeting the SAME SHARED_COURSE_ID, with
// period 1 given an unsatisfied deposit requirement. The Bootcamp learner
// has no relationship to this run at all.
async function createUnrelatedKidsStemStructuredRun(baseUrl, headers) {
  const createRes = await fetch(`${baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: headers.__offeringTypeId, courseId: SHARED_COURSE_ID, name: "Unrelated Kids STEM Run", status: "upcoming" }),
  });
  const created = await readJson(createRes);
  assert.equal(createRes.status, 200, JSON.stringify(created));

  const structRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await readJson(structRes);
  assert.equal(structRes.status, 200, JSON.stringify(withStructure));
  const [period1] = withStructure.academicPeriods;
  const primaryTargetId = withStructure.targets[0].id;

  const targetsRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/targets`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ targetIds: [primaryTargetId] }),
  });
  assert.equal(targetsRes.status, 200);

  const reqRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/payment-requirement`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ mode: "deposit", requiredAmountGHS: 50 }),
  });
  assert.equal(reqRes.status, 200);

  const activateRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/activate`, { method: "POST", headers });
  const activateBody = await readJson(activateRes);
  assert.equal(activateRes.status, 200, JSON.stringify(activateBody));

  return { instanceId: created.id, period1Id: period1.id };
}

test("Bootcamp learner is not blocked by an unrelated Kids STEM Learning Instance's period payment requirement on the same shared course", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());

  const fx = seedBootcampFixtures(dbPath);

  // Create the unrelated, more-recently-created, unpaid Kids STEM run
  // targeting the exact same course AFTER the Bootcamp run above, so the
  // old buggy global fallback (most-recently-activated wins) would have
  // picked this one over the Bootcamp learner's own run.
  const adminHeaders = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.kidsStemOfferingTypeId };
  await createUnrelatedKidsStemStructuredRun(server.baseUrl, adminHeaders);

  // The fully-paid Bootcamp learner must be able to reach their own
  // course's lessons — never gated by the unrelated Kids STEM run's
  // unsatisfied period-payment requirement.
  const res = await fetch(`${server.baseUrl}/api/modules/${SHARED_COURSE_ID}/lessons`, {
    headers: { Cookie: cookieFor(fx.learnerId, "learner") },
  });
  const body = await readJson(res);
  assert.equal(res.status, 200, `Bootcamp learner was wrongly blocked: ${JSON.stringify(body)}`);
});

test("the unrelated Kids STEM Learning Instance's own period-payment enforcement is unaffected — a learner actually enrolled in IT is still blocked", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());

  const fx = seedBootcampFixtures(dbPath);
  const adminHeaders = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.kidsStemOfferingTypeId };
  const { instanceId, period1Id } = await createUnrelatedKidsStemStructuredRun(server.baseUrl, adminHeaders);

  // A separate learner who is genuinely enrolled into the Kids STEM run
  // (not the Bootcamp run) via programme_enrollments, and hasn't paid.
  const db = new Database(dbPath);
  const kidsStemLearnerId = uuid();
  db.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, student_code)
     VALUES (?, 'learner', 'Kids STEM Learner', ?, ?, 'active', 'current', date('now'), ?)`
  ).run(kidsStemLearnerId, `ks-learner-${kidsStemLearnerId.slice(0, 8)}@example.test`, bcrypt.hashSync("learnerpass123", 12), `KS-${kidsStemLearnerId.slice(0, 8)}`);
  db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(kidsStemLearnerId, SHARED_COURSE_ID);
  db.prepare(
    `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id)
     SELECT ?, ?, m.programme_id, NULL, 1, 'active', 'current', date('now'), li.id
     FROM learning_instances li JOIN courses m ON m.id = li.course_id WHERE li.id = ?`
  ).run(uuid(), kidsStemLearnerId, instanceId);
  db.close();

  const res = await fetch(`${server.baseUrl}/api/modules/${SHARED_COURSE_ID}/lessons`, {
    headers: { Cookie: cookieFor(kidsStemLearnerId, "learner") },
  });
  const body = await readJson(res);
  assert.equal(res.status, 402, JSON.stringify(body));
  assert.equal(body.code, "PERIOD_PAYMENT_REQUIRED");
  assert.equal(body.period.id, period1Id);
});
