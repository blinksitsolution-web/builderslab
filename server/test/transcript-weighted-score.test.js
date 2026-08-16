/**
 * Stage 4F — Transcript weighted score display.
 *
 * The Tests/Midterm/End-of-Term columns on GET /api/grades/:userId/transcript
 * previously returned Tests as a rounded raw percentage (0-100) and
 * Midterm/End-of-Term completely unconverted (whatever raw value the
 * exam/legacy-grade row held) — none of them reflected their actual
 * transcript weight (10% / 20% / 70%). This locks in the fix: each
 * component is now converted once, at the transcript response boundary
 * (routes/grades.js's toWeightedScore), to points out of its own weight
 * — e.g. an 80% raw Tests score at the default 10% weight now reads 8
 * (out of a reported testsMax of 10), not 80. transcriptEngine.js's own
 * internal math (Total/Grade/retake eligibility) stays on the raw
 * percentage scale throughout — only the transcript route's *display*
 * fields change.
 *
 * Same real-server-process pattern as adult-learner-transcript-certificate
 * -access.test.js.
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
const JWT_SECRET = "transcript-weighted-score-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-transcript-weight-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "transcript-weighted-score-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-transcript-weight-uploads-"));
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

// ABRS v2.2 Compliance Remediation: transcript rows now resolve their
// Academic Term from HW-05's own Active Programme Run -> Academic Period
// -> Academic Term (§8.2/§19), not the school-wide "active term" directly
// — so any fixture seeding term-scoped grades/progress for HW-05 needs an
// actual course-scoped Learning Instance (HW-05 is a legacy/global module
// with no programme_id — see migrate.js's "legacy/global Builders Lab
// module" convention — so the Run is scoped directly to the course, not a
// Programme) with one Academic Period linked to the same term.
function ensureHw05LearningInstance(db, termId) {
  const runId = uuid();
  db.prepare("INSERT INTO learning_instances (id, offering_type_id, course_id, status, academic_structure) VALUES (?, (SELECT id FROM learning_offering_types LIMIT 1), 'HW-05', 'active', 'term')").run(
    runId
  );
  db.prepare(
    "INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name, academic_term_id) VALUES (?, ?, 1, 'Term 1', ?)"
  ).run(uuid(), runId, termId);
  db.prepare(
    "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, course_id, is_primary, instance_status) VALUES (?, ?, 'course', 'HW-05', 1, 'active')"
  ).run(uuid(), runId);
  return runId;
}

// Seeds one learner enrolled in HW-05 with:
//  - a raw Tests component of 80% (a single AI-quiz score in `progress`;
//    with every other Tests sub-component absent, testsComponent()
//    renormalizes to just that one input — see transcriptEngine.js)
//  - a raw Midterm of 60% and End-of-Term of 90% (legacy `grades` columns
//    — the fallback transcriptEngine.js uses when no Examination-panel
//    attempt exists)
// At the default weights (10/20/70) this should transcript-display as
// Tests 8/10, Midterm 12/20, End-of-Term 63/70, Total 83.
function seedLearnerWithScores(dbPath) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, is_adult, student_code)
       VALUES (?, 'learner', 'Test Scored Learner', ?, ?, 'active', 'current', date('now'), 1, ?)`
    ).run(id, `scored-${id}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${id.slice(0, 8)}`);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, 'HW-05')").run(id);
    const termId = db.prepare("SELECT id FROM academic_terms WHERE is_active = 1").get().id;
    ensureHw05LearningInstance(db, termId);
    db.prepare(
      "INSERT INTO progress (user_id, course_id, lesson_id, quiz_score, term_id) VALUES (?, 'HW-05', 'lesson-1', 80, ?)"
    ).run(id, termId);
    db.prepare(
      "INSERT INTO grades (user_id, course_id, midterm, end_of_term, term_id) VALUES (?, 'HW-05', 60, 90, ?)"
    ).run(id, termId);
    return id;
  } finally {
    db.close();
  }
}

test("transcript-weighted-score: Tests/Midterm/End-of-Term display as points out of their own weight, not raw percentages", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const learnerId = seedLearnerWithScores(dbPath);

    const res = await fetch(`${server.baseUrl}/api/grades/${learnerId}/transcript`, {
      headers: { Cookie: sessionCookie(learnerId, "learner") },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const row = body.rows.find((r) => r.courseId === "HW-05");
    assert.ok(row, "expected an HW-05 row on the transcript");

    // Weights default to 10/20/70 (no admin override in this test).
    assert.equal(body.weights.tests, 10);
    assert.equal(body.weights.midterm, 20);
    assert.equal(body.weights.endOfTerm, 70);

    // 80% raw Tests at 10% weight -> 8 out of 10.
    assert.equal(row.tests, 8);
    assert.equal(row.testsMax, 10);
    // 60% raw Midterm at 20% weight -> 12 out of 20.
    assert.equal(row.midterm, 12);
    assert.equal(row.midtermMax, 20);
    // 90% raw End-of-Term at 70% weight -> 63 out of 70.
    assert.equal(row.endOfTerm, 63);
    assert.equal(row.endOfTermMax, 70);

    // Total stays on the 0-100 scale (unaffected by this change): the
    // weighted average of the three *raw* percentages.
    assert.equal(row.total, 83);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("transcript-weighted-score: a 100% raw score on every component displays as the full weight (10/10, 20/20, 70/70) and a 0% score displays as 0", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const db = new Database(dbPath);
    const perfectId = uuid();
    const zeroId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, is_adult, student_code)
       VALUES (?, 'learner', 'Perfect Learner', ?, ?, 'active', 'current', date('now'), 1, ?)`
    ).run(perfectId, `perfect-${perfectId}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${perfectId.slice(0, 8)}`);
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, is_adult, student_code)
       VALUES (?, 'learner', 'Zero Learner', ?, ?, 'active', 'current', date('now'), 1, ?)`
    ).run(zeroId, `zero-${zeroId}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${zeroId.slice(0, 8)}`);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, 'HW-05')").run(perfectId);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, 'HW-05')").run(zeroId);
    const termId = db.prepare("SELECT id FROM academic_terms WHERE is_active = 1").get().id;
    ensureHw05LearningInstance(db, termId);
    db.prepare("INSERT INTO progress (user_id, course_id, lesson_id, quiz_score, term_id) VALUES (?, 'HW-05', 'lesson-1', 100, ?)").run(perfectId, termId);
    db.prepare("INSERT INTO grades (user_id, course_id, midterm, end_of_term, term_id) VALUES (?, 'HW-05', 100, 100, ?)").run(perfectId, termId);
    db.prepare("INSERT INTO progress (user_id, course_id, lesson_id, quiz_score, term_id) VALUES (?, 'HW-05', 'lesson-1', 0, ?)").run(zeroId, termId);
    db.prepare("INSERT INTO grades (user_id, course_id, midterm, end_of_term, term_id) VALUES (?, 'HW-05', 0, 0, ?)").run(zeroId, termId);
    db.close();

    const perfectRes = await fetch(`${server.baseUrl}/api/grades/${perfectId}/transcript`, {
      headers: { Cookie: sessionCookie(perfectId, "learner") },
    });
    const perfectRow = (await perfectRes.json()).rows.find((r) => r.courseId === "HW-05");
    assert.equal(perfectRow.tests, 10);
    assert.equal(perfectRow.midterm, 20);
    assert.equal(perfectRow.endOfTerm, 70);
    assert.equal(perfectRow.total, 100);

    const zeroRes = await fetch(`${server.baseUrl}/api/grades/${zeroId}/transcript`, {
      headers: { Cookie: sessionCookie(zeroId, "learner") },
    });
    const zeroRow = (await zeroRes.json()).rows.find((r) => r.courseId === "HW-05");
    assert.equal(zeroRow.tests, 0);
    assert.equal(zeroRow.midterm, 0);
    assert.equal(zeroRow.endOfTerm, 0);
    assert.equal(zeroRow.total, 0);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
