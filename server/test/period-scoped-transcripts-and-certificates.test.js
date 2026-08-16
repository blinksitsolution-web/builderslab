/**
 * Phase 9 — Period-scoped transcripts and certificates.
 *
 * Locks in:
 *  - GET /api/grades/:userId/transcript?learningInstanceId=&academicPeriodId=
 *    is deterministically scoped to (learner, Learning Instance, academic
 *    period): an earlier period's transcript never includes a later
 *    period's results, and generating the later period's transcript never
 *    mutates/affects the earlier period's result;
 *  - requesting a period that isn't linked to a school-wide Academic Term
 *    yet is rejected (409) rather than guessed;
 *  - requesting an unknown academic period for a Learning Instance is
 *    rejected (404);
 *  - the default (no learningInstanceId/academicPeriodId) transcript path
 *    is completely unaffected — same shape, same values, as before Phase 9;
 *  - issued_certificates.learning_instance_academic_period_id is additive
 *    and nullable: legacy certificates (issued before Phase 9, or for a
 *    Learning Instance with no academic structure) remain valid with a
 *    null academic period;
 *  - issuing a certificate for a later academic period never overwrites,
 *    mutates, or replaces an earlier period's certificate for the same
 *    learner+module — both remain visible as separate, independently
 *    fetchable historical certificates;
 *  - the /issue idempotency ("already issued") check treats different
 *    academic periods as different certificates, while still correctly
 *    deduplicating two identical (no-period) issue requests exactly as
 *    before.
 *
 * Same real-server-process pattern as period-payment-enforcement.test.js.
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
const JWT_SECRET = "period-scoped-transcripts-certificates-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-period-transcript-cert-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "period-scoped-transcripts-certificates-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-period-transcript-cert-uploads-"));
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
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return body;
}

// IOT-02 is seeded with is_open = 0 (see migrate.js), so it never gets an
// auto-created Learning Instance from the v24 registration-catalogue
// backfill — this test needs full manual control over the instance.
const TEST_MODULE_ID = "IOT-02";
// HW-05 is_open = 1 -> auto-backfilled Active instance with no academic
// structure configured at all, used for the legacy/no-period certificate
// path.
const LEGACY_MODULE_ID = "HW-05";

function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'period-transcript-cert-admin@example.com', 'x', 'active', 'current', 1, 'ADM-PTC-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    const learnerId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, campus, joined_date, student_code)
       VALUES (?, 'learner', 'Test Learner', ?, ?, 'active', 'current', 'Main Campus', date('now'), ?)`
    ).run(learnerId, `learner-${learnerId}@example.test`, bcrypt.hashSync("learnerpass123", 12), `T-${learnerId.slice(0, 8)}`);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(learnerId, TEST_MODULE_ID);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(learnerId, LEGACY_MODULE_ID);

    const activeYear = db.prepare("SELECT * FROM academic_years WHERE is_active = 1").get();

    return { adminId, offeringTypeId: offeringType.id, learnerId, academicYearId: activeYear.id };
  } finally {
    db.close();
  }
}

// Builds a Module Learning Instance with a 'semester' academic structure,
// both periods pointed at the instance's own primary target, period 1
// linked to the (already-active, seeded) Term 1, and period 2 linked to a
// freshly-created Term 2 — then activates the run.
async function createTwoLinkedPeriods(baseUrl, headers, academicYearId) {
  const createRes = await fetch(`${baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: headers.__offeringTypeId, courseId: TEST_MODULE_ID, name: "Period Transcript/Cert Test Run", status: "upcoming" }),
  });
  const created = await readJson(createRes);
  assert.equal(createRes.status, 200, JSON.stringify(created));

  const structRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await readJson(structRes);
  assert.equal(structRes.status, 200, JSON.stringify(withStructure));
  const [period1, period2] = withStructure.academicPeriods;
  const primaryTargetId = withStructure.targets[0].id;

  for (const p of [period1, period2]) {
    const targetsRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-periods/${p.id}/targets`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ targetIds: [primaryTargetId] }),
    });
    assert.equal(targetsRes.status, 200);
  }

  // Term 1 is already active/seeded — link period1 to it directly.
  const termsRes = await fetch(`${baseUrl}/api/academic-calendar/terms`, { headers });
  const termsBody = await readJson(termsRes);
  const term1 = termsBody.terms.find((t) => t.name === "Term 1") || termsBody.terms[0];

  const linkP1Res = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ academicTermId: term1.id }),
  });
  assert.equal(linkP1Res.status, 200, JSON.stringify(await readJson(linkP1Res)));

  // Create + link a second, distinct term for period 2.
  const term2Res = await fetch(`${baseUrl}/api/academic-calendar/terms`, {
    method: "POST",
    headers,
    body: JSON.stringify({ academicYearId, name: `Term 2 PTC ${uuid().slice(0, 8)}`, sortOrder: 2 }),
  });
  const term2 = await readJson(term2Res);
  assert.equal(term2Res.status, 200, JSON.stringify(term2));

  const linkP2Res = await fetch(`${baseUrl}/api/learning-instances/${created.id}/academic-periods/${period2.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ academicTermId: term2.id }),
  });
  assert.equal(linkP2Res.status, 200, JSON.stringify(await readJson(linkP2Res)));

  const activateRes = await fetch(`${baseUrl}/api/learning-instances/${created.id}/activate`, { method: "POST", headers });
  assert.equal(activateRes.status, 200, JSON.stringify(await readJson(activateRes)));

  return { instanceId: created.id, period1Id: period1.id, period2Id: period2.id, term1Id: term1.id, term2Id: term2.id };
}

function seedEndOfTermAttempt(dbPath, { learnerId, courseId, instanceId, termId, adminId, score }) {
  const db = new Database(dbPath);
  try {
    const examId = uuid();
    db.prepare(
      `INSERT INTO examinations (id, course_id, title, term_type, questions, created_by, learning_instance_id, term_id)
       VALUES (?, ?, ?, 'end_of_term', '[]', ?, ?, ?)`
    ).run(examId, courseId, `End of Term Exam ${examId.slice(0, 8)}`, adminId, instanceId, termId);
    db.prepare(
      `INSERT INTO examination_attempts (id, examination_id, user_id, answers, score, learning_instance_id, term_id)
       VALUES (?, ?, ?, '[]', ?, ?, ?)`
    ).run(uuid(), examId, learnerId, score, instanceId, termId);
  } finally {
    db.close();
  }
}

test("period-scoped transcript: an earlier period's transcript never includes a later period's results, and generating the later one doesn't change the earlier one", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  const { instanceId, period1Id, period2Id, term1Id, term2Id } = await createTwoLinkedPeriods(server.baseUrl, headers, fx.academicYearId);

  // Period 1 (Term 1): End of Term score 90. Period 2 (Term 2): End of Term
  // score 40 — deliberately a very different score so any cross-period leak
  // is impossible to miss.
  seedEndOfTermAttempt(dbPath, { learnerId: fx.learnerId, courseId: TEST_MODULE_ID, instanceId, termId: term1Id, adminId: fx.adminId, score: 90 });
  seedEndOfTermAttempt(dbPath, { learnerId: fx.learnerId, courseId: TEST_MODULE_ID, instanceId, termId: term2Id, adminId: fx.adminId, score: 40 });

  const p1Res = await fetch(
    `${server.baseUrl}/api/grades/${fx.learnerId}/transcript?learningInstanceId=${instanceId}&academicPeriodId=${period1Id}`,
    { headers }
  );
  const p1Body = await readJson(p1Res);
  assert.equal(p1Res.status, 200, JSON.stringify(p1Body));
  assert.equal(p1Body.academicPeriodId, period1Id);
  assert.equal(p1Body.learningInstanceId, instanceId);
  const p1Row = p1Body.rows.find((r) => r.courseId === TEST_MODULE_ID);
  assert.ok(p1Row, "Period 1 transcript should include the test module.");
  assert.equal(p1Row.endOfTermMax, 70);
  assert.equal(p1Row.endOfTerm, 63); // 90% of the 70-point weight

  // Now generate period 2's transcript.
  const p2Res = await fetch(
    `${server.baseUrl}/api/grades/${fx.learnerId}/transcript?learningInstanceId=${instanceId}&academicPeriodId=${period2Id}`,
    { headers }
  );
  const p2Body = await readJson(p2Res);
  assert.equal(p2Res.status, 200, JSON.stringify(p2Body));
  assert.equal(p2Body.academicPeriodId, period2Id);
  const p2Row = p2Body.rows.find((r) => r.courseId === TEST_MODULE_ID);
  assert.ok(p2Row, "Period 2 transcript should include the test module.");
  assert.equal(p2Row.endOfTerm, 28); // 40% of the 70-point weight — NOT influenced by period 1's 90%

  // Re-fetch period 1's transcript — must be exactly unchanged after
  // period 2's was generated.
  const p1AgainRes = await fetch(
    `${server.baseUrl}/api/grades/${fx.learnerId}/transcript?learningInstanceId=${instanceId}&academicPeriodId=${period1Id}`,
    { headers }
  );
  const p1AgainBody = await readJson(p1AgainRes);
  const p1RowAgain = p1AgainBody.rows.find((r) => r.courseId === TEST_MODULE_ID);
  assert.equal(p1RowAgain.endOfTerm, 63);
});

test("period-scoped transcript: a period not yet linked to an Academic Term is rejected (409), never guessed", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, courseId: TEST_MODULE_ID, name: "Unlinked Period Run", status: "upcoming" }),
  });
  const created = await readJson(createRes);
  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "term" }),
  });
  const withStructure = await readJson(structRes);
  const [period1] = withStructure.academicPeriods;
  await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/activate`, { method: "POST", headers });

  const res = await fetch(
    `${server.baseUrl}/api/grades/${fx.learnerId}/transcript?learningInstanceId=${created.id}&academicPeriodId=${period1.id}`,
    { headers }
  );
  const body = await readJson(res);
  assert.equal(res.status, 409, JSON.stringify(body));
});

test("period-scoped transcript: an unknown academic period for the given Learning Instance is rejected (404)", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  const { instanceId } = await createTwoLinkedPeriods(server.baseUrl, headers, fx.academicYearId);
  const res = await fetch(
    `${server.baseUrl}/api/grades/${fx.learnerId}/transcript?learningInstanceId=${instanceId}&academicPeriodId=${uuid()}`,
    { headers }
  );
  assert.equal(res.status, 404);
});

test("period-scoped transcript: the default (non-period) transcript path is unaffected by Phase 9", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  const res = await fetch(`${server.baseUrl}/api/grades/${fx.learnerId}/transcript`, { headers });
  const body = await readJson(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  // No period params supplied -> the new Phase 9 fields must be present but
  // null, and every module the learner is enrolled in (across every run)
  // is included exactly as before Phase 9.
  assert.equal(body.learningInstanceId, null);
  assert.equal(body.academicPeriodId, null);
  const courseIds = body.rows.map((r) => r.courseId);
  assert.ok(courseIds.includes(TEST_MODULE_ID));
  assert.ok(courseIds.includes(LEGACY_MODULE_ID));
});

test("period-scoped certificates: a later period's certificate never overwrites an earlier period's certificate; both remain separately visible", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  const { instanceId, period1Id, period2Id } = await createTwoLinkedPeriods(server.baseUrl, headers, fx.academicYearId);

  const templateRes = await fetch(`${server.baseUrl}/api/certificate-templates`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Module Completion PTC ${uuid().slice(0, 8)}`, type: "module_completion", placeholders: ["student_name", "module_name"] }),
  });
  const template = await readJson(templateRes);
  assert.equal(templateRes.status, 200, JSON.stringify(template));

  // Issue a certificate for period 1.
  const issue1Res = await fetch(`${server.baseUrl}/api/certificates/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ templateId: template.id, courseId: TEST_MODULE_ID, learnerIds: [fx.learnerId], learningInstanceAcademicPeriodId: period1Id }),
  });
  const issue1Body = await readJson(issue1Res);
  assert.equal(issue1Res.status, 200, JSON.stringify(issue1Body));
  assert.equal(issue1Body.issued, 1, JSON.stringify(issue1Body));
  const cert1 = issue1Body.certificates[0];
  assert.equal(cert1.learning_instance_academic_period_id, period1Id);

  // Re-issuing for the SAME period is correctly deduplicated (unchanged
  // pre-Phase-9 idempotency behavior).
  const reissue1Res = await fetch(`${server.baseUrl}/api/certificates/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ templateId: template.id, courseId: TEST_MODULE_ID, learnerIds: [fx.learnerId], learningInstanceAcademicPeriodId: period1Id }),
  });
  const reissue1Body = await readJson(reissue1Res);
  assert.equal(reissue1Body.issued, 0, JSON.stringify(reissue1Body));
  assert.equal(reissue1Body.skipped[0].reason, "Already issued.");

  // Issuing for period 2 must NOT be treated as a duplicate of period 1's
  // certificate — it's a genuinely separate certificate.
  const issue2Res = await fetch(`${server.baseUrl}/api/certificates/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ templateId: template.id, courseId: TEST_MODULE_ID, learnerIds: [fx.learnerId], learningInstanceAcademicPeriodId: period2Id }),
  });
  const issue2Body = await readJson(issue2Res);
  assert.equal(issue2Res.status, 200, JSON.stringify(issue2Body));
  assert.equal(issue2Body.issued, 1, JSON.stringify(issue2Body));
  const cert2 = issue2Body.certificates[0];
  assert.equal(cert2.learning_instance_academic_period_id, period2Id);
  assert.notEqual(cert2.id, cert1.id);
  assert.notEqual(cert2.certificate_number, cert1.certificate_number);

  // The earlier (period 1) certificate must remain fetchable, unchanged,
  // after the later (period 2) certificate was issued.
  const cert1AgainRes = await fetch(`${server.baseUrl}/api/certificates/${cert1.id}`, { headers });
  const cert1Again = await readJson(cert1AgainRes);
  assert.equal(cert1AgainRes.status, 200);
  assert.equal(cert1Again.certificate_number, cert1.certificate_number);
  assert.equal(cert1Again.learning_instance_academic_period_id, period1Id);
  assert.equal(cert1Again.academicPeriod.id, period1Id);

  // Both certificates show up as separate historical entries in the
  // learner's certificate list, each correctly identifying its own period.
  const listRes = await fetch(`${server.baseUrl}/api/certificates/learner/${fx.learnerId}`, { headers });
  const listBody = await readJson(listRes);
  assert.equal(listRes.status, 200);
  const forThisModule = listBody.certificates.filter((c) => c.course_id === TEST_MODULE_ID && c.learning_instance_id === instanceId);
  assert.equal(forThisModule.length, 2, JSON.stringify(forThisModule));
  const periodIdsSeen = forThisModule.map((c) => c.academicPeriod && c.academicPeriod.id).sort();
  assert.deepEqual(periodIdsSeen, [period1Id, period2Id].sort());
});

test("period-scoped certificates: legacy certificates (no academic period) remain valid and keep deduplicating as before", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), server.getStderr());
  const fx = seedFixtures(dbPath);
  const headers = { "Content-Type": "application/json", Cookie: cookieFor(fx.adminId, "admin"), __offeringTypeId: fx.offeringTypeId };

  const templateRes = await fetch(`${server.baseUrl}/api/certificate-templates`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Legacy Module Completion PTC ${uuid().slice(0, 8)}`, type: "module_completion", placeholders: ["student_name", "module_name"] }),
  });
  const template = await readJson(templateRes);

  // LEGACY_MODULE_ID's auto-backfilled instance has no academic structure
  // at all — issuing with no learningInstanceAcademicPeriodId at all is the
  // pre-Phase-9 path.
  const issueRes = await fetch(`${server.baseUrl}/api/certificates/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ templateId: template.id, courseId: LEGACY_MODULE_ID, learnerIds: [fx.learnerId] }),
  });
  const issueBody = await readJson(issueRes);
  assert.equal(issueRes.status, 200, JSON.stringify(issueBody));
  assert.equal(issueBody.issued, 1);
  const cert = issueBody.certificates[0];
  assert.equal(cert.learning_instance_academic_period_id, null);

  // Fetching it back: valid, with a null academicPeriod (not an error).
  const getRes = await fetch(`${server.baseUrl}/api/certificates/${cert.id}`, { headers });
  const getBody = await readJson(getRes);
  assert.equal(getRes.status, 200);
  assert.equal(getBody.academicPeriod, null);

  // Re-issuing the identical (still no-period) request is still correctly
  // deduplicated — the null-vs-null identity match keeps working.
  const reissueRes = await fetch(`${server.baseUrl}/api/certificates/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ templateId: template.id, courseId: LEGACY_MODULE_ID, learnerIds: [fx.learnerId] }),
  });
  const reissueBody = await readJson(reissueRes);
  assert.equal(reissueBody.issued, 0);
  assert.equal(reissueBody.skipped[0].reason, "Already issued.");
});
