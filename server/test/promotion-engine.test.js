/**
 * Promotion Subsystem tests (ABRS v2.1 Section 12).
 *
 * Verifies: Programme-owned Promotion Policy config, eligibility evaluation
 * (score/attendance/instructor-recommendation), manual promotion (with and
 * without override), automatic promotion (policy-gated, no override),
 * reversal, and the constitutional guarantee that none of this ever
 * mutates a Course record, current_academic_year_id, campus, or financial
 * status — only users.class_id and promotion_log.
 *
 * Same real-server-process pattern as enrollment-activation.test.js.
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
const JWT_SECRET = "builderslab-promotion-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-promotion-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "builderslab-promotion-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-promotion-uploads-"));
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

// Seeds: admin, a Kids STEM programme with Foundation -> Framework classes,
// one course, a parent+two learners placed in Foundation. One learner has
// a passing grade+full attendance, the other has none (so it fails a
// score/attendance-gated policy by default).
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'admin-promotion-test@example.com', 'x', 'active', 'paid', 1, 'ADM-PROMO-1', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const kidsOfferingType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Promotion Test Programme', 0)").run(
      programmeId,
      kidsOfferingType.id
    );

    const foundationId = uuid();
    const frameworkId = uuid();
    const skylineId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Promo Foundation', 0, ?)").run(foundationId, programmeId);
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Promo Framework', 1, ?)").run(frameworkId, programmeId);
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Promo Skyline', 2, ?)").run(skylineId, programmeId);

    const courseId = uuid();
    db.prepare("INSERT INTO courses (id, title, is_open, programme_id) VALUES (?, 'Promo Test Course', 1, ?)").run(courseId, programmeId);

    const parentId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date) VALUES (?, 'parent', 'Test Parent', 'parent-promotion-test@example.com', 'x', 'active', 'paid', date('now'))"
    ).run(parentId);

    const strongLearnerId = uuid();
    const weakLearnerId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, class_id, parent_id, student_code, joined_date) VALUES (?, 'learner', 'Strong Learner', 'strong-learner-promotion-test@example.com', 'x', 'active', 'paid', ?, ?, 'STU-PROMO-1', date('now'))"
    ).run(strongLearnerId, foundationId, parentId);
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, class_id, parent_id, student_code, joined_date) VALUES (?, 'learner', 'Weak Learner', 'weak-learner-promotion-test@example.com', 'x', 'active', 'paid', ?, ?, 'STU-PROMO-2', date('now'))"
    ).run(weakLearnerId, foundationId, parentId);

    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(strongLearnerId, courseId);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(weakLearnerId, courseId);

    // migrate.js already seeds exactly one active Academic Year/Term (only
    // one row may have is_active=1 system-wide) — reuse it rather than
    // inserting a second is_active=1 row, which would make getActiveTerm()'s
    // choice between the two ambiguous.
    const termId = db.prepare("SELECT id FROM academic_terms WHERE is_active = 1").get().id;

    // ABRS v2.2 Compliance Remediation: promotion eligibility now resolves
    // each module's Academic Term from its own Active Programme Run's
    // current Academic Period (Programme Run -> Academic Period ->
    // Academic Term, §8.2/§19) rather than the school-wide "active term"
    // directly — so this fixture needs an actual Active Programme Run for
    // the Programme, with one Academic Period linked to that same term
    // (same pattern used elsewhere, e.g. builderslab-architecture.test.js).
    const runId = uuid();
    db.prepare("INSERT INTO learning_instances (id, offering_type_id, programme_id, status) VALUES (?, ?, ?, 'active')").run(
      runId,
      kidsOfferingType.id,
      programmeId
    );
    db.prepare(
      "UPDATE learning_instances SET academic_structure = 'term' WHERE id = ?"
    ).run(runId);
    db.prepare(
      "INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name, academic_term_id) VALUES (?, ?, 1, 'Term 1', ?)"
    ).run(uuid(), runId, termId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), runId, programmeId);

    // Strong learner: high grades, full attendance.
    db.prepare("INSERT INTO grades (user_id, course_id, midterm, end_of_term, term_id) VALUES (?, ?, 95, 95, ?)").run(strongLearnerId, courseId, termId);
    db.prepare("INSERT INTO attendance (id, course_id, instructor_id, learner_id, date, status) VALUES (?, ?, ?, ?, '2026-02-01', 'present')").run(
      uuid(), courseId, adminId, strongLearnerId
    );

    // Weak learner: low grades, no attendance records at all.
    db.prepare("INSERT INTO grades (user_id, course_id, midterm, end_of_term, term_id) VALUES (?, ?, 20, 20, ?)").run(weakLearnerId, courseId, termId);

    return { adminId, programmeId, foundationId, frameworkId, skylineId, courseId, parentId, strongLearnerId, weakLearnerId };
  } finally {
    db.close();
  }
}

function adminCookie(adminId) {
  const token = jwt.sign({ sub: adminId, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

function rawDb(dbPath) {
  return new Database(dbPath);
}

test("Promotion Subsystem: policy config, eligibility, manual/auto promotion, reversal", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    const ready = await waitForReady(server.baseUrl, 15000);
    assert.equal(ready, true, `server did not become ready. stderr: ${server.getStderr()}`);
    const cookie = adminCookie(fx.adminId);
    const authed = (extra) => ({ headers: { "Content-Type": "application/json", Cookie: cookie }, ...extra });

    // --- No policy configured yet: both learners should be eligibility-neutral ---
    let res = await fetch(`${server.baseUrl}/api/promotion/eligibility/${fx.weakLearnerId}`, authed());
    let body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.eligible, true, "with no configured policy, a learner must be eligibility-neutral, never blocked");

    // --- Configure a Promotion Policy requiring 50% average and 50% attendance ---
    res = await fetch(
      `${server.baseUrl}/api/promotion/policy/${fx.programmeId}`,
      authed({ method: "PUT", body: JSON.stringify({ minAverageScore: 50, minAttendancePercent: 50, requiresInstructorRecommendation: false }) })
    );
    assert.equal(res.status, 200);

    // --- Strong learner should now be eligible, weak learner should not ---
    res = await fetch(`${server.baseUrl}/api/promotion/eligibility/${fx.strongLearnerId}`, authed());
    body = await res.json();
    assert.equal(body.eligible, true, `strong learner should be eligible: ${JSON.stringify(body)}`);
    assert.equal(body.toClassId, fx.frameworkId);

    res = await fetch(`${server.baseUrl}/api/promotion/eligibility/${fx.weakLearnerId}`, authed());
    body = await res.json();
    assert.equal(body.eligible, false, "weak learner should fail the score/attendance policy");
    assert.ok(body.reasons.length > 0);

    // --- Manual promotion without override should reject the ineligible learner, promote the eligible one ---
    res = await fetch(
      `${server.baseUrl}/api/promotion/manual`,
      authed({ method: "POST", body: JSON.stringify({ learnerIds: [fx.strongLearnerId, fx.weakLearnerId] }) })
    );
    body = await res.json();
    assert.equal(res.status, 200);
    const strongResult = body.results.find((r) => r.learnerId === fx.strongLearnerId);
    const weakResult = body.results.find((r) => r.learnerId === fx.weakLearnerId);
    assert.equal(strongResult.ok, true);
    assert.equal(weakResult.ok, false);
    assert.equal(weakResult.requiresOverrideReason, true);

    // --- Confirm ONLY class_id changed for the strong learner: no year/campus/status mutation ---
    let db2 = rawDb(dbPath);
    let strongRow = db2.prepare("SELECT class_id, current_academic_year_id, campus, status, payment_status FROM users WHERE id = ?").get(fx.strongLearnerId);
    db2.close();
    assert.equal(strongRow.class_id, fx.frameworkId);
    assert.equal(strongRow.status, "active", "Promotion must never change enrollment/account status");
    assert.equal(strongRow.payment_status, "paid", "Promotion must never change financial status");

    // --- Confirm a parent notification message was created ---
    db2 = rawDb(dbPath);
    const message = db2.prepare("SELECT * FROM messages WHERE to_id = ? ORDER BY date DESC LIMIT 1").get(fx.parentId);
    db2.close();
    assert.ok(message, "expected a parent-notification message after promotion");
    assert.match(message.body, /promoted/i);

    // --- Confirm promotion_log recorded the action with a policy snapshot ---
    res = await fetch(`${server.baseUrl}/api/promotion/log/${fx.strongLearnerId}`, authed());
    body = await res.json();
    const logEntry = body.history.find((h) => h.action === "manual_promote");
    assert.ok(logEntry, "expected a manual_promote log entry");
    assert.ok(logEntry.policy_snapshot, "expected a policy_snapshot to be recorded");

    // --- Manual promotion WITH override should succeed for the ineligible learner ---
    res = await fetch(
      `${server.baseUrl}/api/promotion/manual`,
      authed({ method: "POST", body: JSON.stringify({ learnerIds: [fx.weakLearnerId], overrideReason: "Admin discretion — special circumstances" }) })
    );
    body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.results[0].ok, true);
    assert.equal(body.results[0].wasOverride, true);

    // --- Confirm no Course record was ever mutated by any of the above ---
    db2 = rawDb(dbPath);
    const course = db2.prepare("SELECT * FROM courses WHERE id = ?").get(fx.courseId);
    const lic = db2.prepare("SELECT COUNT(*) as c FROM learning_instance_courses").get();
    db2.close();
    assert.equal(course.title, "Promo Test Course", "Course record must be untouched");
    assert.equal(lic.c, 0, "Promotion must never create/mutate Activated Course rows");

    // --- Reversal: fetch the weak learner's override log entry and reverse it ---
    res = await fetch(`${server.baseUrl}/api/promotion/log/${fx.weakLearnerId}`, authed());
    body = await res.json();
    const overrideLog = body.history.find((h) => h.action === "manual_promote");
    res = await fetch(`${server.baseUrl}/api/promotion/reverse`, authed({ method: "POST", body: JSON.stringify({ logId: overrideLog.id }) }));
    body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.toClassId, fx.foundationId);

    db2 = rawDb(dbPath);
    const weakRowAfterReversal = db2.prepare("SELECT class_id FROM users WHERE id = ?").get(fx.weakLearnerId);
    db2.close();
    assert.equal(weakRowAfterReversal.class_id, fx.foundationId, "reversal must restore the prior Programme Level");

    // --- Automatic (bulk) promotion: only the still-eligible-and-unpromoted learner in Foundation moves ---
    res = await fetch(`${server.baseUrl}/api/promotion/auto-promote`, authed({ method: "POST", body: JSON.stringify({ classId: fx.foundationId }) }));
    body = await res.json();
    assert.equal(res.status, 200);
    const weakAuto = body.results.find((r) => r.learnerId === fx.weakLearnerId);
    assert.equal(weakAuto.promoted, false, "auto-promote must never override policy — weak learner still fails it");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// Checkpoint 4 report, Remaining work item 5: attendance evaluation must be
// bound to "since last Programme Level change," so an old attendance
// record from a previous level doesn't carry into the new one.
test("Promotion Subsystem: attendance evaluation is bounded to the current Programme Level", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    const ready = await waitForReady(server.baseUrl, 15000);
    assert.equal(ready, true, `server did not become ready. stderr: ${server.getStderr()}`);
    const cookie = adminCookie(fx.adminId);
    const authed = (extra) => ({ headers: { "Content-Type": "application/json", Cookie: cookie }, ...extra });

    // The strong learner already has one 'present' attendance row seeded at
    // Foundation, dated 2026-02-01 (well before this test runs). Promote
    // them to Framework with no policy configured yet (eligibility-neutral).
    let res = await fetch(
      `${server.baseUrl}/api/promotion/manual`,
      authed({ method: "POST", body: JSON.stringify({ learnerIds: [fx.strongLearnerId] }) })
    );
    let body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.results[0].ok, true);
    assert.equal(body.results[0].toClassId, fx.frameworkId);

    // Record a single new attendance row for the Framework attempt, marked
    // 'absent' — dated today, so it falls at-or-after the promotion's own
    // timestamp.
    const db2 = rawDb(dbPath);
    db2
      .prepare(
        "INSERT INTO attendance (id, course_id, instructor_id, learner_id, date, status) VALUES (?, ?, ?, ?, date('now'), 'absent')"
      )
      .run(uuid(), fx.courseId, fx.adminId, fx.strongLearnerId);
    db2.close();

    // Configure a policy requiring 50% attendance.
    res = await fetch(
      `${server.baseUrl}/api/promotion/policy/${fx.programmeId}`,
      authed({ method: "PUT", body: JSON.stringify({ minAttendancePercent: 50, minAverageScore: null, requiresInstructorRecommendation: false }) })
    );
    assert.equal(res.status, 200);

    res = await fetch(`${server.baseUrl}/api/promotion/eligibility/${fx.strongLearnerId}`, authed());
    body = await res.json();
    assert.equal(res.status, 200);
    // If the old Foundation 'present' row were still counted, attendance
    // would blend to 50% (1 present + 1 absent) and stay exactly at the
    // policy's threshold. Bounded correctly, only the new 'absent' row at
    // Framework counts: 0%, below the 50% minimum.
    assert.equal(body.breakdown.attendancePercent, 0, `expected only the post-promotion attendance row to count: ${JSON.stringify(body.breakdown)}`);
    assert.equal(body.eligible, false, "the bounded 0% attendance should fail the 50% policy");
    assert.ok(body.breakdown.attendanceSince, "expected an attendanceSince bound to be recorded once a level change has happened");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
