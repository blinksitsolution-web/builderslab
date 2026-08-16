/**
 * §21 Reporting — GET /api/learning-instances/dashboard-stats dimension
 * filters.
 *
 * Locks in the fix for the gap flagged in the reporting audit: this report
 * previously only supported filtering/aggregating by Learning Offering
 * Type, Programme, Course, and Programme Run — leaving six of the twelve
 * dimensions §21 names unsupported (Operational Group, Programme Level,
 * Participation Structure, Instructor, Campus, Delivery Mode, Academic
 * Period). This test seeds two Enrollments (and their Payments) under the
 * same Programme Run with deliberately different values for every one of
 * those six dimensions, plus a second Learning Instance with a different
 * Instructor, and checks that:
 *
 *   1. Sending none of the new filters returns byte-for-byte the same
 *      counts as before this fix (no regression for the existing UI).
 *   2. Each new filter, applied alone, narrows the Active Learners /
 *      Active Enrolments / Payments figures to only the matching
 *      Enrolment — including the Payments figure for BOTH an
 *      "additional programme" Payment (tagged with
 *      programme_enrollment_id) and a PRIMARY Payment (untagged,
 *      resolved via the same "user_id + is_primary=1" fallback the rest
 *      of the codebase already uses).
 *   3. instructorId filters at the Programme Run grain and correctly
 *      excludes a Run taught by a different instructor.
 *   4. Invalid participationStructure/deliveryMode values are rejected
 *      with 400, same validation contract as every other endpoint that
 *      accepts them.
 *
 * Same real-server-process pattern as dashboard-stats-reporting.test.js.
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
const JWT_SECRET = "dashboard-stats-dimensions-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-dashboard-dims-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "dashboard-stats-dimensions-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-dashboard-dims-uploads-"));
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

function adminCookie(adminId) {
  const token = jwt.sign({ sub: adminId, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

// Seeds a Programme Run carrying two Enrollments that differ on every §21
// dimension this fix adds, plus a second Run (different Instructor) with
// no Enrollments, so instructorId filtering has something real to exclude.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'dashboard-dims-admin@example.com', 'x', 'active', 'paid', 1, 'ADM-DIMS-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Dashboard Dims Programme', 70)").run(programmeId, offeringType.id);

    // Two Programme Levels ("classes").
    const foundationClassId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Dims Foundation', 1, ?)").run(foundationClassId, programmeId);
    const frameworkClassId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Dims Framework', 2, ?)").run(frameworkClassId, programmeId);

    // Two instructors, two Runs (only the first Run gets Enrollments).
    const instructorAId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, joined_date) VALUES (?, 'instructor', 'Instructor A', 'dashboard-dims-instructor-a@example.com', 'x', 'active', date('now'))"
    ).run(instructorAId);
    const instructorBId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, joined_date) VALUES (?, 'instructor', 'Instructor B', 'dashboard-dims-instructor-b@example.com', 'x', 'active', date('now'))"
    ).run(instructorBId);

    const runId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, name, status, instructor_id) VALUES (?, ?, ?, 'Dims Run A', 'active', ?)"
    ).run(runId, offeringType.id, programmeId, instructorAId);
    // 'upcoming', not 'active' — only one Active Run is allowed per
    // Programme at a time (see routes/learningInstances.js's
    // conflictResponse), and this fixture only needs a second Run to
    // exist and be visible in the report's consolidated (no scope param)
    // view, which includes every status.
    const otherRunId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, name, status, instructor_id) VALUES (?, ?, ?, 'Dims Run B (other instructor)', 'upcoming', ?)"
    ).run(otherRunId, offeringType.id, programmeId, instructorBId);

    // Operational Group + Campus + Academic Period, all scoped to runId.
    const operationalGroupId = uuid();
    db.prepare(
      "INSERT INTO operational_groups (id, learning_instance_id, name, sort_order) VALUES (?, ?, 'Dims Weekend Batch', 1)"
    ).run(operationalGroupId, runId);
    const campusId = uuid();
    db.prepare("INSERT INTO campuses (id, name, active) VALUES (?, 'Dims Test Campus', 1)").run(campusId);
    const academicPeriodId = uuid();
    db.prepare(
      "INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name) VALUES (?, ?, 1, 'Dims Semester 1')"
    ).run(academicPeriodId, runId);

    // Learner A: PRIMARY enrolment, Foundation level, individual_course,
    // no Operational Group, no Campus, ONLINE, no Academic Period — the
    // "everything unset" side of every filter. Its Payment is untagged
    // (programme_enrollment_id NULL), exactly like every real primary
    // enrolment's Payment.
    const learnerAId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, class_id) VALUES (?, 'learner', 'Dims Learner A', 'dashboard-dims-learner-a@example.com', 'x', 'active', 'current', 1, 'DIMS-A', date('now'), ?)"
    ).run(learnerAId, foundationClassId);
    const enrolmentAId = uuid();
    db.prepare(
      `INSERT INTO programme_enrollments
         (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id,
          participation_structure, delivery_mode, campus_id, academic_period_id, operational_group_id)
       VALUES (?, ?, ?, ?, 1, 'active', 'current', date('now'), ?, 'individual_course', 'ONLINE', NULL, NULL, NULL)`
    ).run(enrolmentAId, learnerAId, programmeId, foundationClassId, runId);
    db.prepare(
      "INSERT INTO payments (id, user_id, amount, currency, type, status, date, learning_instance_id) VALUES (?, ?, 500, 'GHS', 'registration', 'successful', datetime('now'), ?)"
    ).run(uuid(), learnerAId, runId);

    // Learner B: ADDITIONAL enrolment (is_primary = 0, mirroring
    // routes/enrolments.js's POST /), Framework level, structured_other,
    // assigned to the Operational Group/Campus/Academic Period above,
    // ON_CAMPUS. Its Payment IS tagged with programme_enrollment_id,
    // exactly like every real additional-programme Payment.
    const learnerBId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date) VALUES (?, 'learner', 'Dims Learner B', 'dashboard-dims-learner-b@example.com', 'x', 'active', 'current', 1, 'DIMS-B', date('now'))"
    ).run(learnerBId);
    const enrolmentBId = uuid();
    db.prepare(
      `INSERT INTO programme_enrollments
         (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id,
          participation_structure, delivery_mode, campus_id, academic_period_id, operational_group_id)
       VALUES (?, ?, ?, ?, 0, 'active', 'current', date('now'), ?, 'structured_other', 'ON_CAMPUS', ?, ?, ?)`
    ).run(enrolmentBId, learnerBId, programmeId, frameworkClassId, runId, campusId, academicPeriodId, operationalGroupId);
    db.prepare(
      "INSERT INTO payments (id, user_id, amount, currency, type, status, date, learning_instance_id, programme_enrollment_id) VALUES (?, ?, 700, 'GHS', 'registration', 'successful', datetime('now'), ?, ?)"
    ).run(uuid(), learnerBId, runId, enrolmentBId);

    return {
      adminId,
      runId,
      otherRunId,
      instructorAId,
      instructorBId,
      foundationClassId,
      frameworkClassId,
      operationalGroupId,
      campusId,
      academicPeriodId,
    };
  } finally {
    db.close();
  }
}

test("dashboard-stats §21 dimension filters: each new dimension narrows Active Learners/Enrolments/Payments to the matching Enrolment only", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { Cookie: adminCookie(fx.adminId) };

  async function statsFor(qs) {
    const res = await fetch(`${server.baseUrl}/api/learning-instances/dashboard-stats?${qs}`, { headers });
    assert.equal(res.status, 200, `unexpected status for ${qs}`);
    const body = await res.json();
    return body.instances.find((i) => i.id === fx.runId);
  }

  // ---- 1. No new filters: unchanged baseline (both Enrolments counted).
  const baseline = await statsFor(`learningInstanceId=${fx.runId}`);
  assert.equal(baseline.activeLearners, 2, "baseline: both learners counted with no dimension filters");
  assert.equal(baseline.activeEnrolments, 2, "baseline: both enrolments counted with no dimension filters");
  assert.equal(baseline.paymentsGHS, 1200, "baseline: both payments (500 + 700) summed with no dimension filters");

  // ---- 2. classId (Programme Level) narrows to Learner A only.
  const byFoundation = await statsFor(`learningInstanceId=${fx.runId}&classId=${fx.foundationClassId}`);
  assert.equal(byFoundation.activeLearners, 1);
  assert.equal(byFoundation.paymentsGHS, 500, "Foundation filter must reach Learner A's PRIMARY (untagged) payment via the is_primary fallback join");

  const byFramework = await statsFor(`learningInstanceId=${fx.runId}&classId=${fx.frameworkClassId}`);
  assert.equal(byFramework.activeLearners, 1);
  assert.equal(byFramework.paymentsGHS, 700, "Framework filter must reach Learner B's tagged additional-enrolment payment");

  // ---- 3. operationalGroupId narrows to Learner B only.
  const byGroup = await statsFor(`learningInstanceId=${fx.runId}&operationalGroupId=${fx.operationalGroupId}`);
  assert.equal(byGroup.activeLearners, 1);
  assert.equal(byGroup.paymentsGHS, 700);

  // ---- 4. participationStructure narrows correctly both ways.
  const byIndividual = await statsFor(`learningInstanceId=${fx.runId}&participationStructure=individual_course`);
  assert.equal(byIndividual.activeLearners, 1);
  assert.equal(byIndividual.paymentsGHS, 500);

  const byStructured = await statsFor(`learningInstanceId=${fx.runId}&participationStructure=structured_other`);
  assert.equal(byStructured.activeLearners, 1);
  assert.equal(byStructured.paymentsGHS, 700);

  // ---- 5. campusId narrows to Learner B only.
  const byCampus = await statsFor(`learningInstanceId=${fx.runId}&campusId=${fx.campusId}`);
  assert.equal(byCampus.activeLearners, 1);
  assert.equal(byCampus.paymentsGHS, 700);

  // ---- 6. deliveryMode narrows correctly both ways.
  const byOnline = await statsFor(`learningInstanceId=${fx.runId}&deliveryMode=ONLINE`);
  assert.equal(byOnline.activeLearners, 1);
  assert.equal(byOnline.paymentsGHS, 500);

  const byOnCampus = await statsFor(`learningInstanceId=${fx.runId}&deliveryMode=ON_CAMPUS`);
  assert.equal(byOnCampus.activeLearners, 1);
  assert.equal(byOnCampus.paymentsGHS, 700);

  // ---- 7. academicPeriodId narrows to Learner B only.
  const byPeriod = await statsFor(`learningInstanceId=${fx.runId}&academicPeriodId=${fx.academicPeriodId}`);
  assert.equal(byPeriod.activeLearners, 1);
  assert.equal(byPeriod.paymentsGHS, 700);

  // ---- 8. Combining two dimensions is a logical AND (Learner B matches
  // both; Learner A matches neither).
  const combined = await statsFor(`learningInstanceId=${fx.runId}&operationalGroupId=${fx.operationalGroupId}&deliveryMode=ON_CAMPUS`);
  assert.equal(combined.activeLearners, 1);
  const combinedMismatch = await statsFor(`learningInstanceId=${fx.runId}&operationalGroupId=${fx.operationalGroupId}&deliveryMode=ONLINE`);
  assert.equal(combinedMismatch.activeLearners, 0, "Learner B's Operational Group doesn't pair with ONLINE, so this AND should match nobody");

  // ---- 9. instructorId filters at the Programme Run grain.
  const listRes = await fetch(`${server.baseUrl}/api/learning-instances/dashboard-stats?instructorId=${fx.instructorAId}`, { headers });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.ok(listBody.instances.some((i) => i.id === fx.runId), "Run A must appear when filtered by its own instructor");
  assert.ok(!listBody.instances.some((i) => i.id === fx.otherRunId), "Run B (different instructor) must not appear");

  const otherInstructorRes = await fetch(`${server.baseUrl}/api/learning-instances/dashboard-stats?instructorId=${fx.instructorBId}`, { headers });
  const otherInstructorBody = await otherInstructorRes.json();
  assert.ok(!otherInstructorBody.instances.some((i) => i.id === fx.runId), "Run A must not appear when filtered by a different instructor");

  // ---- 10. Validation: invalid enum values are rejected, matching the
  // rest of the codebase's validation contract for these same fields.
  const badParticipation = await fetch(`${server.baseUrl}/api/learning-instances/dashboard-stats?participationStructure=not_a_real_structure`, { headers });
  assert.equal(badParticipation.status, 400);

  const badDeliveryMode = await fetch(`${server.baseUrl}/api/learning-instances/dashboard-stats?deliveryMode=NOT_A_REAL_MODE`, { headers });
  assert.equal(badDeliveryMode.status, 400);
});
