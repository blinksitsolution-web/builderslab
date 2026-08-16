/**
 * Bootcamp Course Library & Learning Instance assignment integration tests.
 *
 * Verifies:
 * 1. Reusable Course records can be assigned to specific Learning Instances
 * 2. Same Course can be assigned to multiple instances without duplication
 * 3. Each instance maintains independent course selection (isolation)
 * 4. Learner access follows Run-scoped assignments (resolveRunConfiguredCourseCurriculum)
 * 5. One-day bootcamp dates (endDate === startDate) are accepted
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
const JWT_SECRET = "bootcamp-course-library-test-secret";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-course-lib-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "bootcamp-course-lib-test-ai-key",
    DB_PATH: dbPath,
  };
  delete env.NODE_ENV;
  delete env.PAYSTACK_SECRET_KEY;
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-course-lib-uploads-"));
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

function seedBootcampFixtures(dbPath) {
  const db = new Database(dbPath);
  const adminId = uuid();
  const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
  db.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, role_template_id)
     VALUES (?, 'admin', 'Course Lib Admin', 'course-lib-admin@test.local', 'hash', 'active', 'paid', date('now'), ?)`
  ).run(adminId, superAdminTemplate?.id || null);

  const bootcampType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'bootcamp'").get();
  assert.ok(bootcampType, "bootcamp offering type must exist");

  const programmeId = uuid();
  db.prepare(
    `INSERT INTO programmes (id, offering_type_id, name, is_active, sort_order)
     VALUES (?, ?, 'AI Essentials Bootcamp', 1, 0)`
  ).run(programmeId, bootcampType.id);

  const courseA = "ai-essentials";
  const courseB = "python-basics";
  const courseC = "robotics";
  db.prepare(
    `INSERT INTO courses (id, title, is_open) VALUES (?, 'AI Essentials', 1),
     (?, 'Python Basics', 1), (?, 'Robotics', 1)`
  ).run(courseA, courseB, courseC);

  const instanceA = uuid();
  const instanceB = uuid();
  db.prepare(
    `INSERT INTO learning_instances (id, offering_type_id, programme_id, name, start_date, end_date, status)
     VALUES (?, ?, ?, 'August 2026', '2026-08-01', '2026-08-31', 'active')`
  ).run(instanceA, bootcampType.id, programmeId);
  db.prepare(
    `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
     VALUES (?, ?, 'programme', ?, 1, 'active')`
  ).run(uuid(), instanceA, programmeId);

  db.prepare(
    `INSERT INTO learning_instances (id, offering_type_id, programme_id, name, start_date, end_date, status)
     VALUES (?, ?, ?, 'September 2026', '2026-09-01', '2026-09-30', 'active')`
  ).run(instanceB, bootcampType.id, programmeId);
  db.prepare(
    `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
     VALUES (?, ?, 'programme', ?, 1, 'active')`
  ).run(uuid(), instanceB, programmeId);

  const oneDayInstance = uuid();
  db.prepare(
    `INSERT INTO learning_instances (id, offering_type_id, programme_id, name, start_date, end_date, status)
     VALUES (?, ?, ?, 'One Day Bootcamp', '2026-08-20', '2026-08-20', 'upcoming')`
  ).run(oneDayInstance, bootcampType.id, programmeId);
  db.prepare(
    `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
     VALUES (?, ?, 'programme', ?, 1, 'upcoming')`
  ).run(uuid(), oneDayInstance, programmeId);

  const learnerA = uuid();
  const learnerB = uuid();
  db.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, is_adult)
     VALUES (?, 'learner', 'Learner A', 'learner-a@test.local', 'hash', 'active', 'paid', date('now'), 1),
            (?, 'learner', 'Learner B', 'learner-b@test.local', 'hash', 'active', 'paid', date('now'), 1)`
  ).run(learnerA, learnerB);

  const classId = uuid();
  db.prepare(
    `INSERT INTO classes (id, programme_id, name) VALUES (?, ?, 'Cohort A')`
  ).run(classId, programmeId);

  const enrollA = uuid();
  const enrollB = uuid();
  db.prepare(
    `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, learning_instance_id, is_primary, participation_structure)
     VALUES (?, ?, ?, ?, ?, 1, NULL)`
  ).run(enrollA, learnerA, programmeId, classId, instanceA);
  db.prepare(
    `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, learning_instance_id, is_primary, participation_structure)
     VALUES (?, ?, ?, ?, ?, 1, NULL)`
  ).run(enrollB, learnerB, programmeId, classId, instanceB);

  db.close();

  const token = jwt.sign({ sub: adminId, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  return {
    token,
    programmeId,
    instanceA,
    instanceB,
    oneDayInstance,
    courseA,
    courseB,
    courseC,
    learnerA,
    learnerB,
  };
}

test("bootcamp course library: assign, reuse, isolate, and learner access", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fixtures = seedBootcampFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  const ready = await waitForReady(server.baseUrl, 15000);
  assert.ok(ready, `server failed to start: ${server.getStderr()}`);

  const auth = { Cookie: `dtl_token=${fixtures.token}` };

  // Assign courses to Instance A: AI Essentials + Python Basics
  let res = await fetch(`${server.baseUrl}/api/learning-instances/${fixtures.instanceA}/activated-courses`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ courseId: fixtures.courseA }),
  });
  assert.equal(res.status, 201);
  let instance = await res.json();
  assert.equal(instance.activatedCourses.filter((c) => c.status === "active").length, 1);

  res = await fetch(`${server.baseUrl}/api/learning-instances/${fixtures.instanceA}/activated-courses`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ courseId: fixtures.courseB }),
  });
  assert.equal(res.status, 201);
  instance = await res.json();
  assert.equal(instance.activatedCourses.filter((c) => c.status === "active").length, 2);

  // Reuse same Course on Instance B with different set (AI + Robotics)
  res = await fetch(`${server.baseUrl}/api/learning-instances/${fixtures.instanceB}/activated-courses`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ courseId: fixtures.courseA }),
  });
  assert.equal(res.status, 201);

  res = await fetch(`${server.baseUrl}/api/learning-instances/${fixtures.instanceB}/activated-courses`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ courseId: fixtures.courseC }),
  });
  assert.equal(res.status, 201);
  instance = await res.json();
  const activeB = instance.activatedCourses.filter((c) => c.status === "active").map((c) => c.courseId);
  assert.deepEqual(new Set(activeB), new Set([fixtures.courseA, fixtures.courseC]));

  // Only one AI Essentials course record exists globally
  const dbCheck = new Database(dbPath);
  const courseCount = dbCheck.prepare("SELECT COUNT(*) as n FROM courses WHERE id = ?").get(fixtures.courseA).n;
  assert.equal(courseCount, 1);
  dbCheck.close();

  // getEligibleCoursesForRun isolation + learner curriculum via utils
  process.env.DB_PATH = dbPath;
  const { getEligibleCoursesForRun, activateEnrollmentCurriculum } = require("../src/utils/learningInstances");
  const eligibleA = new Set(getEligibleCoursesForRun(fixtures.instanceA, fixtures.programmeId));
  const eligibleB = new Set(getEligibleCoursesForRun(fixtures.instanceB, fixtures.programmeId));
  assert.ok(eligibleA.has(fixtures.courseA));
  assert.ok(eligibleA.has(fixtures.courseB));
  assert.ok(!eligibleA.has(fixtures.courseC));
  assert.ok(eligibleB.has(fixtures.courseA));
  assert.ok(eligibleB.has(fixtures.courseC));
  assert.ok(!eligibleB.has(fixtures.courseB));

  // Learner curriculum follows instance assignments after activation
  const db = new Database(dbPath);
  const classRow = db.prepare("SELECT id FROM classes WHERE programme_id = ? LIMIT 1").get(fixtures.programmeId);
  activateEnrollmentCurriculum(fixtures.learnerA, classRow.id, [], fixtures.instanceA);
  activateEnrollmentCurriculum(fixtures.learnerB, classRow.id, [], fixtures.instanceB);

  const enrollmentsA = db
    .prepare("SELECT course_id FROM enrollments WHERE user_id = ?")
    .all(fixtures.learnerA)
    .map((r) => r.course_id);
  const enrollmentsB = db
    .prepare("SELECT course_id FROM enrollments WHERE user_id = ?")
    .all(fixtures.learnerB)
    .map((r) => r.course_id);

  assert.ok(enrollmentsA.includes(fixtures.courseA));
  assert.ok(enrollmentsA.includes(fixtures.courseB));
  assert.ok(!enrollmentsA.includes(fixtures.courseC));
  assert.ok(enrollmentsB.includes(fixtures.courseA));
  assert.ok(enrollmentsB.includes(fixtures.courseC));
  assert.ok(!enrollmentsB.includes(fixtures.courseB));

  db.close();

  // One-day bootcamp: endDate === startDate accepted on create
  const bootcampTypeId = new Database(dbPath).prepare("SELECT id FROM learning_offering_types WHERE slug = 'bootcamp'").get().id;
  new Database(dbPath).close();

  res = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      offeringTypeId: bootcampTypeId,
      programmeId: fixtures.programmeId,
      name: "Same Day Run",
      startDate: "2026-08-20",
      endDate: "2026-08-20",
      status: "upcoming",
    }),
  });
  const oneDayBody = await res.text();
  assert.equal(res.status, 200, oneDayBody);
  const oneDay = JSON.parse(oneDayBody);
  assert.equal(oneDay.startDate, "2026-08-20");
  assert.equal(oneDay.endDate, "2026-08-20");

  // Programme definition counts global courses for bootcamp
  res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fixtures.programmeId}`, { headers: auth });
  assert.equal(res.status, 200);
  const programme = await res.json();
  const courseLibStep = programme.programmeDefinitionStatus.steps.find((s) => s.id === "courseLibrary");
  assert.equal(courseLibStep.complete, true);

  await server.stop();
  fs.rmSync(dbDir, { recursive: true, force: true });
});
