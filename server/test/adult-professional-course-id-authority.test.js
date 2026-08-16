/**
 * Adult Professional — Course ID Authority.
 *
 * Adult Professional registration (routes/auth.js, kind: "adult") never
 * REQUIRES courseIds (Adult Professional organizes by Programme + Batch/
 * Cohort, not module selection). But a client submitting courseIds anyway
 * was previously stored on programme_enrollments.requested_course_ids
 * completely unvalidated, and later granted as real course access at
 * activation via resolveRunConfiguredCourseCurriculum (utils/
 * learningInstances.js), which reads straight off requested_course_ids /
 * programme_enrollment_courses.
 *
 * That meant an attacker could submit an arbitrary courseId for a
 * completely unrelated (and potentially paid) course/programme and, once
 * their own registration activated, be silently enrolled in it — with no
 * server-side check that the course was actually configured for the Adult
 * Professional Programme Run being registered into.
 *
 * This locks in the fix: courseIds submitted on an Adult Professional
 * registration are validated against getEligibleCoursesForRun (the same
 * function already used by the admin PATCH /users/:id/courses endpoint),
 * exactly the way admin-assigned courses already were.
 *
 * Same real-server-process pattern as delivery-mode-registration.test.js.
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
const JWT_SECRET = "adult-course-id-authority-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-adult-course-authority-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "adult-course-id-authority-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-adult-course-authority-uploads-"));
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

// Seeds:
//  - an Adult Professional Programme with one Batch/Cohort and an ACTIVE
//    Programme Run
//  - the ONE course actually configured/eligible for that Run
//    (learning_instance_courses)
//  - an UNRELATED course under a totally different programme, not
//    configured for this Run at all — this is the "arbitrary course ID"
//    an attacker would try to inject
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();

    const programmeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Course Authority Test Programme', 0)"
    ).run(programmeId, offeringType.id);
    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Batch A', 0, ?)").run(classId, programmeId);

    const runId = uuid();
    db.prepare("INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)").run(
      runId,
      offeringType.id,
      programmeId
    );
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), runId, programmeId);

    const eligibleCourseId = uuid();
    db.prepare("INSERT INTO courses (id, title, is_open, programme_id) VALUES (?, 'Advanced Digital Marketing', 1, ?)").run(
      eligibleCourseId,
      programmeId
    );
    db.prepare(
      "INSERT INTO learning_instance_courses (id, learning_instance_id, course_id, status) VALUES (?, ?, ?, 'active')"
    ).run(uuid(), runId, eligibleCourseId);

    // Unrelated programme + course, never configured on this Run.
    const otherProgrammeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Unrelated Programme', 1)"
    ).run(otherProgrammeId, offeringType.id);
    const unrelatedCourseId = uuid();
    db.prepare("INSERT INTO courses (id, title, is_open, programme_id) VALUES (?, 'Unrelated Paid Course', 1, ?)").run(
      unrelatedCourseId,
      otherProgrammeId
    );

    return { programmeId, classId, runId, eligibleCourseId, unrelatedCourseId };
  } finally {
    db.close();
  }
}

function adultPayload({ classId, courseIds }) {
  return {
    kind: "adult",
    classId,
    courseIds,
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

test("adult-professional course-id-authority: an unrelated/arbitrary courseId is rejected, no account created", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.classId, courseIds: [fx.unrelatedCourseId] })),
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(Array.isArray(body.invalidCourseIds) && body.invalidCourseIds.includes(fx.unrelatedCourseId));

    const db = new Database(dbPath, { readonly: true });
    const user = db.prepare("SELECT * FROM users WHERE email LIKE 'learner-%'").get();
    db.close();
    assert.equal(user, undefined, "no account should have been created for a rejected registration");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("adult-professional course-id-authority: the Run's own configured course is still accepted", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.classId, courseIds: [fx.eligibleCourseId] })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const enrollment = readEnrollment(dbPath, body.learnerId);
    assert.ok(enrollment, "enrollment should exist");
    assert.ok(JSON.parse(enrollment.requested_course_ids || "[]").includes(fx.eligibleCourseId));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("adult-professional course-id-authority: registering with no courseIds at all still works (the normal case)", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.classId, courseIds: undefined })),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
