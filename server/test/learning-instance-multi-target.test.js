/**
 * Stage 4C/4E — Multi-target Learning Instances.
 *
 * A Learning Instance used to be exactly one run of one Programme XOR one
 * Module (learning_instances.programme_id/course_id). This locks in the
 * new learning_instance_targets join table: a run can now serve several
 * Programmes/Modules at once, while the DB-level "only one Active run per
 * Programme/Module" backstop still holds across ALL of a run's targets
 * (primary + secondary), not just the one stored on the parent row.
 *
 * Same real-server-process pattern as admin-class-delivery-mode.test.js /
 * enrolment-duplicate-prevention.test.js.
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
const JWT_SECRET = "learning-instance-multi-target-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-li-multi-target-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "learning-instance-multi-target-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-li-multi-target-uploads-"));
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

// Seeds an admin + a Kids STEM offering type context with two Modules and
// one Programme, all under the same offering type so they're mutually
// valid targets for one Learning Instance.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'li-multi-target-admin@example.com', 'x', 'active', 'paid', 1, 'ADM-LIMT-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'LI Multi-Target Test Programme', 50)").run(programmeId, offeringType.id);

    const moduleAId = "li-mt-mod-a";
    db.prepare("INSERT INTO courses (id, title, programme_id, is_open) VALUES (?, 'LI Multi-Target Module A', ?, 1)").run(moduleAId, programmeId);
    const moduleBId = "li-mt-mod-b";
    db.prepare("INSERT INTO courses (id, title, programme_id, is_open) VALUES (?, 'LI Multi-Target Module B', ?, 1)").run(moduleBId, programmeId);

    // A second, fully independent Programme+Module pair — used to prove a
    // *different* run isn't affected by any of this.
    const otherProgrammeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'LI Multi-Target Other Programme', 51)").run(otherProgrammeId, offeringType.id);

    return { adminId, offeringTypeId: offeringType.id, programmeId, moduleAId, moduleBId, otherProgrammeId };
  } finally {
    db.close();
  }
}

test("learning-instance multi-target: create + add two Module targets to one run; both resolve as having an active run", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

  // Create the run with Module A as its primary target, already active.
  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, courseId: fx.moduleAId, name: "Jan 2026 Cohort", status: "active" }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  assert.equal(created.courseId, fx.moduleAId);
  assert.equal(created.targets.length, 1);
  assert.equal(created.targets[0].isPrimary, true);
  assert.equal(created.targets[0].courseId, fx.moduleAId);

  // Attach Module B as a secondary target of the SAME run.
  const addRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/targets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ courseId: fx.moduleBId }),
  });
  assert.equal(addRes.status, 201);
  const withTarget = await addRes.json();
  assert.equal(withTarget.targets.length, 2);
  const moduleBTarget = withTarget.targets.find((t) => t.courseId === fx.moduleBId);
  assert.ok(moduleBTarget, "Module B should now be a target of this run");
  assert.equal(moduleBTarget.isPrimary, false);

  // Fetching the run again shows both targets persisted.
  const getRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}`, { headers: { Cookie: adminCookie(fx.adminId) } });
  const fetched = await getRes.json();
  assert.equal(fetched.targets.length, 2);
});

test("learning-instance multi-target: a Programme/Module already an ACTIVE target of one run CAN become an active target of another (concurrent Programme Runs, both as primary and as secondary)", async (t) => {
  // ABRS v2.2 amendment (concurrent Programme Runs): a Programme/Module is
  // no longer limited to a single system-wide Active run — see the
  // matching notes in routes/learningInstances.js (create + /activate +
  // /targets) and the DROP INDEX step at the end of migrate.js that
  // removed the old idx_lit_one_active_per_programme/_course backstop.
  // This test used to assert the pre-amendment "only one Active run per
  // Programme/Module" behavior (409s below); it now locks in the current,
  // intentional opposite behavior instead.
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

  // Run 1: active, primary target = Programme.
  const run1Res = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.programmeId, name: "Run 1", status: "active" }),
  });
  assert.equal(run1Res.status, 200);
  const run1 = await run1Res.json();

  // Run 2: a different run for a different Module, created upcoming.
  const run2Res = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, courseId: fx.moduleAId, name: "Run 2", status: "upcoming" }),
  });
  assert.equal(run2Res.status, 200);
  const run2 = await run2Res.json();

  // Creating ANOTHER active run whose primary target is the same Programme
  // already claimed Active by Run 1 now succeeds — concurrent cohorts of
  // the same Programme (e.g. separate schools/batches) are allowed.
  const run3Res = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.programmeId, name: "Run 3 (concurrent)", status: "active" }),
  });
  assert.equal(run3Res.status, 200);
  const run3 = await run3Res.json();
  assert.equal(run3.status, "active");
  assert.notEqual(run3.id, run1.id);

  // Attaching that same Programme as a SECONDARY target of Run 2 (still
  // upcoming) is likewise fine.
  const addWhileUpcomingRes = await fetch(`${server.baseUrl}/api/learning-instances/${run2.id}/targets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ programmeId: fx.programmeId }),
  });
  assert.equal(addWhileUpcomingRes.status, 201);

  // Activating Run 2 now also succeeds — one of its targets (the
  // Programme) is already claimed Active by both Run 1 and Run 3, and
  // that's no longer a conflict.
  const activateRes = await fetch(`${server.baseUrl}/api/learning-instances/${run2.id}/activate`, { method: "POST", headers });
  assert.equal(activateRes.status, 200);
  const activated = await activateRes.json();
  assert.equal(activated.status, "active");

  // All three runs remain independently active, all legitimately claiming
  // the same Programme.
  const [run1AfterRes, run2AfterRes, run3AfterRes] = await Promise.all(
    [run1.id, run2.id, run3.id].map((id) => fetch(`${server.baseUrl}/api/learning-instances/${id}`, { headers: { Cookie: adminCookie(fx.adminId) } }))
  );
  const [run1After, run2After, run3After] = await Promise.all([run1AfterRes.json(), run2AfterRes.json(), run3AfterRes.json()]);
  assert.equal(run1After.status, "active");
  assert.equal(run2After.status, "active");
  assert.equal(run3After.status, "active");

  // The primary target's is_primary row still can never be removed
  // directly — that invariant is unrelated to the concurrency amendment.
  const primaryTarget = activated.targets.find((t) => t.isPrimary);
  const removePrimaryRes = await fetch(`${server.baseUrl}/api/learning-instances/${run2.id}/targets/${primaryTarget.id}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie(fx.adminId) },
  });
  assert.equal(removePrimaryRes.status, 400);

  // But the (no-longer-conflicting) secondary Programme target can still
  // be removed like any other secondary target.
  const secondaryTarget = activated.targets.find((t) => t.programmeId === fx.programmeId && !t.isPrimary);
  const removeSecondaryRes = await fetch(`${server.baseUrl}/api/learning-instances/${run2.id}/targets/${secondaryTarget.id}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie(fx.adminId) },
  });
  assert.equal(removeSecondaryRes.status, 200);
});

test("learning-instance multi-target: unrelated Programme is unaffected by another run's targets/conflicts", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

  const run1Res = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.programmeId, name: "Run 1", status: "active" }),
  });
  const run1 = await run1Res.json();

  // A completely independent Programme, activated as its own run, must
  // succeed without any interference from Run 1's targets.
  const run2Res = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.otherProgrammeId, name: "Independent Run", status: "active" }),
  });
  assert.equal(run2Res.status, 200);
  const run2 = await run2Res.json();
  assert.equal(run2.status, "active");
  assert.notEqual(run2.id, run1.id);
});
