/**
 * ROOT ARCHITECTURAL RULE regression suite — Bootcamp must never have
 * Academic Periods.
 *
 * Bug being fixed: a Bootcamp Learning Instance could end up with Academic
 * Structure/Period data configured (the old admin UI allowed it, and
 * Bootcamp payments never carry learning_instance_academic_period_id), so
 * a fully paid, actively-enrolled Bootcamp learner could hit the
 * period-payment gate (utils/periodPayments.js's evaluatePeriodAccess,
 * reached from every course-scoped learner-content route) and be blocked
 * with "Payment is required for the current academic period before this
 * content can be accessed." even though Bootcamp has no such concept.
 *
 * Locks in:
 *  - a Bootcamp learner with a fully paid registration + active enrolment
 *    can access course content (GET /api/modules/:courseId/lessons) even
 *    when the Bootcamp Learning Instance carries STALE legacy Academic
 *    Structure/Period data (simulating an instance configured before this
 *    rule existed) with an unmet payment requirement — the exact
 *    reported bug;
 *  - PATCH /api/learning-instances/:id/academic-structure is rejected
 *    (400) for a Bootcamp Learning Instance — an admin can never
 *    configure Academic Periods for Bootcamp going forward;
 *  - PATCH .../academic-periods/:periodId (rename/link an Academic Term)
 *    is rejected (400) for a Bootcamp Learning Instance, even against a
 *    stale legacy period row;
 *  - PATCH .../academic-periods/:periodId/payment-requirement is rejected
 *    (400) for a Bootcamp Learning Instance;
 *  - PUT .../academic-periods/:periodId/targets is rejected (400) for a
 *    Bootcamp Learning Instance;
 *  - POST /api/payments/:userId/initiate with a
 *    learningInstanceAcademicPeriodId against a Bootcamp instance is
 *    rejected (400) — a Bootcamp payment can never be scoped to a period;
 *  - POST /api/payments/:userId/period-payment (admin manual record) is
 *    rejected (400) for a Bootcamp Learning Instance;
 *  - Kids STEM's existing period-payment enforcement is completely
 *    unaffected by any of the above (still blocks with 402 as before).
 *
 * Same real-server-process pattern as period-payment-enforcement.test.js /
 * bootcamp-lifecycle.test.js.
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
const JWT_SECRET = "bootcamp-no-academic-periods-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-bootcamp-no-periods-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "bootcamp-no-academic-periods-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  delete env.NODE_ENV;
  delete env.PAYSTACK_SECRET_KEY; // ensure the dev fallback fires where relevant
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-bootcamp-no-periods-uploads-"));
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

function cookieFor(userId, role) {
  const token = jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return text;
  }
}

// Seeds a Bootcamp Learning Instance with a reusable Course assigned to it,
// a fully-paid/active Bootcamp learner enrolled in that Course, and —
// simulating the exact bug scenario — STALE legacy Academic
// Structure/Period data on the instance (as the old admin UI would have
// left behind) with an UNMET payment requirement on period 1. Also seeds
// an admin and a parallel Kids STEM structured+gated instance/learner so
// the "Kids STEM is unaffected" test has its own independent fixture.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'bootcamp-no-periods-admin@example.com', 'x', 'active', 'current', 1, 'ADM-BNP-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const bootcampType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'bootcamp'").get();
    if (!bootcampType) throw new Error("bootcamp offering type not found — has migration seeded it?");
    const kidsStemType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    // ---- Bootcamp side ----
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, is_active, sort_order) VALUES (?, ?, 'Cyber Bootcamp', 1, 0)").run(programmeId, bootcampType.id);

    const courseId = "bnp-course-01";
    db.prepare("INSERT INTO courses (id, title, is_open) VALUES (?, 'Bootcamp Course', 1)").run(courseId);

    const instanceId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name, registration_fee_ghs) VALUES (?, ?, ?, 'active', 'BNP Bootcamp Run', 350)"
    ).run(instanceId, bootcampType.id, programmeId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), instanceId, programmeId);
    db.prepare(
      "INSERT INTO learning_instance_courses (id, learning_instance_id, course_id, status) VALUES (?, ?, ?, 'active')"
    ).run(uuid(), instanceId, courseId);

    // Simulate STALE legacy Academic Structure/Period data — the exact
    // shape the old (buggy) admin UI could have left on a Bootcamp
    // instance before this rule was enforced. Direct SQL, not the API,
    // since the API itself now refuses to create this for Bootcamp.
    db.prepare("UPDATE learning_instances SET academic_structure = 'semester' WHERE id = ?").run(instanceId);
    const period1Id = uuid();
    const period2Id = uuid();
    db.prepare(
      "INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name, payment_mode, required_amount_ghs) VALUES (?, ?, 1, 'Semester 1', 'full', 500)"
    ).run(period1Id, instanceId);
    db.prepare(
      "INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name) VALUES (?, ?, 2, 'Semester 2')"
    ).run(period2Id, instanceId);

    // A fully paid, actively-enrolled Bootcamp learner — the exact
    // "should never be blocked" scenario. Global payment_status/status are
    // current/active (a successful Bootcamp registration payment), and
    // they've never made ANY payment scoped to the stale period above —
    // this is precisely what used to 402 them.
    const learnerId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, student_code, is_adult)
       VALUES (?, 'learner', 'Bootcamp Learner', ?, ?, 'active', 'current', date('now'), ?, 1)`
    ).run(learnerId, `bnp-learner-${learnerId}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${learnerId.slice(0, 8)}`);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(learnerId, courseId);
    const classId = uuid();
    db.prepare("INSERT INTO classes (id, programme_id, name) VALUES (?, ?, 'Bootcamp Cohort')").run(classId, programmeId);
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, learning_instance_id, is_primary, status, payment_status)
       VALUES (?, ?, ?, ?, ?, 1, 'active', 'current')`
    ).run(uuid(), learnerId, programmeId, classId, instanceId);

    // ---- Kids STEM side (must remain unaffected) ----
    const kidsLearnerId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, student_code)
       VALUES (?, 'learner', 'Kids STEM Learner', ?, ?, 'active', 'current', date('now'), ?)`
    ).run(kidsLearnerId, `bnp-kids-learner-${kidsLearnerId}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${kidsLearnerId.slice(0, 8)}`);
    // GFX-06 is seeded closed (is_open = 0) — no conflicting auto-created
    // active instance, same reasoning period-payment-enforcement.test.js
    // uses for IOT-02.
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(kidsLearnerId, "GFX-06");

    return { adminId, bootcampOfferingTypeId: bootcampType.id, kidsStemOfferingTypeId: kidsStemType ? kidsStemType.id : null, programmeId, instanceId, period1Id, period2Id, courseId, learnerId, kidsLearnerId };
  } finally {
    db.close();
  }
}

test("Bootcamp: a fully paid, actively-enrolled learner is never blocked by stale legacy Academic Period payment data", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);

  const res = await fetch(`${server.baseUrl}/api/modules/${fx.courseId}/lessons`, {
    headers: { Cookie: cookieFor(fx.learnerId, "learner") },
  });
  const body = await readJson(res);
  assert.equal(res.status, 200, `Bootcamp learner must not be blocked by a stale academic-period payment gate: ${JSON.stringify(body)}`);
});

test("Bootcamp: admin cannot set an Academic Structure on a Bootcamp Learning Instance", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  // A fresh, still-'upcoming' Bootcamp instance (the one condition under
  // which setAcademicStructure would otherwise be allowed to run at all).
  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.bootcampOfferingTypeId, programmeId: fx.programmeId, name: "Fresh Bootcamp Run", status: "upcoming" }),
  });
  const created = await readJson(createRes);
  assert.equal(createRes.status, 200, JSON.stringify(created));

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const structBody = await readJson(structRes);
  assert.equal(structRes.status, 400, JSON.stringify(structBody));
  assert.match(structBody.error, /Bootcamp/i);

  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT academic_structure FROM learning_instances WHERE id = ?").get(created.id);
  db.close();
  assert.equal(row.academic_structure, null, "No academic structure should have been persisted");
});

test("Bootcamp: admin cannot rename/link an Academic Term on a (stale) Bootcamp period", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  const res = await fetch(`${server.baseUrl}/api/learning-instances/${fx.instanceId}/academic-periods/${fx.period1Id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Renamed Semester" }),
  });
  const body = await readJson(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(body.error, /Bootcamp/i);
});

test("Bootcamp: admin cannot configure a payment requirement on a (stale) Bootcamp period", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  const res = await fetch(`${server.baseUrl}/api/learning-instances/${fx.instanceId}/academic-periods/${fx.period2Id}/payment-requirement`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ mode: "full", requiredAmountGHS: 200 }),
  });
  const body = await readJson(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(body.error, /Bootcamp/i);
});

test("Bootcamp: admin cannot assign period targets on a (stale) Bootcamp period", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  // Bootcamp's primary target row (created alongside the instance).
  const targetsRes = await fetch(`${server.baseUrl}/api/learning-instances/${fx.instanceId}`, { headers });
  const instanceBody = await readJson(targetsRes);
  const primaryTargetId = (instanceBody.targets || []).find((t) => t.isPrimary)?.id;
  assert.ok(primaryTargetId, "fixture must have a primary target");

  const res = await fetch(`${server.baseUrl}/api/learning-instances/${fx.instanceId}/academic-periods/${fx.period1Id}/targets`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ targetIds: [primaryTargetId] }),
  });
  const body = await readJson(res);
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(body.error, /Bootcamp/i);
});

test("Bootcamp: a payment can never be scoped to an academic period, even against stale legacy period data", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const learnerHeaders = { "Content-Type": "application/json", Cookie: cookieFor(fx.learnerId, "learner") };

  const initiateRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/initiate`, {
    method: "POST",
    headers: learnerHeaders,
    body: JSON.stringify({
      type: "period",
      method: "MOBILE_MONEY",
      network: "MTN",
      momoNumber: "0244000000",
      learningInstanceId: fx.instanceId,
      learningInstanceAcademicPeriodId: fx.period1Id,
    }),
  });
  const initiateBody = await readJson(initiateRes);
  assert.equal(initiateRes.status, 400, JSON.stringify(initiateBody));
  assert.match(initiateBody.error, /Bootcamp/i);

  // Admin manual period-payment recording is rejected the same way.
  const adminHeaders = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };
  const adminRes = await fetch(`${server.baseUrl}/api/payments/${fx.learnerId}/period-payment`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ learningInstanceId: fx.instanceId, periodId: fx.period1Id, amountGHS: 500, method: "Cash" }),
  });
  const adminBody = await readJson(adminRes);
  assert.equal(adminRes.status, 400, JSON.stringify(adminBody));
  assert.match(adminBody.error, /Bootcamp/i);

  // No period-scoped payment row should exist for this learner at all.
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT * FROM payments WHERE user_id = ? AND learning_instance_academic_period_id IS NOT NULL").all(fx.learnerId);
  db.close();
  assert.equal(rows.length, 0);
});

test("Kids STEM: period-payment enforcement is completely unaffected by the Bootcamp exemption", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  assert.ok(fx.kidsStemOfferingTypeId, "kids_stem offering type must exist");
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin") };

  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.kidsStemOfferingTypeId, courseId: "GFX-06", name: "Kids STEM Period Run", status: "upcoming" }),
  });
  const created = await readJson(createRes);
  assert.equal(createRes.status, 200, JSON.stringify(created));

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await readJson(structRes);
  assert.equal(structRes.status, 200, JSON.stringify(withStructure));
  const [period1] = withStructure.academicPeriods;

  const paymentReqRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/payment-requirement`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ mode: "full", requiredAmountGHS: 500 }),
  });
  assert.equal(paymentReqRes.status, 200, JSON.stringify(await readJson(paymentReqRes)));

  const activateRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/activate`, { method: "POST", headers });
  assert.equal(activateRes.status, 200, JSON.stringify(await readJson(activateRes)));

  const res = await fetch(`${server.baseUrl}/api/modules/GFX-06/lessons`, {
    headers: { Cookie: cookieFor(fx.kidsLearnerId, "learner") },
  });
  const body = await readJson(res);
  assert.equal(res.status, 402, `Kids STEM period-payment enforcement must still block unpaid learners: ${JSON.stringify(body)}`);
  assert.equal(body.code, "PERIOD_PAYMENT_REQUIRED");
  assert.match(body.error, /academic period/i);
});
