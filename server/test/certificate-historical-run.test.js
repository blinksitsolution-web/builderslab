/**
 * Certificate historical-integrity — graduation/honor/recognition
 * certificates (routes/certificates.js's issueOne, non-module-completion
 * path) resolve the Learning Instance they snapshot from
 * getActiveInstanceIdForClass(learner.class_id) — the CURRENTLY active
 * Run for that class — rather than the learner's own actual enrollment.
 *
 * That's correct for the common case (issuing right after completion,
 * while the learner's own Run is still the active one), but breaks the
 * "certificate must remain associated with its historical Run" rule the
 * moment issuance happens late: an admin issuing a graduation certificate
 * for a 2026 cohort AFTER an admin has already opened a 2027 Run for the
 * same Programme would previously get the certificate snapshotted against
 * 2027, not the Run the learner actually completed.
 *
 * Fix: resolve via getEnrolledLearningInstanceIdForLearner (the learner's
 * own primary programme_enrollments row) first, falling back to the
 * active-instance lookup only when no enrollment record exists at all.
 *
 * Same real-server-process pattern as period-scoped-transcripts-and-
 * certificates.test.js.
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
const JWT_SECRET = "certificate-historical-run-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-cert-historical-run-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "certificate-historical-run-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-cert-historical-run-uploads-"));
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

// Seeds an Adult Professional Programme with a 2026 Run (active) and,
// separately, a learner already enrolled + activated on that 2026 Run
// (programme_enrollments.status='active', learning_instance_id = 2026
// Run). Returns a function to later open a 2027 Run for the SAME
// programme and flip it active, simulating an admin opening next year's
// cohort before the 2026 learner's certificate has been issued.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Cert Historical Run Test Programme', 0)"
    ).run(programmeId, offeringType.id);
    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, 'Batch A', 0, ?)").run(classId, programmeId);

    const run2026Id = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name) VALUES (?, ?, ?, 'active', '2026 Run')"
    ).run(run2026Id, offeringType.id, programmeId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), run2026Id, programmeId);

    const adminId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date) VALUES (?, 'admin', 'Test Admin', ?, ?, 'active', 'current', 1, 'ADM-CHR-0001', date('now'))"
    ).run(adminId, `admin-${uuid()}@example.test`, bcrypt.hashSync("adminpass123", 12));

    const learnerId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, campus, class_id)
       VALUES (?, 'learner', 'Historical Run Learner', ?, ?, 'active', 'current', 1, 'STU-CHR-0001', date('now'), 'Main Campus', ?)`
    ).run(learnerId, `learner-${uuid()}@example.test`, bcrypt.hashSync("learnerpass123", 12), classId);

    const enrollmentId = uuid();
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id)
       VALUES (?, ?, ?, ?, 1, 'active', 'current', date('now'), ?)`
    ).run(enrollmentId, learnerId, programmeId, classId, run2026Id);

    return { dbPath, programmeId, classId, run2026Id, adminId, learnerId };
  } finally {
    db.close();
  }
}

// Opens and activates a 2027 Run for the same programme — the same
// action an admin takes when opening next year's cohort. Simulates the
// "certificate issued late, after a newer Run is already active" scenario.
function activate2027Run(dbPath, programmeId) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT offering_type_id FROM programmes WHERE id = ?").get(programmeId);
    const run2027Id = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, name) VALUES (?, ?, ?, 'active', '2027 Run')"
    ).run(run2027Id, offeringType.offering_type_id, programmeId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), run2027Id, programmeId);
    return run2027Id;
  } finally {
    db.close();
  }
}

function readIssuedCertificate(dbPath, id) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM issued_certificates WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

test("certificate historical-run: a certificate issued after a newer Run activates still snapshots the learner's OWN (older) enrolled Run", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  // Admin opens next year's Run for the SAME programme BEFORE the 2026
  // learner's certificate has been issued — exactly the scenario the fix
  // targets.
  const run2027Id = activate2027Run(dbPath, fx.programmeId);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());

    // A minimal graduation-type template with no highest_score/highest_
    // grade/highest_interpretation placeholders — deliberately avoids
    // routes/certificates.js's highestResult() (its `examination_attempts
    // JOIN examinations` UNION query has a pre-existing, unrelated
    // "ambiguous column name: term_id" bug when a learner has no exam/
    // grade history at all — out of scope for this fix, which is only
    // about which Learning Instance gets snapshotted).
    const db = new Database(dbPath);
    const templateId = uuid();
    db.prepare(
      `INSERT INTO certificate_templates (id, name, type, title, body, placeholders, show_academic_stats)
       VALUES (?, 'Minimal Graduation Test Template', 'graduation', 'Certificate of Graduation', 'Awarded to {{student_name}}', '["student_name","certificate_number"]', 0)`
    ).run(templateId);
    db.close();

    const res = await fetch(`${server.baseUrl}/api/certificates/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(fx.adminId, "admin") },
      body: JSON.stringify({ templateId, learnerIds: [fx.learnerId] }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.issued, 1, JSON.stringify(body));

    const cert = readIssuedCertificate(dbPath, body.certificates[0].id);
    assert.equal(cert.learning_instance_id, fx.run2026Id, "certificate must snapshot the learner's own enrolled 2026 Run");
    assert.notEqual(cert.learning_instance_id, run2027Id, "certificate must NOT snapshot the newer, currently-active 2027 Run");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
