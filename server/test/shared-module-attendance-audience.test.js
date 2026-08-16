/**
 * Stage 3 follow-up — attendance roster audience narrowing.
 *
 * GET /api/users?courseId=X (the roster instructors take attendance
 * against — see client/src/pages/instructor/useInstructorAttendance.js)
 * previously always returned every learner enrolled in a module with no
 * way to separate a Child class from an Adult batch sharing that module.
 * This adds an opt-in ?audience=child|adult narrowing (mirroring the
 * broadcast-learners audience param from shared-module-broadcast-targeting
 * .test.js), and the matching narrowing on GET /api/attendance/:courseId's
 * prefill lookup.
 *
 * Same real-server-process pattern as shared-module-broadcast-targeting.test.js.
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
const JWT_SECRET = "shared-module-attendance-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-shared-attendance-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "shared-module-attendance-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-shared-attendance-uploads-"));
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

// Same shape as shared-module-broadcast-targeting.test.js: one Module
// under a Programme, one Child (via class_id) and one Adult (via direct
// module enrollment) sharing it, and an instructor assigned to both the
// module and the child's class (a realistic "teaches both audiences" setup).
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Shared Module Attendance Test', 0)").run(
      programmeId,
      offeringType.id
    );

    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Shared Module Child Batch', 0, ?)").run(classId, programmeId);

    const courseId = uuid();
    db.prepare("INSERT INTO courses (id, title, is_open, programme_id) VALUES (?, 'Robotics Fundamentals', 1, ?)").run(courseId, programmeId);

    const mkUser = (role, extra = {}) => {
      const id = uuid();
      db.prepare(
        "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, class_id, is_adult) VALUES (?, ?, ?, ?, 'x', 'active', 'current', date('now'), ?, ?)"
      ).run(id, role, extra.name || `Test ${role}`, `${role}-${id}@example.test`, extra.classId || null, extra.isAdult ? 1 : 0);
      return id;
    };

    const childId = mkUser("learner", { name: "Child Learner", classId });
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(childId, courseId);

    const adultId = mkUser("learner", { name: "Adult Learner", isAdult: true });
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(adultId, courseId);

    // Instructor Assignment (ABRS v2.2 §2.1/§8.2/§9/§13): access is granted
    // through a Programme Run row in `instructor_assignments`, not the
    // legacy per-course/per-class tables those were consolidated onto (see
    // migrate.js's "Instructor Assignment consolidated onto
    // instructor_assignments" step and utils/instructorScope.js). A single
    // wildcard row (course_id/class_id both NULL) on an Active Run for this
    // Programme grants the instructor every Course and Programme Level
    // under that Run — exactly equivalent to what the old two-row
    // instructor_courses + instructor_classes grant used to mean.
    const instanceId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status) VALUES (?, ?, ?, 'active')"
    ).run(instanceId, offeringType.id, programmeId);

    const instructorId = mkUser("instructor", { name: "Assigned Instructor" });
    db.prepare(
      "INSERT INTO instructor_assignments (id, instructor_id, learning_instance_id, course_id, class_id) VALUES (?, ?, ?, NULL, NULL)"
    ).run(uuid(), instructorId, instanceId);

    // A prior attendance session already marked for both, so the
    // ?audience= narrowing on the prefill lookup has something to filter.
    db.prepare(
      "INSERT INTO attendance (id, course_id, instructor_id, learner_id, date, status) VALUES (?, ?, ?, ?, '2026-01-05', 'present')"
    ).run(uuid(), courseId, instructorId, childId);
    db.prepare(
      "INSERT INTO attendance (id, course_id, instructor_id, learner_id, date, status) VALUES (?, ?, ?, ?, '2026-01-05', 'absent')"
    ).run(uuid(), courseId, instructorId, adultId);

    return { courseId, childId, adultId, instructorId };
  } finally {
    db.close();
  }
}

test("shared-module-attendance: ?audience=child on the roster returns only the child learner", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const res = await fetch(`${server.baseUrl}/api/users?role=learner&courseId=${fx.courseId}&audience=child`, {
      headers: { Cookie: sessionCookie(fx.instructorId, "instructor") },
    });
    assert.equal(res.status, 200);
    const { users } = await res.json();
    assert.deepEqual(users.map((u) => u.id).sort(), [fx.childId]);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("shared-module-attendance: ?audience=adult on the roster returns only the adult learner", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const res = await fetch(`${server.baseUrl}/api/users?role=learner&courseId=${fx.courseId}&audience=adult`, {
      headers: { Cookie: sessionCookie(fx.instructorId, "instructor") },
    });
    assert.equal(res.status, 200);
    const { users } = await res.json();
    assert.deepEqual(users.map((u) => u.id).sort(), [fx.adultId]);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("shared-module-attendance: no audience param keeps the exact old combined-roster behavior", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const res = await fetch(`${server.baseUrl}/api/users?role=learner&courseId=${fx.courseId}`, {
      headers: { Cookie: sessionCookie(fx.instructorId, "instructor") },
    });
    assert.equal(res.status, 200);
    const { users } = await res.json();
    assert.deepEqual(users.map((u) => u.id).sort(), [fx.adultId, fx.childId].sort());
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("shared-module-attendance: the existing-attendance prefill lookup honors ?audience= too", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const res = await fetch(`${server.baseUrl}/api/attendance/${fx.courseId}?date=2026-01-05&audience=child`, {
      headers: { Cookie: sessionCookie(fx.instructorId, "instructor") },
    });
    assert.equal(res.status, 200);
    const { attendance } = await res.json();
    assert.deepEqual(
      attendance.map((a) => a.learner_id),
      [fx.childId]
    );
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
