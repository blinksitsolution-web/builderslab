/**
 * Stage 3 — Adult and Child Learners Using the Same Module.
 *
 * Covers the one concrete, previously-unenforced gap this stage requires:
 * POST /api/messages/broadcast-learners narrowed to a shared module (a
 * module both a Child class and an Adult batch are enrolled in via the
 * legacy `enrollments` table — see routes/auth.js, which inserts both
 * audiences into it) now (a) lets the caller pick Child / Adult / Both,
 * enforced server-side, and (b) refuses an instructor who isn't actually
 * assigned to that module (instructor_courses), instead of trusting the
 * frontend's module dropdown alone.
 *
 * Individual academic records (attendance/progress/grades/assignment
 * submissions/exam & CA attempts) were already correctly scoped by
 * user_id + course_id (and, where Learning Instances are adopted,
 * learning_instance_id too — see utils/learningInstances.js), so sharing
 * a module between audiences was never a correctness risk there; this
 * file doesn't re-test that, only the one place that genuinely mixed the
 * two audiences together with no way to separate them.
 *
 * Same real-server-process pattern as admin-class-delivery-mode.test.js.
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
const JWT_SECRET = "shared-module-broadcast-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-shared-module-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "shared-module-broadcast-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-shared-module-uploads-"));
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

// One Programme (eligibility_audience defaults to 'both') with a single
// Module, one Child class under it (a child learner placed via class_id,
// the Kids STEM path) and one Adult learner (enrolled directly into the
// module via the legacy `enrollments` table, the Adult path — see
// routes/auth.js). Two instructors: one actually assigned to the shared
// module (instructor_courses), one not.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Shared Module Test Programme', 0)").run(
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
    // legacy `instructor_courses` table that was consolidated onto it (see
    // migrate.js's "Instructor Assignment consolidated onto
    // instructor_assignments" step and utils/instructorScope.js). A single
    // wildcard row (course_id NULL) on an Active Run for this Programme
    // grants the instructor every Course under that Run — equivalent to
    // the old instructor_courses grant this replaces.
    const instanceId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status) VALUES (?, ?, ?, 'active')"
    ).run(instanceId, offeringType.id, programmeId);

    const assignedInstructorId = mkUser("instructor", { name: "Assigned Instructor" });
    db.prepare(
      "INSERT INTO instructor_assignments (id, instructor_id, learning_instance_id, course_id) VALUES (?, ?, ?, NULL)"
    ).run(uuid(), assignedInstructorId, instanceId);

    const unassignedInstructorId = mkUser("instructor", { name: "Unassigned Instructor" });

    return { courseId, childId, adultId, assignedInstructorId, unassignedInstructorId };
  } finally {
    db.close();
  }
}

test("shared-module-broadcast: audience=child on a shared module reaches only the child learner", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const res = await fetch(`${server.baseUrl}/api/messages/broadcast-learners`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(fx.assignedInstructorId, "instructor") },
      body: JSON.stringify({ body: "Hello class", courseId: fx.courseId, audience: "child" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sentTo, 1);

    const db = new Database(dbPath, { readonly: true });
    const recipients = db.prepare("SELECT to_id FROM messages WHERE body = 'Hello class'").all().map((r) => r.to_id);
    db.close();
    assert.deepEqual(recipients, [fx.childId]);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("shared-module-broadcast: audience=adult on a shared module reaches only the adult learner", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const res = await fetch(`${server.baseUrl}/api/messages/broadcast-learners`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(fx.assignedInstructorId, "instructor") },
      body: JSON.stringify({ body: "Hello batch", courseId: fx.courseId, audience: "adult" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sentTo, 1);

    const db = new Database(dbPath, { readonly: true });
    const recipients = db.prepare("SELECT to_id FROM messages WHERE body = 'Hello batch'").all().map((r) => r.to_id);
    db.close();
    assert.deepEqual(recipients, [fx.adultId]);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("shared-module-broadcast: audience=both (and the default with no audience sent) reaches both learners", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const explicitRes = await fetch(`${server.baseUrl}/api/messages/broadcast-learners`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(fx.assignedInstructorId, "instructor") },
      body: JSON.stringify({ body: "Hello everyone", courseId: fx.courseId, audience: "both" }),
    });
    assert.equal((await explicitRes.json()).sentTo, 2);

    // Pre-existing callers that never send `audience` at all (matches the
    // exact request shape every caller sent before this stage) must keep
    // getting the exact old behavior: both audiences, unfiltered.
    const defaultRes = await fetch(`${server.baseUrl}/api/messages/broadcast-learners`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(fx.assignedInstructorId, "instructor") },
      body: JSON.stringify({ body: "Hello everyone again", courseId: fx.courseId }),
    });
    assert.equal((await defaultRes.json()).sentTo, 2);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("shared-module-broadcast: an instructor not assigned to the module is refused, regardless of audience", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const res = await fetch(`${server.baseUrl}/api/messages/broadcast-learners`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(fx.unassignedInstructorId, "instructor") },
      body: JSON.stringify({ body: "Sneaky broadcast", courseId: fx.courseId, audience: "both" }),
    });
    assert.equal(res.status, 403);

    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) as n FROM messages WHERE body = 'Sneaky broadcast'").get().n;
    db.close();
    assert.equal(count, 0);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
