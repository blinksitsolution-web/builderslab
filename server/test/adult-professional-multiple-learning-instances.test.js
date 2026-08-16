/**
 * Adult Professional — multiple Learning Instances of the same Course.
 *
 * Locks in the "Course -> many Learning Instances" architecture: a single
 * Adult Professional Course (Programme row) can have more than one
 * concurrently-active Learning Instance (e.g. a "May 2027" delivery and a
 * "September 2027" delivery of the same course), and:
 *
 *  - registering with no learningInstanceId while more than one is active
 *    is rejected (409) with the real candidate list, never silently
 *    attached to whichever one happens to be "first"/"latest";
 *  - registering with an explicit learningInstanceId attaches the learner
 *    to exactly that instance;
 *  - two learners registered into two different instances of the same
 *    Course remain isolated: each enrollment's learning_instance_id is
 *    its own, one instance's fee/context does not leak into the other's.
 *
 * No new "Run"/"CourseOffering" entity was introduced — this exercises the
 * existing Learning Instance entity exactly as routes/auth.js's real adult
 * registration path already uses it via resolveActiveInstanceForRegistration
 * (utils/learningInstances.js).
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
const JWT_SECRET = "adult-multi-instance-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-adult-multi-instance-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "adult-multi-instance-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-adult-multi-instance-uploads-"));
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

// One Adult Professional Course (Programme row), one Batch (classes row —
// admin already configures a Batch/Cohort per registration, orthogonal to
// which Learning Instance/delivery it's under), and TWO concurrently
// active Learning Instances of that same Course: "May 2027" and
// "September 2027".
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();

    const programmeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Professional Digital Marketing', 0)"
    ).run(programmeId, offeringType.id);
    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Batch A', 0, ?)").run(classId, programmeId);

    function makeRun(name) {
      const runId = uuid();
      db.prepare(
        "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name, registration_fee_ghs) VALUES (?, ?, ?, 'active', ?, 350)"
      ).run(runId, offeringType.id, programmeId, name);
      db.prepare(
        "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
      ).run(uuid(), runId, programmeId);
      return runId;
    }

    const mayRunId = makeRun("May 2027");
    const septRunId = makeRun("September 2027");

    return { programmeId, classId, mayRunId, septRunId };
  } finally {
    db.close();
  }
}

function adultPayload({ classId, learningInstanceId }) {
  return {
    kind: "adult",
    classId,
    ...(learningInstanceId !== undefined ? { learningInstanceId } : {}),
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

test("adult-professional multi-instance: registering with no learningInstanceId while two deliveries are active is rejected (409), never silently attached to either", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.classId })),
    });
    const body = await res.json();
    assert.equal(res.status, 409, JSON.stringify(body));
    const returnedIds = (body.activeRuns || []).map((r) => r.id).sort();
    assert.deepEqual(returnedIds, [fx.mayRunId, fx.septRunId].sort());
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("adult-professional multi-instance: two learners registering into two different deliveries of the SAME Course remain isolated", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());

    const mayRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.classId, learningInstanceId: fx.mayRunId })),
    });
    const mayBody = await mayRes.json();
    assert.equal(mayRes.status, 200, JSON.stringify(mayBody));

    const septRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.classId, learningInstanceId: fx.septRunId })),
    });
    const septBody = await septRes.json();
    assert.equal(septRes.status, 200, JSON.stringify(septBody));

    const mayEnrollment = readEnrollment(dbPath, mayBody.learnerId);
    const septEnrollment = readEnrollment(dbPath, septBody.learnerId);

    assert.equal(mayEnrollment.learning_instance_id, fx.mayRunId, "May learner must attach to the May instance");
    assert.equal(septEnrollment.learning_instance_id, fx.septRunId, "September learner must attach to the September instance");
    assert.notEqual(mayEnrollment.learning_instance_id, septEnrollment.learning_instance_id);
    // Both remain the SAME Course/Programme — the Course was never
    // duplicated to support the second delivery.
    assert.equal(mayEnrollment.programme_id, fx.programmeId);
    assert.equal(septEnrollment.programme_id, fx.programmeId);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("adult-professional multi-instance: a learningInstanceId that doesn't belong to this Course's active runs is ignored, never used to attach the learner to a foreign instance", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);

  // A completely unrelated Adult Professional Course + its own active run —
  // the "Course A + Learning Instance belonging to Course B" attack.
  const db = new Database(dbPath);
  const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
  const otherProgrammeId = uuid();
  db.prepare(
    "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Unrelated Adult Course', 1)"
  ).run(otherProgrammeId, offeringType.id);
  const otherRunId = uuid();
  db.prepare(
    "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name, registration_fee_ghs) VALUES (?, ?, ?, 'active', 'Unrelated Run', 350)"
  ).run(otherRunId, offeringType.id, otherProgrammeId);
  db.prepare(
    "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
  ).run(uuid(), otherRunId, otherProgrammeId);
  db.close();

  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adultPayload({ classId: fx.classId, learningInstanceId: otherRunId })),
    });
    const body = await res.json();
    // Two active runs exist for THIS Course (May/September) and the
    // submitted id belongs to neither — the resolver ignores it and it
    // remains genuinely ambiguous, so registration is rejected (409) with
    // this Course's own real candidates, never silently attached to the
    // unrelated Course's run.
    assert.equal(res.status, 409, JSON.stringify(body));
    const returnedIds = (body.activeRuns || []).map((r) => r.id).sort();
    assert.deepEqual(returnedIds, [fx.mayRunId, fx.septRunId].sort());
    assert.ok(!returnedIds.includes(otherRunId));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
