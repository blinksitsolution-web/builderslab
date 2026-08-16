/**
 * Phase 5 — Period-specific target configuration.
 *
 * A Learning Instance's academic periods (Phase 4) each get their OWN
 * explicit set of targets drawn from the run's general target list (Stage
 * 4C/4E's learning_instance_targets) — never assumed to match another
 * period's. Locks in:
 *  - a period starts with zero configured targets;
 *  - only targets already attached to the run can be assigned to a period;
 *  - two periods can be given the exact same set (option 1) or different
 *    sets (option 2), independently;
 *  - resolving "active and available targets" for a learner intersects a
 *    period's configured targets with that learner's actual enrolments.
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
const JWT_SECRET = "learning-instance-period-targets-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-li-period-targets-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "learning-instance-period-targets-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-li-period-targets-uploads-"));
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
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'li-period-targets-admin@example.com', 'x', 'active', 'paid', 1, 'ADM-LIPT-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'LI Period Targets Test Programme', 70)").run(programmeId, offeringType.id);

    const moduleAId = "li-pt-mod-a";
    db.prepare("INSERT INTO courses (id, title, programme_id, is_open) VALUES (?, 'LI Period Targets Module A', ?, 1)").run(moduleAId, programmeId);
    const moduleBId = "li-pt-mod-b";
    db.prepare("INSERT INTO courses (id, title, programme_id, is_open) VALUES (?, 'LI Period Targets Module B', ?, 1)").run(moduleBId, programmeId);

    // A learner enrolled only in Module A (not B) — used to prove the
    // learner-scoped resolution intersects with actual enrolment.
    const learnerId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, status, payment_status, student_code, joined_date) VALUES (?, 'learner', 'Test Learner', 'li-period-targets-learner@example.com', 'active', 'current', 'LRN-LIPT-0001', date('now'))"
    ).run(learnerId);
    db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(learnerId, moduleAId);

    return { adminId, offeringTypeId: offeringType.id, programmeId, moduleAId, moduleBId, learnerId };
  } finally {
    db.close();
  }
}

test("learning-instance period targets: a new period starts with zero targets; targets must already belong to the run", async (t) => {
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
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, courseId: fx.moduleAId, name: "Period Targets Run", status: "upcoming" }),
  });
  const created = await createRes.json();

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await structRes.json();
  const period1 = withStructure.academicPeriods.find((p) => p.sequence === 1);
  const period2 = withStructure.academicPeriods.find((p) => p.sequence === 2);
  assert.deepEqual(period1.targets, []);
  assert.deepEqual(period2.targets, []);

  // Module A is already the primary target (attached at creation).
  const primaryTargetId = withStructure.targets[0].id;

  // A targetId that isn't attached to this run at all is rejected.
  const badRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/targets`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ targetIds: ["not-a-real-target-id"] }),
  });
  assert.equal(badRes.status, 400);

  // Assigning the run's actual (primary) target succeeds.
  const okRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/targets`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ targetIds: [primaryTargetId] }),
  });
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.equal(okBody.targets.length, 1);
  assert.equal(okBody.targets[0].id, primaryTargetId);

  // Period 2 is still untouched/empty — no auto-inheritance.
  const period2GetRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period2.id}/targets`, { headers: { Cookie: adminCookie(fx.adminId) } });
  const period2Body = await period2GetRes.json();
  assert.deepEqual(period2Body.targets, []);
});

test("learning-instance period targets: two periods can share the same target set (option 1) or differ (option 2)", async (t) => {
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
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, courseId: fx.moduleAId, name: "Multi-Target Period Run", status: "upcoming" }),
  });
  const created = await createRes.json();

  // Attach Module B as a secondary target of the run too.
  const addRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/targets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ courseId: fx.moduleBId }),
  });
  const withTargets = await addRes.json();
  const targetA = withTargets.targets.find((t) => t.courseId === fx.moduleAId);
  const targetB = withTargets.targets.find((t) => t.courseId === fx.moduleBId);

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ structure: "term" }),
  });
  const withStructure = await structRes.json();
  const [p1, p2, p3] = withStructure.academicPeriods.sort((a, b) => a.sequence - b.sequence);

  // Period 1: both targets.
  await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${p1.id}/targets`, {
    method: "PUT", headers, body: JSON.stringify({ targetIds: [targetA.id, targetB.id] }),
  });
  // Period 2: the SAME set as period 1 (option 1 — "same targets as another period").
  await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${p2.id}/targets`, {
    method: "PUT", headers, body: JSON.stringify({ targetIds: [targetA.id, targetB.id] }),
  });
  // Period 3: only Module A (option 2 — a different set).
  await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${p3.id}/targets`, {
    method: "PUT", headers, body: JSON.stringify({ targetIds: [targetA.id] }),
  });

  const p1Res = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${p1.id}/targets`, { headers: { Cookie: adminCookie(fx.adminId) } });
  const p2Res = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${p2.id}/targets`, { headers: { Cookie: adminCookie(fx.adminId) } });
  const p3Res = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${p3.id}/targets`, { headers: { Cookie: adminCookie(fx.adminId) } });
  const p1Targets = (await p1Res.json()).targets;
  const p2Targets = (await p2Res.json()).targets;
  const p3Targets = (await p3Res.json()).targets;

  assert.equal(p1Targets.length, 2);
  assert.equal(p2Targets.length, 2);
  assert.equal(p3Targets.length, 1);
  assert.equal(p3Targets[0].courseId, fx.moduleAId);

  // Re-configuring Period 1 to drop Module B doesn't touch Period 2 at all
  // (each period's association is independent, never a shared reference).
  await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${p1.id}/targets`, {
    method: "PUT", headers, body: JSON.stringify({ targetIds: [targetA.id] }),
  });
  const p2AfterRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${p2.id}/targets`, { headers: { Cookie: adminCookie(fx.adminId) } });
  const p2AfterTargets = (await p2AfterRes.json()).targets;
  assert.equal(p2AfterTargets.length, 2, "Period 2 must be unaffected by Period 1's re-configuration");
});

test("learning-instance period targets: resolving a learner's active/available targets intersects the period's targets with actual enrolment", async (t) => {
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
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, courseId: fx.moduleAId, name: "Learner Resolution Run", status: "upcoming" }),
  });
  const created = await createRes.json();
  const addRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/targets`, {
    method: "POST", headers, body: JSON.stringify({ courseId: fx.moduleBId }),
  });
  const withTargets = await addRes.json();
  const targetA = withTargets.targets.find((t) => t.courseId === fx.moduleAId);
  const targetB = withTargets.targets.find((t) => t.courseId === fx.moduleBId);

  const structRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-structure`, {
    method: "PATCH", headers, body: JSON.stringify({ structure: "semester" }),
  });
  const withStructure = await structRes.json();
  const period1 = withStructure.academicPeriods.find((p) => p.sequence === 1);

  // Period exposes BOTH modules...
  await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/targets`, {
    method: "PUT", headers, body: JSON.stringify({ targetIds: [targetA.id, targetB.id] }),
  });

  // ...but the learner (fixture) is only actually enrolled in Module A, so
  // only Module A should resolve as "active and available" for them.
  const resolveRes = await fetch(
    `${server.baseUrl}/api/learning-instances/${created.id}/academic-periods/${period1.id}/learners/${fx.learnerId}/active-targets`,
    { headers: { Cookie: adminCookie(fx.adminId) } }
  );
  assert.equal(resolveRes.status, 200);
  const resolved = await resolveRes.json();
  assert.equal(resolved.targets.length, 1);
  assert.equal(resolved.targets[0].courseId, fx.moduleAId);
});
