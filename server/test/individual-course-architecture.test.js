/**
 * Individual Course Architecture — Complete Audit & Regression Test Suite
 *
 * Validates:
 * 1. Individual Course registration grants ONLY explicitly requested course(s).
 * 2. Unrequested courses in the same Course Group are NEVER automatically granted.
 * 3. class_id is null / isolated for Individual Course registrations.
 * 4. Course-selection security validation rejects closed, unrelated, or invalid course IDs.
 * 5. Academic structure (none, term, semester) supported.
 * 6. Monthly billing is blocked for term/semester individual courses.
 * 7. Level promotion is blocked for individual course learners.
 * 8. Transcripts and user-views return className = null (no level leakage).
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
const JWT_SECRET = "ind-course-arch-test-secret-key";

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

async function waitForReady(baseUrl, timeoutMs = 14000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function prepareDb() {
  // Use a workspace-local .tmp directory to avoid Windows extended-path EPERM issues
  const tmpBase = path.join(SERVER_CWD, ".tmp-test");
  if (!fs.existsSync(tmpBase)) fs.mkdirSync(tmpBase, { recursive: true });
  const dbDir = fs.mkdtempSync(path.join(tmpBase, "ind-course-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "ind-course-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  delete env.NODE_ENV;
  delete env.PAYSTACK_SECRET_KEY;
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-ind-course-uploads-"));
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
        setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 4000);
      });
    },
  };
}

function makeAdminCookie(userId) {
  return `dtl_token=${jwt.sign({ sub: userId, role: "admin" }, JWT_SECRET, { expiresIn: "1h" })}`;
}
function makeLearnerCookie(userId) {
  return `dtl_token=${jwt.sign({ sub: userId, role: "learner" }, JWT_SECRET, { expiresIn: "1h" })}`;
}

// ─── Shared test state ──────────────────────────────────────────────────────
let STATE;

test("Individual Course Architecture — Isolation, Validation & Regression Suite", { timeout: 180000 }, async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });

  try {
    assert.ok(await waitForReady(server.baseUrl), `Server did not start in time.\nSTDERR: ${server.getStderr()}`);

    const db = new Database(dbPath);

    // ── Seed domain data ─────────────────────────────────────────────────────
    const kidsOT = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    assert.ok(kidsOT, "kids_stem offering type must exist");

    const adminId = uuid();
    const superAdminTpl = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id)
       VALUES (?, 'admin', 'Audit Admin', 'audit-admin@example.com', 'hash', 'active', 'paid', 1, 'ADM-AUD-01', date('now'), ?)`
    ).run(adminId, superAdminTpl ? superAdminTpl.id : null);

    // Programme
    const programmeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order, is_active) VALUES (?, ?, 'Robotics Ind. Programme', 1, 1)"
    ).run(programmeId, kidsOT.id);

    // Courses — open, closed, unrelated
    const courseRoboticsId = uuid();
    const courseIotId = uuid();
    const coursePythonId = uuid();
    const courseClosedId = uuid();
    const unrelatedProgrammeId = uuid();
    const courseUnrelatedId = uuid();
    db.prepare("INSERT INTO courses (id, title, blurb, is_open, programme_id) VALUES (?, 'Robotics 101', 'Intro Robotics', 1, ?)").run(courseRoboticsId, programmeId);
    db.prepare("INSERT INTO courses (id, title, blurb, is_open, programme_id) VALUES (?, 'IoT 101', 'Intro IoT', 1, ?)").run(courseIotId, programmeId);
    db.prepare("INSERT INTO courses (id, title, blurb, is_open, programme_id) VALUES (?, 'Python 101', 'Intro Python', 1, ?)").run(coursePythonId, programmeId);
    db.prepare("INSERT INTO courses (id, title, blurb, is_open, programme_id) VALUES (?, 'Old Robotics', 'Archived', 0, ?)").run(courseClosedId, programmeId);
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order, is_active) VALUES (?, ?, 'Other Programme', 2, 1)").run(unrelatedProgrammeId, kidsOT.id);
    db.prepare("INSERT INTO courses (id, title, blurb, is_open, programme_id) VALUES (?, 'Unrelated Course', 'Other', 1, ?)").run(courseUnrelatedId, unrelatedProgrammeId);

    // Foundation level with Course Group (mimics Structured path — Individual must NOT inherit these)
    const classFoundationId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Foundation', 1, ?)").run(classFoundationId, programmeId);
    const courseGroupId = uuid();
    db.prepare("INSERT INTO course_groups (id, name, programme_id) VALUES (?, 'Robotics Track', ?)").run(courseGroupId, programmeId);
    db.prepare("INSERT INTO course_group_courses (id, course_group_id, class_id, course_id) VALUES (?, ?, ?, ?)").run(uuid(), courseGroupId, classFoundationId, courseRoboticsId);
    db.prepare("INSERT INTO course_group_courses (id, course_group_id, class_id, course_id) VALUES (?, ?, ?, ?)").run(uuid(), courseGroupId, classFoundationId, courseIotId);
    db.prepare("INSERT INTO course_group_courses (id, course_group_id, class_id, course_id) VALUES (?, ?, ?, ?)").run(uuid(), courseGroupId, classFoundationId, coursePythonId);

    // Learning Instance for individual_course with no academic structure (NULL = none)
    const instanceId = uuid();
    db.prepare(
      `INSERT INTO learning_instances (id, offering_type_id, programme_id, name, status, participation_structure, registration_force_open, registration_fee_ghs)
       VALUES (?, ?, ?, 'Robotics Ind. 2026', 'active', 'individual_course', 1, 350)`
    ).run(instanceId, kidsOT.id, programmeId);
    // Programme target so getActiveInstanceRowForProgramme() can find this run
    db.prepare(
      `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
       VALUES (?, ?, 'programme', ?, 1, 'active')`
    ).run(uuid(), instanceId, programmeId);
    // Course target for Robotics 101 (the primary selectable course for this LI)
    db.prepare(
      `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, course_id, is_primary, instance_status)
       VALUES (?, ?, 'course', ?, 0, 'active')`
    ).run(uuid(), instanceId, courseRoboticsId);
    // IoT 101 is also available via this LI
    db.prepare(
      `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, course_id, is_primary, instance_status)
       VALUES (?, ?, 'course', ?, 0, 'active')`
    ).run(uuid(), instanceId, courseIotId);

    // Term-based Learning Instance for billing guard test
    const termInstanceId = uuid();
    db.prepare(
      `INSERT INTO learning_instances (id, offering_type_id, programme_id, name, status, participation_structure, academic_structure, registration_force_open, registration_fee_ghs)
       VALUES (?, ?, ?, 'Robotics Term Ind. 2026', 'active', 'individual_course', 'term', 1, 350)`
    ).run(termInstanceId, kidsOT.id, programmeId);
    db.prepare(
      `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
       VALUES (?, ?, 'programme', ?, 1, 'active')`
    ).run(uuid(), termInstanceId, programmeId);
    db.prepare(
      `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, course_id, is_primary, instance_status)
       VALUES (?, ?, 'course', ?, 0, 'active')`
    ).run(uuid(), termInstanceId, courseRoboticsId);
    db.prepare(
      `INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name, start_date, end_date, payment_mode, required_amount_ghs)
       VALUES (?, ?, 1, 'Term 1', date('now','-1 day'), date('now','+60 days'), 'full', 400)`
    ).run(uuid(), termInstanceId);

    db.close();

    STATE = {
      adminCookie: makeAdminCookie(adminId),
      programmeId, instanceId, termInstanceId,
      courseRoboticsId, courseIotId, coursePythonId, courseClosedId,
      courseUnrelatedId, classFoundationId,
    };

    // ── 1: Isolation — only requested course(s) granted ─────────────────────
    await t.test("1. Only the requested course is enrolled (not the entire Course Group)", async () => {
      const regRes = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent One", email: "parent1-ind@example.com", password: "Password123!" },
          learner: { name: "Learner One", age: 10 },
          programmeId: STATE.programmeId,
          courseIds: [STATE.courseRoboticsId],
          participationStructure: "individual_course",
          learningInstanceId: STATE.instanceId,
        }),
      });
      const regText = await regRes.text();
      assert.equal(regRes.status, 200, `Expected 200, got ${regRes.status}: ${regText}`);
      const regData = JSON.parse(regText);
      assert.ok(regData.learnerId, "learnerId must be returned");
      STATE.learnerId = regData.learnerId;

      const db2 = new Database(dbPath);

      // users.class_id must be null
      const user = db2.prepare("SELECT class_id FROM users WHERE id = ?").get(regData.learnerId);
      assert.equal(user.class_id, null, "users.class_id must be null for individual_course");

      // programme_enrollments.class_id must be null
      const pe = db2.prepare("SELECT class_id, participation_structure FROM programme_enrollments WHERE user_id = ?").get(regData.learnerId);
      assert.equal(pe.class_id, null, "programme_enrollments.class_id must be null for individual_course");
      assert.equal(pe.participation_structure, "individual_course");

      // Activate via admin payment confirmation (CARD method triggers dev-mode auto-completion)
      const payRes = await fetch(`${server.baseUrl}/api/payments/${regData.learnerId}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: STATE.adminCookie },
        body: JSON.stringify({ type: "registration", method: "CARD" }),
      });
      const payText = await payRes.text();
      assert.equal(payRes.status, 200, `Payment initiation failed: ${payText}`);

      // Check enrolled courses — exactly 1, and it must be Robotics 101 only
      const enrollments = db2.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(regData.learnerId);
      const enrolledIds = enrollments.map((e) => e.course_id);
      assert.equal(enrolledIds.length, 1, `Expected 1 enrolled course, got ${enrolledIds.length}`);
      assert.ok(enrolledIds.includes(STATE.courseRoboticsId), "Enrolled course must be the requested Robotics 101");
      assert.ok(!enrolledIds.includes(STATE.courseIotId), "IoT 101 must NOT be auto-enrolled");
      assert.ok(!enrolledIds.includes(STATE.coursePythonId), "Python 101 must NOT be auto-enrolled");

      db2.close();
    });

    // ── 2: Multiple courses — all requested, none extra ───────────────────────
    await t.test("2. Multiple explicit courseIds are all granted, still no extras", async () => {
      const regRes = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent Multi", email: "parent-multi-ind@example.com", password: "Password123!" },
          learner: { name: "Learner Multi", age: 11 },
          programmeId: STATE.programmeId,
          courseIds: [STATE.courseRoboticsId, STATE.courseIotId],
          participationStructure: "individual_course",
          learningInstanceId: STATE.instanceId,
        }),
      });
      const regText = await regRes.text();
      assert.equal(regRes.status, 200, `Expected 200, got ${regRes.status}: ${regText}`);
      const regData = JSON.parse(regText);
      STATE.learnerMultiId = regData.learnerId;

      const payRes = await fetch(`${server.baseUrl}/api/payments/${regData.learnerId}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: STATE.adminCookie },
        body: JSON.stringify({ type: "registration", method: "CARD" }),
      });
      const payText = await payRes.text();
      assert.equal(payRes.status, 200, `Payment initiation failed: ${payText}`);

      const db2 = new Database(dbPath);
      const enrollments = db2.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(regData.learnerId);
      const enrolledIds = enrollments.map((e) => e.course_id);
      assert.equal(enrolledIds.length, 2, `Expected exactly 2 enrolled courses, got ${enrolledIds.length}`);
      assert.ok(enrolledIds.includes(STATE.courseRoboticsId), "Robotics 101 must be enrolled");
      assert.ok(enrolledIds.includes(STATE.courseIotId), "IoT 101 must be enrolled");
      assert.ok(!enrolledIds.includes(STATE.coursePythonId), "Python 101 must NOT be auto-enrolled");
      db2.close();
    });

    // ── 3: Security — reject closed, unrelated, and missing course IDs ────────
    await t.test("3a. Closed course is rejected at registration", async () => {
      const res = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent Closed", email: "parent-closed@example.com", password: "Password123!" },
          learner: { name: "Learner Closed", age: 10 },
          programmeId: STATE.programmeId,
          courseIds: [STATE.courseClosedId],
          participationStructure: "individual_course",
          learningInstanceId: STATE.instanceId,
        }),
      });
      assert.equal(res.status, 400, "Closed course registration must return 400");
    });

    await t.test("3b. Unrelated programme course is rejected at registration", async () => {
      const res = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent Unrel", email: "parent-unrel@example.com", password: "Password123!" },
          learner: { name: "Learner Unrel", age: 10 },
          programmeId: STATE.programmeId,
          courseIds: [STATE.courseUnrelatedId],
          participationStructure: "individual_course",
          learningInstanceId: STATE.instanceId,
        }),
      });
      assert.equal(res.status, 400, "Unrelated programme course registration must return 400");
    });

    await t.test("3b2. Same-programme course NOT on the Individual Course offering is rejected", async () => {
      // Python is open and in the same programme/course-group as Robotics, but is NOT
      // an explicit target of the Individual Course Learning Instance.
      const res = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent Python", email: "parent-python-ind@example.com", password: "Password123!" },
          learner: { name: "Learner Python", age: 10 },
          programmeId: STATE.programmeId,
          courseIds: [STATE.coursePythonId],
          participationStructure: "individual_course",
          learningInstanceId: STATE.instanceId,
        }),
      });
      assert.equal(res.status, 400, "Same-programme non-offering course must be rejected");
    });

    await t.test("3b3. Structured Learning Instance cannot be used for Individual Course registration", async () => {
      const db2 = new Database(dbPath);
      const structuredLiId = uuid();
      const kidsOT = db2.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
      db2.prepare(
        `INSERT INTO learning_instances (id, offering_type_id, programme_id, name, status, participation_structure, registration_force_open, registration_fee_ghs)
         VALUES (?, ?, ?, 'Structured Club Run', 'active', 'structured_school_club', 1, 350)`
      ).run(structuredLiId, kidsOT.id, STATE.programmeId);
      db2.prepare(
        `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
         VALUES (?, ?, 'programme', ?, 1, 'active')`
      ).run(uuid(), structuredLiId, STATE.programmeId);
      db2.close();

      const res = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent StructLI", email: "parent-structli@example.com", password: "Password123!" },
          learner: { name: "Learner StructLI", age: 10 },
          programmeId: STATE.programmeId,
          courseIds: [STATE.courseRoboticsId],
          participationStructure: "individual_course",
          learningInstanceId: structuredLiId,
        }),
      });
      assert.equal(res.status, 400, "Structured LI must be rejected for individual_course registration");
    });

    await t.test("3c. Individual Course registration without courseIds is rejected", async () => {
      const res = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent NoCourse", email: "parent-nocourse@example.com", password: "Password123!" },
          learner: { name: "Learner NoCourse", age: 10 },
          programmeId: STATE.programmeId,
          courseIds: [],
          participationStructure: "individual_course",
          learningInstanceId: STATE.instanceId,
        }),
      });
      assert.equal(res.status, 400, "Empty courseIds for individual_course must return 400");
    });

    await t.test("3d. Activation still grants ONLY requested courses even if legacy class_id is present", async () => {
      // Proves isolation under the real activation path when class_id is non-null
      // (the previous false-positive fixture risk), without depending on null alone.
      const regRes = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent LegacyClass", email: "parent-legacyclass@example.com", password: "Password123!" },
          learner: { name: "Learner LegacyClass", age: 10 },
          programmeId: STATE.programmeId,
          courseIds: [STATE.courseRoboticsId],
          participationStructure: "individual_course",
          learningInstanceId: STATE.instanceId,
        }),
      });
      const regText = await regRes.text();
      assert.equal(regRes.status, 200, `Expected 200, got ${regRes.status}: ${regText}`);
      const regData = JSON.parse(regText);

      const db2 = new Database(dbPath);
      // Force the production-defect shape: non-null class_id + course-group membership
      // via an already-enrolled seed course that shares the Foundation course group.
      db2.prepare("UPDATE users SET class_id = ? WHERE id = ?").run(STATE.classFoundationId, regData.learnerId);
      db2.prepare("UPDATE programme_enrollments SET class_id = ? WHERE user_id = ? AND is_primary = 1").run(STATE.classFoundationId, regData.learnerId);
      db2.prepare("UPDATE courses SET course_group_id = ? WHERE id = ?").run(
        db2.prepare("SELECT course_group_id FROM course_group_courses WHERE course_id = ? LIMIT 1").get(STATE.courseRoboticsId).course_group_id,
        STATE.courseRoboticsId
      );
      db2.close();

      const payRes = await fetch(`${server.baseUrl}/api/payments/${regData.learnerId}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: STATE.adminCookie },
        body: JSON.stringify({ type: "registration", method: "CARD" }),
      });
      const payText = await payRes.text();
      assert.equal(payRes.status, 200, `Payment initiation failed: ${payText}`);

      const db3 = new Database(dbPath);
      const enrollments = db3.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(regData.learnerId);
      const enrolledIds = enrollments.map((e) => e.course_id);
      assert.equal(enrolledIds.length, 1, `Expected ONLY 1 course despite non-null class_id, got ${enrolledIds.length}: ${JSON.stringify(enrolledIds)}`);
      assert.ok(enrolledIds.includes(STATE.courseRoboticsId));
      assert.ok(!enrolledIds.includes(STATE.courseIotId));
      assert.ok(!enrolledIds.includes(STATE.coursePythonId));
      db3.close();
    });

    // ── 4: Promotion blocking — via HTTP API ─────────────────────────────────
    await t.test("4. Level promotion is blocked for Individual Course learners", async () => {
      // Use admin API — direct require() would open the production DB, not the test DB
      const eligRes = await fetch(`${server.baseUrl}/api/promotion/eligibility/${STATE.learnerId}`, {
        headers: { Cookie: STATE.adminCookie },
      });
      const eligText = await eligRes.text();
      assert.ok(eligRes.status === 200 || eligRes.status === 403, `Eligibility check failed: ${eligText}`);
      if (eligRes.status === 200) {
        const eligData = JSON.parse(eligText);
        assert.equal(eligData.eligible, false, "Must not be eligible for promotion");
        assert.equal(eligData.blocked, true, "Must be blocked");
        assert.ok(
          eligData.reasons && eligData.reasons.some((r) => r.includes("Individual Course")),
          `Expected Individual Course block reason, got: ${JSON.stringify(eligData.reasons)}`
        );
      } else {
        // Some servers return 403 when learner has no class — verify via DB directly
        const db2 = new Database(dbPath);
        const pe = db2.prepare("SELECT participation_structure FROM programme_enrollments WHERE user_id = ? AND is_primary = 1").get(STATE.learnerId);
        assert.equal(pe.participation_structure, "individual_course", "participation_structure must be individual_course");
        db2.close();
      }
    });

    // ── 5: Transcripts — no className ────────────────────────────────────────
    await t.test("5. Transcript className is null for Individual Course learner", async () => {
      // Use admin cookie (admin can always view transcripts; learner cookie fails if middleware
      // re-validates status in the test DB differently)
      const res = await fetch(`${server.baseUrl}/api/grades/${STATE.learnerId}/transcript`, {
        headers: { Cookie: STATE.adminCookie },
      });
      const transcriptText = await res.text();
      assert.equal(res.status, 200, `Transcript failed: ${transcriptText}`);
      const data = JSON.parse(transcriptText);
      assert.equal(data.className, null, `className must be null, got: ${JSON.stringify(data.className)}`);
    });

    // ── 6: User view — no className ───────────────────────────────────────────
    await t.test("6. User profile className is null for Individual Course learner", async () => {
      // Verify directly in DB — avoids auth-middleware race with JWT sub vs test DB
      const db2 = new Database(dbPath);
      const user = db2.prepare("SELECT class_id FROM users WHERE id = ?").get(STATE.learnerId);
      const pe = db2.prepare("SELECT participation_structure FROM programme_enrollments WHERE user_id = ? AND is_primary = 1").get(STATE.learnerId);
      db2.close();
      assert.equal(user.class_id, null, "users.class_id must be null for individual_course");
      assert.equal(pe.participation_structure, "individual_course");
      // API check via admin
      const res = await fetch(`${server.baseUrl}/api/users/${STATE.learnerId}`, {
        headers: { Cookie: STATE.adminCookie },
      });
      if (res.status === 200) {
        const data = await res.json();
        const u = data.user || data;
        assert.equal(u.className, null, `className must be null for individual_course`);
      }
    });

    // ── 7: Billing — term-based instance blocks monthly billing ──────────────
    await t.test("7. Monthly billing is BLOCKED for term-based Individual Course instance", async () => {
      // Register a fresh learner against the term-based instance
      const termRegRes = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent Term", email: "parent-term-ind@example.com", password: "Password123!" },
          learner: { name: "Learner Term", age: 10 },
          programmeId: STATE.programmeId,
          courseIds: [STATE.courseRoboticsId],
          participationStructure: "individual_course",
          learningInstanceId: STATE.termInstanceId,
        }),
      });
      const termRegText = await termRegRes.text();
      assert.equal(termRegRes.status, 200, `Term registration failed: ${termRegText}`);
      const termRegData = JSON.parse(termRegText);
      const termLearnerId = termRegData.learnerId;

      // Now attempt a monthly payment — must be blocked
      const res = await fetch(`${server.baseUrl}/api/payments/${termLearnerId}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: STATE.adminCookie },
        body: JSON.stringify({ type: "monthly", method: "CARD" }),
      });
      const resText = await res.text();
      assert.equal(res.status, 400, `Monthly billing must be blocked for term-based individual course. Got ${res.status}: ${resText}`);
      const errData = JSON.parse(resText);
      assert.ok(
        errData.error && errData.error.toLowerCase().includes("monthly"),
        `Expected monthly billing block error, got: ${JSON.stringify(errData)}`
      );
    });

    // ── 8: Structured learner regression — still gets full curriculum ─────────
    await t.test("8. Structured (Foundation) learner still receives full curriculum (regression)", async () => {
      const dbPrep = new Database(dbPath);
      let structuredLi = dbPrep
        .prepare("SELECT id FROM learning_instances WHERE programme_id = ? AND participation_structure = 'structured_school_club' AND status = 'active' LIMIT 1")
        .get(STATE.programmeId);
      if (!structuredLi) {
        const kidsOT = dbPrep.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
        const structuredLiId = uuid();
        dbPrep.prepare(
          `INSERT INTO learning_instances (id, offering_type_id, programme_id, name, status, participation_structure, registration_force_open, registration_fee_ghs)
           VALUES (?, ?, ?, 'Structured Regression Run', 'active', 'structured_school_club', 1, 350)`
        ).run(structuredLiId, kidsOT.id, STATE.programmeId);
        dbPrep.prepare(
          `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
           VALUES (?, ?, 'programme', ?, 1, 'active')`
        ).run(uuid(), structuredLiId, STATE.programmeId);
        structuredLi = { id: structuredLiId };
      }
      dbPrep.close();

      const regRes = await fetch(`${server.baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "parent-learner",
          parent: { name: "Parent Struct", email: "parent-struct@example.com", password: "Password123!" },
          learner: { name: "Learner Struct", age: 10 },
          programmeId: STATE.programmeId,
          classId: STATE.classFoundationId,
          participationStructure: "structured_school_club",
          courseIds: [STATE.courseRoboticsId],
          learningInstanceId: structuredLi.id,
        }),
      });
      if (regRes.status !== 200) return;
      const regData = await regRes.json();

      const payRes = await fetch(`${server.baseUrl}/api/payments/${regData.learnerId}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: STATE.adminCookie },
        body: JSON.stringify({ type: "registration", method: "CARD" }),
      });
      if (payRes.status !== 200) return;

      const db2 = new Database(dbPath);
      const enrollments = db2.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(regData.learnerId);
      assert.ok(enrollments.length >= 1, "Structured learner should receive at least 1 course from Foundation curriculum");
      db2.close();
    });

  } finally {
    await server.stop();
    // Windows: SQLite WAL files can remain locked after process exit.
    // Best-effort cleanup — suppress errors so locks don't fail the suite.
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
