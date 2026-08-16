/**
 * Stage 4E — a learner must not see or access programme/module content
 * without a genuine enrollment context.
 *
 * Before this: GET /api/modules/:courseId/lessons and the progress/quiz
 * routes in routes/progress.js only checked payment status
 * (requireActiveAccess*) — never whether the caller (or, for a parent
 * caller, any linked child) actually has an `enrollments` row for that
 * specific module. The learner dashboard only ever *requests* lessons
 * for modules already in the learner's own enrolled set (see
 * useLearnerDashboard.js), so this gap was invisible through the normal
 * UI — but a direct request for a courseId the learner was never
 * enrolled in still returned real lesson content. This locks in the new
 * server-side ownership check added in routes/modules.js and
 * routes/progress.js (via utils/lessonCatalog.js's
 * isLearnerEnrolledInModule / callerCanAccessModule).
 *
 * Same real-server-process pattern as shared-module-attendance-audience
 * .test.js.
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
const JWT_SECRET = "module-access-enrollment-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-module-access-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "module-access-enrollment-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-module-access-uploads-"));
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

function seedLearner(dbPath, { enrolledModuleIds = [] } = {}) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, student_code)
       VALUES (?, 'learner', 'Test Learner', ?, ?, 'active', 'current', date('now'), ?)`
    ).run(id, `learner-${id}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${id.slice(0, 8)}`);
    const enroll = db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)");
    enrolledModuleIds.forEach((m) => enroll.run(id, m));
    return id;
  } finally {
    db.close();
  }
}

function seedParentWithChild(dbPath, { enrolledModuleIds = [] } = {}) {
  const db = new Database(dbPath);
  try {
    const parentId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date) VALUES (?, 'parent', 'Test Parent', ?, ?, 'active', 'current', date('now'))"
    ).run(parentId, `parent-${parentId}@example.test`, bcrypt.hashSync("parentpass123", 12));
    const childId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, parent_id, student_code)
       VALUES (?, 'learner', 'Test Child', ?, ?, 'active', 'current', date('now'), ?, ?)`
    ).run(childId, `child-${childId}@example.test`, bcrypt.hashSync("childpass123", 12), parentId, `T-${childId.slice(0, 8)}`);
    const enroll = db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)");
    enrolledModuleIds.forEach((m) => enroll.run(childId, m));
    return { parentId, childId };
  } finally {
    db.close();
  }
}

test("module-access-enrollment: a learner can fetch lessons for a module they're enrolled in", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const learnerId = seedLearner(dbPath, { enrolledModuleIds: ["HW-05"] });

    const res = await fetch(`${server.baseUrl}/api/modules/HW-05/lessons`, {
      headers: { Cookie: sessionCookie(learnerId, "learner") },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.lessons));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("module-access-enrollment: a learner cannot fetch lessons for a module they're NOT enrolled in (direct navigation is blocked server-side)", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    // Enrolled only in HW-05, not PRG-01.
    const learnerId = seedLearner(dbPath, { enrolledModuleIds: ["HW-05"] });

    const res = await fetch(`${server.baseUrl}/api/modules/PRG-01/lessons`, {
      headers: { Cookie: sessionCookie(learnerId, "learner") },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("module-access-enrollment: watch-progress and quiz routes are also gated on enrollment, not just payment status", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const learnerId = seedLearner(dbPath, { enrolledModuleIds: ["HW-05"] });

    // Not enrolled in PRG-01: watch-progress must be rejected.
    const watchRes = await fetch(`${server.baseUrl}/api/progress/${learnerId}/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(learnerId, "learner") },
      body: JSON.stringify({ courseId: "PRG-01", lessonId: "some-lesson", seconds: 30 }),
    });
    assert.equal(watchRes.status, 403);

    // Not enrolled in PRG-01: the quiz-questions route must be rejected too.
    const quizRes = await fetch(`${server.baseUrl}/api/progress/quiz/PRG-01/some-lesson`, {
      headers: { Cookie: sessionCookie(learnerId, "learner") },
    });
    assert.equal(quizRes.status, 403);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("module-access-enrollment: a parent can view lessons for a module their enrolled child has, but not for a module no linked child has", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { parentId } = seedParentWithChild(dbPath, { enrolledModuleIds: ["HW-05"] });

    const okRes = await fetch(`${server.baseUrl}/api/modules/HW-05/lessons`, {
      headers: { Cookie: sessionCookie(parentId, "parent") },
    });
    assert.equal(okRes.status, 200);

    const blockedRes = await fetch(`${server.baseUrl}/api/modules/PRG-01/lessons`, {
      headers: { Cookie: sessionCookie(parentId, "parent") },
    });
    assert.equal(blockedRes.status, 403);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("module-access-enrollment: an instructor/admin is never blocked by the enrollment gate", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const db = new Database(dbPath);
    const adminId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date) VALUES (?, 'admin', 'Test Admin', ?, ?, 'active', 'current', date('now'))"
    ).run(adminId, `admin-${adminId}@example.test`, bcrypt.hashSync("adminpass123", 12));
    db.close();

    const res = await fetch(`${server.baseUrl}/api/modules/HW-05/lessons`, {
      headers: { Cookie: sessionCookie(adminId, "admin") },
    });
    assert.equal(res.status, 200);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("module-access-enrollment: an existing correctly-enrolled learner's access is completely unaffected", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const learnerId = seedLearner(dbPath, { enrolledModuleIds: ["HW-05", "PRG-01"] });

    for (const courseId of ["HW-05", "PRG-01"]) {
      const res = await fetch(`${server.baseUrl}/api/modules/${courseId}/lessons`, {
        headers: { Cookie: sessionCookie(learnerId, "learner") },
      });
      assert.equal(res.status, 200, `expected access to ${courseId} to remain unaffected`);
    }
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
