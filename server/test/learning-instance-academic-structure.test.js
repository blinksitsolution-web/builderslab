/**
 * Phase 4 — Academic Structure per Learning Instance.
 *
 * Every Learning Instance may declare exactly one academic structure:
 * 'semester' (exactly 2 academic periods) or 'term' (exactly 3). Locks in:
 *  - setting a structure generates the right number of default-named periods;
 *  - it can be reconfigured while still 'upcoming' (periods regenerated);
 *  - it's locked once the run leaves 'upcoming' (active/completed/etc.);
 *  - periods can be renamed / dated / cross-linked to an Academic Term
 *    without changing their sequence identity;
 *  - existing Learning Instances are unaffected (additive-only schema).
 *
 * Same real-server-process pattern as learning-instance-multi-target.test.js.
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
const JWT_SECRET = "learning-instance-academic-structure-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-li-academic-structure-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "learning-instance-academic-structure-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-li-academic-structure-uploads-"));
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

function adminCookie(adminId) {
  const token = jwt.sign({ sub: adminId, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'li-academic-structure-admin@example.com', 'x', 'active', 'paid', 1, 'ADM-LIAS-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'LI Academic Structure Test Programme', 60)").run(programmeId, offeringType.id);

    const termId = uuid();
    const yearId = uuid();
    db.prepare("INSERT INTO academic_years (id, name, is_active) VALUES (?, 'LI-AS-Test-Year', 0)").run(yearId);
    db.prepare("INSERT INTO academic_terms (id, academic_year_id, name, sort_order, is_active) VALUES (?, ?, 'LI-AS-Test-Term', 1, 0)").run(termId, yearId);

    return { adminId, offeringTypeId: offeringType.id, programmeId, termId };
  } finally {
    db.close();
  }
}

test("learning-instance academic structure: setting 'semester' generates exactly 2 default-named periods", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.programmeId, name: "Semester Run", status: "upcoming" }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  assert.equal(created.academicStructure, null);
  assert.equal(created.academicPeriods.length, 0);

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  assert.equal(structRes.status, 200);
  const withStructure = await structRes.json();
  assert.equal(withStructure.academicStructure, "semester");
  assert.equal(withStructure.academicPeriods.length, 2);
  assert.deepEqual(withStructure.academicPeriods.map((p) => p.name), ["Semester 1", "Semester 2"]);
  assert.deepEqual(withStructure.academicPeriods.map((p) => p.sequence), [1, 2]);
});

test("learning-instance academic structure: setting 'term' generates exactly 3 periods; reconfiguring while upcoming replaces them", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.programmeId, name: "Term Run", status: "upcoming" }),
  });
  const created = await createRes.json();

  const termStructRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "term" }),
  });
  assert.equal(termStructRes.status, 200);
  const withTerm = await termStructRes.json();
  assert.equal(withTerm.academicStructure, "term");
  assert.equal(withTerm.academicPeriods.length, 3);
  assert.deepEqual(withTerm.academicPeriods.map((p) => p.name), ["Term 1", "Term 2", "Term 3"]);

  // Reconfigure to 'semester' while still upcoming — periods regenerated.
  const switchRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  assert.equal(switchRes.status, 200);
  const switched = await switchRes.json();
  assert.equal(switched.academicStructure, "semester");
  assert.equal(switched.academicPeriods.length, 2);

  // Invalid structure value is rejected.
  const badRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "trimester" }),
  });
  assert.equal(badRes.status, 400);
});

test("learning-instance academic structure: locked once the run leaves 'upcoming'", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.programmeId, name: "Active Run", status: "active" }),
  });
  const created = await createRes.json();
  assert.equal(created.status, "active");

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "term" }),
  });
  assert.equal(structRes.status, 400);
  const body = await structRes.json();
  assert.match(body.error, /upcoming/);
});

test("learning-instance academic structure: a period can be renamed, dated, and linked to an Academic Term without changing its sequence", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.programmeId, name: "Rename Test Run", status: "upcoming" }),
  });
  const created = await createRes.json();

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await structRes.json();
  const period1 = withStructure.academicPeriods.find((p) => p.sequence === 1);

  const updateRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Fall Semester", academicTermId: fx.termId, startDate: "2026-09-01", endDate: "2026-12-15" }),
  });
  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json();
  const updatedPeriod = updated.academicPeriods.find((p) => p.id === period1.id);
  assert.equal(updatedPeriod.name, "Fall Semester");
  assert.equal(updatedPeriod.sequence, 1);
  assert.equal(updatedPeriod.academicTermId, fx.termId);
  assert.equal(updatedPeriod.startDate, "2026-09-01");
  assert.equal(updatedPeriod.endDate, "2026-12-15");

  // Invalid academicTermId is rejected.
  const period2 = updated.academicPeriods.find((p) => p.sequence === 2);
  const badTermRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period2.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ academicTermId: "not-a-real-term-id" }),
  });
  assert.equal(badTermRes.status, 400);
});

test("learning-instance academic structure: existing Learning Instances (no structure configured) are unaffected", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.programmeId, name: "No Structure Run", status: "active" }),
  });
  const created = await createRes.json();
  assert.equal(created.academicStructure, null);
  assert.deepEqual(created.academicPeriods, []);

  const getRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}`, { headers: { Cookie: adminCookie(fx.adminId) } });
  const fetched = await getRes.json();
  assert.equal(fetched.academicStructure, null);
  assert.deepEqual(fetched.academicPeriods, []);
});
