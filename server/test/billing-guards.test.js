/**
 * Billing guard regression tests — server-side monthly payment blocking for
 * term/semester Learning Instances and defaulter reporting that respects
 * billing model (monthly vs period-based).
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
const JWT_SECRET = "billing-guards-test-secret-not-for-real-use";
const MONTHLY_BLOCKED =
  "Monthly billing is not available for this Learning Instance. Please use the applicable academic-period payment.";

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

async function waitForReady(baseUrl, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function prepareDb() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-billing-guards-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "billing-guards-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  delete env.NODE_ENV;
  delete env.PAYSTACK_SECRET_KEY;
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-billing-guards-uploads-"));
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

function countMonthlyPayments(dbPath, userId) {
  const db = new Database(dbPath);
  try {
    return db.prepare("SELECT COUNT(*) as n FROM payments WHERE user_id = ? AND type = 'monthly'").get(userId).n;
  } finally {
    db.close();
  }
}

function seedBase(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Billing Admin', 'admin-billing-guards@example.com', 'x', 'active', 'paid', 1, 'ADM-BG-01', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const kidsOfferingType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Billing Guard Programme', 0)").run(
      programmeId,
      kidsOfferingType.id
    );

    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Foundation', 1, ?)").run(classId, programmeId);

    return { adminId, programmeId, classId, kidsOfferingTypeId: kidsOfferingType.id };
  } finally {
    db.close();
  }
}

function seedLearnerOnInstance(dbPath, { adminId, programmeId, classId, instanceId, academicStructure, paymentStatus = "current" }) {
  const db = new Database(dbPath);
  try {
    const userId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, class_id) VALUES (?, 'learner', 'Billing Learner', ?, 'x', 'active', ?, 0, ?, date('now'), ?)"
    ).run(userId, `learner-${userId}@example.com`, paymentStatus, `STU-${userId.slice(0, 6).toUpperCase()}`, classId);

    db.prepare(
      "INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, learning_instance_id, participation_structure, is_primary, status, payment_status) VALUES (?, ?, ?, ?, ?, 'structured_school_club', 1, 'active', ?)"
    ).run(uuid(), userId, programmeId, classId, instanceId, paymentStatus);

    if (academicStructure) {
      db.prepare("UPDATE learning_instances SET academic_structure = ? WHERE id = ?").run(academicStructure, instanceId);
    }

    return { userId, adminId };
  } finally {
    db.close();
  }
}

function recordPeriodPayment(dbPath, userId, instanceId, periodId, amount) {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, method, status, paystack_ref, date, learning_instance_id, learning_instance_academic_period_id)
       VALUES (?, ?, ?, 'period_payment', 'Admin: Cash', 'successful', ?, datetime('now'), ?, ?)`
    ).run(uuid(), userId, amount, `ADMIN-${uuid()}`, instanceId, periodId);
  } finally {
    db.close();
  }
}

function createLearningInstance(dbPath, { kidsOfferingTypeId, programmeId, academicStructure = null, name = "Billing Guard Run" }) {
  const db = new Database(dbPath);
  try {
    const instanceId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, name, status, academic_structure, participation_structure, registration_fee_ghs) VALUES (?, ?, ?, ?, 'active', ?, 'structured_school_club', 350)"
    ).run(instanceId, kidsOfferingTypeId, programmeId, name, academicStructure);

    const targetId = uuid();
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(targetId, instanceId, programmeId);

    if (academicStructure === "term") {
      const p1 = uuid();
      const p2 = uuid();
      db.prepare(
        "INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name, start_date, end_date, payment_mode, required_amount_ghs) VALUES (?, ?, 1, 'Term 1', date('now','-1 day'), date('now','+60 days'), 'full', 500)"
      ).run(p1, instanceId);
      db.prepare(
        "INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name, start_date, end_date, payment_mode, required_amount_ghs) VALUES (?, ?, 2, 'Term 2', date('now','+61 days'), date('now','+120 days'), 'full', 500)"
      ).run(p2, instanceId);
      db.prepare("INSERT INTO learning_instance_period_targets (id, learning_instance_academic_period_id, learning_instance_target_id) VALUES (?, ?, ?)").run(
        uuid(),
        p1,
        targetId
      );
      db.prepare("INSERT INTO learning_instance_period_targets (id, learning_instance_academic_period_id, learning_instance_target_id) VALUES (?, ?, ?)").run(
        uuid(),
        p2,
        targetId
      );
      return { instanceId, period1Id: p1, period2Id: p2 };
    }

    if (academicStructure === "semester") {
      const p1 = uuid();
      const p2 = uuid();
      db.prepare(
        "INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name, start_date, end_date, payment_mode, required_amount_ghs) VALUES (?, ?, 1, 'Semester 1', date('now','-1 day'), date('now','+90 days'), 'full', 600)"
      ).run(p1, instanceId);
      db.prepare(
        "INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name, start_date, end_date, payment_mode, required_amount_ghs) VALUES (?, ?, 2, 'Semester 2', date('now','+91 days'), date('now','+180 days'), 'full', 600)"
      ).run(p2, instanceId);
      db.prepare("INSERT INTO learning_instance_period_targets (id, learning_instance_academic_period_id, learning_instance_target_id) VALUES (?, ?, ?)").run(
        uuid(),
        p1,
        targetId
      );
      return { instanceId, period1Id: p1, period2Id: p2 };
    }

    return { instanceId };
  } finally {
    db.close();
  }
}

test("Billing Guards — monthly payment blocking and defaulter reporting", { timeout: 120000 }, async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const base = seedBase(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl), server.getStderr());

    const termRun = createLearningInstance(dbPath, {
      kidsOfferingTypeId: base.kidsOfferingTypeId,
      programmeId: base.programmeId,
      academicStructure: "term",
      name: "Term Run",
    });
    const semesterRun = createLearningInstance(dbPath, {
      kidsOfferingTypeId: base.kidsOfferingTypeId,
      programmeId: base.programmeId,
      academicStructure: "semester",
      name: "Semester Run",
    });
    const monthlyRun = createLearningInstance(dbPath, {
      kidsOfferingTypeId: base.kidsOfferingTypeId,
      programmeId: base.programmeId,
      academicStructure: null,
      name: "Monthly Run",
    });

    const termLearner = seedLearnerOnInstance(dbPath, {
      adminId: base.adminId,
      programmeId: base.programmeId,
      classId: base.classId,
      instanceId: termRun.instanceId,
      academicStructure: "term",
      paymentStatus: "current",
    });
    recordPeriodPayment(dbPath, termLearner.userId, termRun.instanceId, termRun.period1Id, 500);
    recordPeriodPayment(dbPath, termLearner.userId, termRun.instanceId, termRun.period2Id, 500);
    const semesterLearner = seedLearnerOnInstance(dbPath, {
      adminId: base.adminId,
      programmeId: base.programmeId,
      classId: base.classId,
      instanceId: semesterRun.instanceId,
      academicStructure: "semester",
      paymentStatus: "current",
    });
    recordPeriodPayment(dbPath, semesterLearner.userId, semesterRun.instanceId, semesterRun.period1Id, 600);
    recordPeriodPayment(dbPath, semesterLearner.userId, semesterRun.instanceId, semesterRun.period2Id, 600);
    const monthlyLearner = seedLearnerOnInstance(dbPath, {
      adminId: base.adminId,
      programmeId: base.programmeId,
      classId: base.classId,
      instanceId: monthlyRun.instanceId,
      academicStructure: null,
      paymentStatus: "unpaid",
    });
    const termDefaulter = seedLearnerOnInstance(dbPath, {
      adminId: base.adminId,
      programmeId: base.programmeId,
      classId: base.classId,
      instanceId: termRun.instanceId,
      academicStructure: "term",
      paymentStatus: "current",
    });
    const monthlyDefaulter = seedLearnerOnInstance(dbPath, {
      adminId: base.adminId,
      programmeId: base.programmeId,
      classId: base.classId,
      instanceId: monthlyRun.instanceId,
      academicStructure: null,
      paymentStatus: "unpaid",
    });
    const monthlyAdminTarget = seedLearnerOnInstance(dbPath, {
      adminId: base.adminId,
      programmeId: base.programmeId,
      classId: base.classId,
      instanceId: monthlyRun.instanceId,
      academicStructure: null,
      paymentStatus: "unpaid",
    });

    await t.test("Test A — Term-based monthly payment rejected", async () => {
      const before = countMonthlyPayments(dbPath, termLearner.userId);
      const res = await fetch(`${server.baseUrl}/api/payments/${termLearner.userId}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieFor(termLearner.userId, "learner") },
        body: JSON.stringify({ type: "monthly", method: "CARD" }),
      });
      const body = await res.json();
      assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(body));
      assert.equal(body.error, MONTHLY_BLOCKED);
      assert.equal(countMonthlyPayments(dbPath, termLearner.userId), before);
    });

    await t.test("Test B — Semester-based monthly payment rejected", async () => {
      const before = countMonthlyPayments(dbPath, semesterLearner.userId);
      const res = await fetch(`${server.baseUrl}/api/payments/${semesterLearner.userId}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieFor(semesterLearner.userId, "learner") },
        body: JSON.stringify({ type: "monthly", method: "CARD" }),
      });
      const body = await res.json();
      assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(body));
      assert.equal(body.error, MONTHLY_BLOCKED);
      assert.equal(countMonthlyPayments(dbPath, semesterLearner.userId), before);
    });

    await t.test("Test C — Legitimate monthly payment remains functional", async () => {
      const res = await fetch(`${server.baseUrl}/api/payments/${monthlyLearner.userId}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieFor(monthlyLearner.userId, "learner") },
        body: JSON.stringify({ type: "monthly", method: "CARD" }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(countMonthlyPayments(dbPath, monthlyLearner.userId), 1);
    });

    await t.test("Test D — Admin monthly payment rejected for term-based learner", async () => {
      const before = countMonthlyPayments(dbPath, termLearner.userId);
      const res = await fetch(`${server.baseUrl}/api/payments/${termLearner.userId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookieFor(base.adminId, "admin") },
        body: JSON.stringify({ status: "current", type: "monthly", amountPaid: 180, method: "Cash" }),
      });
      const body = await res.json();
      assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(body));
      assert.equal(body.error, MONTHLY_BLOCKED);
      assert.equal(countMonthlyPayments(dbPath, termLearner.userId), before);
    });

    await t.test("Test E — Admin monthly payment rejected for semester-based learner", async () => {
      const before = countMonthlyPayments(dbPath, semesterLearner.userId);
      const res = await fetch(`${server.baseUrl}/api/payments/${semesterLearner.userId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookieFor(base.adminId, "admin") },
        body: JSON.stringify({ status: "current", type: "monthly", amountPaid: 180, method: "Cash" }),
      });
      const body = await res.json();
      assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(body));
      assert.equal(body.error, MONTHLY_BLOCKED);
      assert.equal(countMonthlyPayments(dbPath, semesterLearner.userId), before);
    });

    await t.test("Test F — Admin monthly payment remains functional for legitimate monthly learner", async () => {
      const res = await fetch(`${server.baseUrl}/api/payments/${monthlyAdminTarget.userId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookieFor(base.adminId, "admin") },
        body: JSON.stringify({ status: "current", type: "monthly", amountPaid: 180, method: "Cash" }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(countMonthlyPayments(dbPath, monthlyAdminTarget.userId), 1);
    });

    await t.test("Test G — Term-based learner not reported with monthly arrears", async () => {
      const res = await fetch(`${server.baseUrl}/api/payments/defaulters`, {
        headers: { Cookie: cookieFor(base.adminId, "admin") },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const termRow = body.defaulters.find((d) => d.id === termLearner.userId);
      assert.equal(termRow, undefined, "term learner with satisfied period obligations must not appear as monthly defaulter");
      assert.equal(body.monthlyArrearsGHS, body.monthlyFeeGHS * body.defaulters.filter((d) => d.billingModel === "monthly").length);
    });

    await t.test("Test H — Semester-based learner not reported with monthly arrears", async () => {
      const res = await fetch(`${server.baseUrl}/api/payments/defaulters`, {
        headers: { Cookie: cookieFor(base.adminId, "admin") },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const semesterRow = body.defaulters.find((d) => d.id === semesterLearner.userId);
      assert.equal(semesterRow, undefined, "semester learner with current global status must not appear as monthly defaulter");
    });

    await t.test("Test I — Monthly learner still appears correctly", async () => {
      const res = await fetch(`${server.baseUrl}/api/payments/defaulters`, {
        headers: { Cookie: cookieFor(base.adminId, "admin") },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const monthlyRow = body.defaulters.find((d) => d.id === monthlyDefaulter.userId);
      assert.ok(monthlyRow, "unpaid monthly learner must appear in defaulters");
      assert.equal(monthlyRow.billingModel, "monthly");
      assert.ok(body.monthlyArrearsGHS >= body.monthlyFeeGHS);
    });

    await t.test("Test J — Period-payment arrears remain meaningful", async () => {
      const res = await fetch(`${server.baseUrl}/api/payments/defaulters`, {
        headers: { Cookie: cookieFor(base.adminId, "admin") },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      const periodRow = body.defaulters.find((d) => d.id === termDefaulter.userId);
      assert.ok(periodRow, "term learner with unpaid configured period(s) must appear as period defaulter");
      assert.equal(periodRow.billingModel, "period");
      assert.ok(periodRow.periodOutstandingGHS > 0);
      assert.ok(body.periodArrearsGHS >= periodRow.periodOutstandingGHS);
      assert.ok(body.estimatedArrearsGHS >= body.periodArrearsGHS);
    });
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
