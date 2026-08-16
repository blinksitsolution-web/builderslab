/**
 * Stage 4D — Prevent duplicate programme enrolment.
 *
 * routes/enrolments.js's POST / already rejects a second active/
 * pending_payment enrolment in the same programme for a given learner
 * with a 409 before inserting. This locks that behaviour in for every
 * caller shape the endpoint supports (self, and parent-on-behalf-of-child
 * via resolveTargetLearner), and confirms the additive DB-level backstop
 * (migrate.js's idx_programme_enrollments_no_dup_active partial unique
 * index) doesn't disturb an existing valid enrolment or a legitimate
 * second enrolment in a *different* programme.
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
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");
const JWT_SECRET = "enrolment-duplicate-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-enrol-dup-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "enrolment-duplicate-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-enrol-dup-uploads-"));
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

// Seeds two Adult Professional Programmes, each with one Batch/Cohort —
// enough to test "duplicate in same programme" vs "different programme is
// fine" without touching Kids STEM's own module-season machinery.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();

    const programmeAId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Enrol Dup Test Programme A', 0)").run(programmeAId, offeringType.id);
    const classAId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Batch A', 0, ?)").run(classAId, programmeAId);

    const programmeBId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Enrol Dup Test Programme B', 1)").run(programmeBId, offeringType.id);
    const classBId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Batch B', 0, ?)").run(classBId, programmeBId);

    // Registration Source of Truth: an admin must intentionally open an
    // Active Programme Run before registration is possible — simulated for
    // both test programmes here.
    const runAId = uuid();
    db.prepare("INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)").run(runAId, offeringType.id, programmeAId);
    db.prepare("INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')").run(uuid(), runAId, programmeAId);
    const runBId = uuid();
    db.prepare("INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)").run(runBId, offeringType.id, programmeBId);
    db.prepare("INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')").run(uuid(), runBId, programmeBId);

    return { programmeAId, classAId, programmeBId, classBId };
  } finally {
    db.close();
  }
}

function seedAdultLearner(dbPath, { classId, programmeId } = {}) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    const email = `adult-${id}@example.test`;
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, is_adult, class_id, student_code)
       VALUES (?, 'learner', 'Test Adult Learner', ?, ?, 'active', 'current', date('now'), 1, ?, ?)`
    ).run(id, email, bcrypt.hashSync("learnerpass123", 12), classId || null, `T-${id.slice(0, 8)}`);
    if (classId && programmeId) {
      db.prepare(
        `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date)
         VALUES (?, ?, ?, ?, 1, 'active', 'current', date('now'))`
      ).run(uuid(), id, programmeId, classId);
    }
    return { id, email };
  } finally {
    db.close();
  }
}

function seedParent(dbPath) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date) VALUES (?, 'parent', 'Test Parent', ?, ?, 'active', 'current', date('now'))"
    ).run(id, `parent-${id}@example.test`, bcrypt.hashSync("parentpass123", 12));
    return id;
  } finally {
    db.close();
  }
}

function linkChildToParent(dbPath, childId, parentId) {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE users SET parent_id = ? WHERE id = ?").run(parentId, childId);
  } finally {
    db.close();
  }
}

function countEnrolments(dbPath, userId, programmeId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT COUNT(*) c FROM programme_enrollments WHERE user_id = ? AND programme_id = ?").get(userId, programmeId).c;
  } finally {
    db.close();
  }
}

test("enrolment-duplicate-prevention: a learner cannot enrol twice in the same programme", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { programmeAId, classAId } = seedFixtures(dbPath);
    const learner = seedAdultLearner(dbPath);

    const first = await fetch(`${server.baseUrl}/api/enrolments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(learner.id, "learner") },
      body: JSON.stringify({ targetUserId: learner.id, programmeId: programmeAId, classId: classAId }),
    });
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));

    const second = await fetch(`${server.baseUrl}/api/enrolments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(learner.id, "learner") },
      body: JSON.stringify({ targetUserId: learner.id, programmeId: programmeAId, classId: classAId }),
    });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.ok(body.error);

    assert.equal(countEnrolments(dbPath, learner.id, programmeAId), 1, "no duplicate row was created");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("enrolment-duplicate-prevention: a parent cannot enrol a child who is already enrolled in that programme", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { programmeAId, classAId } = seedFixtures(dbPath);
    // Child already has a primary/active enrolment in Programme A.
    const child = seedAdultLearner(dbPath, { classId: classAId, programmeId: programmeAId });
    const parentId = seedParent(dbPath);
    linkChildToParent(dbPath, child.id, parentId);

    const res = await fetch(`${server.baseUrl}/api/enrolments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(parentId, "parent") },
      body: JSON.stringify({ targetUserId: child.id, programmeId: programmeAId, classId: classAId }),
    });
    assert.equal(res.status, 409);

    assert.equal(countEnrolments(dbPath, child.id, programmeAId), 1);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("enrolment-duplicate-prevention: enrolling in a different (additional) programme still works, and repeated/duplicate submissions of it are rejected", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { programmeAId, classAId, programmeBId, classBId } = seedFixtures(dbPath);
    // Learner already primary-enrolled in Programme A.
    const learner = seedAdultLearner(dbPath, { classId: classAId, programmeId: programmeAId });

    // Enrolling in the additional Programme B is a genuinely new
    // programme for this learner — must succeed and leave the existing
    // Programme A enrolment untouched.
    const addRes = await fetch(`${server.baseUrl}/api/enrolments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(learner.id, "learner") },
      body: JSON.stringify({ targetUserId: learner.id, programmeId: programmeBId, classId: classBId }),
    });
    assert.equal(addRes.status, 200, JSON.stringify(await addRes.clone().json()));
    assert.equal(countEnrolments(dbPath, learner.id, programmeAId), 1, "existing valid enrolment in Programme A is unchanged");
    assert.equal(countEnrolments(dbPath, learner.id, programmeBId), 1);

    // A second, duplicate submission for Programme B is rejected.
    const dupRes = await fetch(`${server.baseUrl}/api/enrolments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(learner.id, "learner") },
      body: JSON.stringify({ targetUserId: learner.id, programmeId: programmeBId, classId: classBId }),
    });
    assert.equal(dupRes.status, 409);
    assert.equal(countEnrolments(dbPath, learner.id, programmeBId), 1, "still just one row for Programme B");

    // Confirm the "mine" listing shows exactly one row per programme.
    const mineRes = await fetch(`${server.baseUrl}/api/enrolments/mine?targetUserId=${learner.id}`, {
      headers: { Cookie: sessionCookie(learner.id, "learner") },
    });
    const { enrolments } = await mineRes.json();
    assert.equal(enrolments.length, 2);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
