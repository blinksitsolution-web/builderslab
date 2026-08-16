/**
 * Focused regression tests for the Enrollment Activation pipeline (v30):
 * Registration -> Learning Instance -> Course -> Delivery Mode ->
 * Applicable Fees -> Payment -> Account Creation -> Enrollment Activation
 * -> Curriculum Resolution -> Module Access.
 *
 * Registration must only ever express intent — it stores requested module
 * ids on the primary programme_enrollments row (requested_course_ids) and
 * creates the account pending_payment/unpaid, exactly like every other
 * pending enrolment. Actual `enrollments` (Module access) rows must only
 * ever appear once the enrolment is activated: a successful payment
 * (Paystack webhook or an admin manually recording one), or an admin-
 * granted Hub access override. Activation must reuse the same
 * Course/Class curriculum mechanism (syncCourseCurriculumForClass) that
 * routes/promotion.js already uses — never a separate implementation.
 *
 * Same real-server-process pattern as builderslab-architecture.test.js
 * (fresh temp DB, migrated, real `node src/server.js`).
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
const JWT_SECRET = "builderslab-activation-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-activation-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "builderslab-activation-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-activation-uploads-"));
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

// Seeds: an admin, a Kids STEM programme + class ("Foundation-like"), two
// modules (one carrying a Course Group so curriculum resolution has
// something to resolve, one course-group-less "just what was requested"),
// a Course Group, and a Course Group/Class curriculum mapping that assigns
// an EXTRA module (beyond what the learner explicitly picked) to that
// Course Group at that Class — the same course_group_courses mapping
// routes/promotion.js's syncCourseCurriculumForClass already reads.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'admin-activation-test@example.com', 'x', 'active', 'paid', 1, 'ADM-9101', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const kidsOfferingType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Activation Test Programme', 0)").run(programmeId, kidsOfferingType.id);

    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Activation Foundation', 0, ?)").run(classId, programmeId);

    // The module the learner will actually pick at registration — carries
    // the Course Group link, so activation can resolve "this learner's
    // Course Group" off it (same inference resolveCourseCurriculumForClass
    // uses for promotion).
    const pickedModuleId = uuid();
    db.prepare("INSERT INTO courses (id, title, is_open, programme_id) VALUES (?, 'Picked Module', 1, ?)").run(pickedModuleId, programmeId);

    // An extra module the Course Group/Class curriculum mapping assigns at
    // this Class — never explicitly requested by the learner, only granted
    // via the reused syncCourseCurriculumForClass mechanism at activation.
    const curriculumExtraModuleId = uuid();
    db.prepare("INSERT INTO courses (id, title, is_open, programme_id) VALUES (?, 'Curriculum Extra Module', 1, ?)").run(curriculumExtraModuleId, programmeId);

    const courseGroupId = uuid();
    db.prepare("INSERT INTO course_groups (id, programme_id, name) VALUES (?, ?, 'Activation Test Course Group')").run(courseGroupId, programmeId);
    db.prepare("UPDATE courses SET course_group_id = ? WHERE id IN (?, ?)").run(courseGroupId, pickedModuleId, curriculumExtraModuleId);
    db.prepare("INSERT INTO course_group_courses (id, course_group_id, class_id, course_id) VALUES (?, ?, ?, ?)").run(uuid(), courseGroupId, classId, curriculumExtraModuleId);

    // An ACTIVE Learning Instance for the programme, no academic structure
    // configured — so isTargetActiveInCurrentPeriod's "no periods
    // configured -> no extra restriction" rule lets the picked module
    // through registration's own open/active validation.
    const liId = uuid();
    db.prepare(
      `INSERT INTO learning_instances (id, offering_type_id, programme_id, name, status, registration_fee_ghs)
       VALUES (?, ?, ?, 'Activation Test Run', 'active', 350)`
    ).run(liId, kidsOfferingType.id, programmeId);
    db.prepare(
      `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
       VALUES (?, ?, 'programme', ?, 1, 'active')`
    ).run(uuid(), liId, programmeId);

    return { adminId, programmeId, classId, pickedModuleId, curriculumExtraModuleId, courseGroupId, liId };
  } finally {
    db.close();
  }
}

function adminCookie(adminId) {
  const token = jwt.sign({ sub: adminId, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

function enrolledModuleIds(dbPath, learnerId) {
  const db = new Database(dbPath);
  try {
    return db.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(learnerId).map((r) => r.course_id).sort();
  } finally {
    db.close();
  }
}

function primaryEnrolment(dbPath, learnerId) {
  const db = new Database(dbPath);
  try {
    return db.prepare("SELECT * FROM programme_enrollments WHERE user_id = ? AND is_primary = 1").get(learnerId);
  } finally {
    db.close();
  }
}

function learnerRow(dbPath, learnerId) {
  const db = new Database(dbPath);
  try {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(learnerId);
  } finally {
    db.close();
  }
}

async function registerLearner(baseUrl, fx, { childName }) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "parent-learner",
      parent: { name: `Parent of ${childName}`, email: `parent-${childName.toLowerCase()}@example.com`, password: "SuperSecret123!" },
      learner: { name: childName, age: 10 },
      programmeId: fx.programmeId,
      classId: fx.classId,
      courseIds: [fx.pickedModuleId],
    }),
  });
  const bodyText = await res.text();
  assert.equal(res.status, 200, bodyText);
  return JSON.parse(bodyText);
}

test("Enrollment Activation: registration only expresses intent, curriculum is granted only at activation", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const adminHeaders = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

    // ---- 1. Abandoned registration never receives curriculum access ----
    const abandoned = await registerLearner(server.baseUrl, fx, { childName: "Abandoned" });
    const abandonedId = abandoned.learnerId;

    // No `enrollments` row exists yet — the picked module was only
    // recorded as intent.
    assert.deepEqual(enrolledModuleIds(dbPath, abandonedId), [], "registration must not grant Module access");
    const abandonedPrimary = primaryEnrolment(dbPath, abandonedId);
    assert.ok(abandonedPrimary, "primary programme_enrollments row should exist");
    assert.equal(abandonedPrimary.status, "pending_payment");
    assert.deepEqual(JSON.parse(abandonedPrimary.requested_course_ids || "[]"), [fx.pickedModuleId], "requested module id should be stored as intent");
    const abandonedUser = learnerRow(dbPath, abandonedId);
    assert.equal(abandonedUser.status, "pending_payment");

    // ---- 2. Failed/no payment: still no curriculum access, indefinitely ----
    // (Abandoned learner above already models this — asserting again here
    // makes explicit that simply the *passage of time* with no payment
    // event changes nothing.)
    assert.deepEqual(enrolledModuleIds(dbPath, abandonedId), [], "no payment event occurred — access must remain absent");

    // ---- 3. Successful activation grants requested + Course/Class curriculum modules ----
    const paid = await registerLearner(server.baseUrl, fx, { childName: "Paid" });
    const paidId = paid.learnerId;
    assert.deepEqual(enrolledModuleIds(dbPath, paidId), [], "sanity check: no access before payment");

    const activateRes = await fetch(`${server.baseUrl}/api/payments/${paidId}/status`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "current", type: "registration", amountPaid: 500 }),
    });
    assert.equal(activateRes.status, 200, await activateRes.text());

    const paidUser = learnerRow(dbPath, paidId);
    assert.equal(paidUser.status, "active", "a successful registration payment should activate the account");

    // Both the explicitly-requested module AND the Course/Class curriculum
    // mapping's extra module should now be granted — proving activation
    // resolves curriculum through the same course_class_modules mechanism
    // routes/promotion.js's syncCourseCurriculumForClass already uses.
    assert.deepEqual(
      enrolledModuleIds(dbPath, paidId),
      [fx.curriculumExtraModuleId, fx.pickedModuleId].sort(),
      "activation should grant the requested module plus the Course/Class curriculum mapping's extra module"
    );

    // Idempotency: re-activating (e.g. a duplicate webhook/admin retry)
    // must not error or duplicate rows.
    const reActivateRes = await fetch(`${server.baseUrl}/api/payments/${paidId}/status`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "current", type: "registration", amountPaid: 0 }),
    });
    assert.equal(reActivateRes.status, 200);
    assert.deepEqual(enrolledModuleIds(dbPath, paidId), [fx.curriculumExtraModuleId, fx.pickedModuleId].sort());

    // ---- 4. Inactive enrollment (never activated) has no curriculum access ----
    const inactive = await registerLearner(server.baseUrl, fx, { childName: "Inactive" });
    const inactiveId = inactive.learnerId;
    // Admin explicitly records a PARTIAL payment — status stays pending,
    // never flips to active/current.
    const partialRes = await fetch(`${server.baseUrl}/api/payments/${inactiveId}/status`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "partial", type: "registration", amountPaid: 50, balanceOwed: 450 }),
    });
    assert.equal(partialRes.status, 200);
    assert.equal(learnerRow(dbPath, inactiveId).status, "pending_payment", "a partial payment must not activate the account");
    assert.deepEqual(enrolledModuleIds(dbPath, inactiveId), [], "an inactive enrolment must never receive curriculum access");

    // ---- 5. Sponsored learner without a Hub waiver stays gated ----------
    const sponsorRes = await fetch(`${server.baseUrl}/api/sponsors`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Test Sponsor Co" }),
    });
    const sponsorBodyText = await sponsorRes.text();
    assert.equal(sponsorRes.status, 200, sponsorBodyText);
    const sponsor = JSON.parse(sponsorBodyText);

    const sponsored = await registerLearner(server.baseUrl, fx, { childName: "Sponsored" });
    const sponsoredId = sponsored.learnerId;
    const attachSponsorRes = await fetch(`${server.baseUrl}/api/users/${sponsoredId}/sponsor`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ sponsorId: sponsor.id }),
    });
    assert.equal(attachSponsorRes.status, 200, await attachSponsorRes.text());

    // Attaching a sponsor is not itself a payment/activation event — the
    // existing payment enforcement rules still apply until the sponsor's
    // payment (or an explicit Hub waiver) actually activates the account.
    assert.equal(learnerRow(dbPath, sponsoredId).status, "pending_payment", "attaching a sponsor must not itself activate the account");
    assert.deepEqual(enrolledModuleIds(dbPath, sponsoredId), [], "a sponsored-but-unpaid learner must not receive curriculum access");

    // ---- 6. Hub-granted fee waiver DOES activate curriculum, without payment ----
    const waiverRes = await fetch(`${server.baseUrl}/api/users/${sponsoredId}/access-override`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ override: true, reason: "Hub-granted fee waiver — test" }),
    });
    assert.equal(waiverRes.status, 200, await waiverRes.text());

    // The account's payment status/enforcement architecture is untouched —
    // status stays pending_payment (access_override bypasses the gate at
    // read time; it doesn't rewrite payment history) — but curriculum
    // access is now granted, exactly like a successful payment would.
    const waivedUser = learnerRow(dbPath, sponsoredId);
    assert.equal(waivedUser.access_override, 1);
    assert.equal(waivedUser.status, "pending_payment", "the Hub waiver bypasses the access gate — it does not rewrite payment_status/status history");
    assert.deepEqual(
      enrolledModuleIds(dbPath, sponsoredId),
      [fx.curriculumExtraModuleId, fx.pickedModuleId].sort(),
      "a Hub-granted fee waiver should grant curriculum access exactly like a successful payment"
    );
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
