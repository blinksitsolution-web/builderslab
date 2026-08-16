/**
 * §21 Reporting — GET /api/learning-instances/dashboard-stats.
 *
 * Locks in that Programme/Course filtering on this report resolves
 * through learning_instance_targets (the constitutional multi-target
 * owner, Section 8.4/9), not through the legacy li.programme_id/
 * li.course_id primary-only columns. A Run whose Programme/Course is
 * attached as a SECONDARY target must still be found and counted when
 * the report is filtered by that Programme/Course — before this fix it
 * was silently dropped.
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
const JWT_SECRET = "dashboard-stats-reporting-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-dashboard-stats-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "dashboard-stats-reporting-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-dashboard-stats-uploads-"));
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
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'dashboard-stats-admin@example.com', 'x', 'active', 'paid', 1, 'ADM-DASH-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    const primaryProgrammeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Dashboard Stats Primary Programme', 60)").run(primaryProgrammeId, offeringType.id);

    const secondaryProgrammeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Dashboard Stats Secondary Programme', 61)").run(secondaryProgrammeId, offeringType.id);

    return { adminId, offeringTypeId: offeringType.id, primaryProgrammeId, secondaryProgrammeId };
  } finally {
    db.close();
  }
}

test("dashboard-stats reporting: a Run is found when filtered by a SECONDARY target Programme, not just its primary target", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  assert.ok(await waitForReady(server.baseUrl, 15000), `server failed to start: ${server.getStderr()}`);

  const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

  // Create an active Run whose PRIMARY target is Programme A.
  const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({ offeringTypeId: fx.offeringTypeId, programmeId: fx.primaryProgrammeId, name: "Dashboard Stats Run", status: "active" }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();

  // Attach Programme B as a SECONDARY target of the same run.
  const addTargetRes = await fetch(`${server.baseUrl}/api/learning-instances/${created.id}/targets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ programmeId: fx.secondaryProgrammeId }),
  });
  assert.equal(addTargetRes.status, 201);

  // Filtering the report by the PRIMARY programme finds the run (this
  // already worked before the fix).
  const primaryStatsRes = await fetch(`${server.baseUrl}/api/learning-instances/dashboard-stats?programmeId=${fx.primaryProgrammeId}`, { headers: { Cookie: adminCookie(fx.adminId) } });
  assert.equal(primaryStatsRes.status, 200);
  const primaryStats = await primaryStatsRes.json();
  assert.ok(primaryStats.instances.some((i) => i.id === created.id), "run should be found when filtered by its primary target Programme");

  // Filtering by the SECONDARY programme must ALSO find the run — this is
  // the bug: before the fix, the report only ever matched li.programme_id
  // (the primary target column) and silently excluded the run here.
  const secondaryStatsRes = await fetch(`${server.baseUrl}/api/learning-instances/dashboard-stats?programmeId=${fx.secondaryProgrammeId}`, { headers: { Cookie: adminCookie(fx.adminId) } });
  assert.equal(secondaryStatsRes.status, 200);
  const secondaryStats = await secondaryStatsRes.json();
  assert.ok(secondaryStats.instances.some((i) => i.id === created.id), "run should ALSO be found when filtered by its secondary target Programme");

  // Filtering by an unrelated Programme must NOT find the run.
  const unrelatedStatsRes = await fetch(`${server.baseUrl}/api/learning-instances/dashboard-stats?programmeId=${uuid()}`, { headers: { Cookie: adminCookie(fx.adminId) } });
  assert.equal(unrelatedStatsRes.status, 200);
  const unrelatedStats = await unrelatedStatsRes.json();
  assert.ok(!unrelatedStats.instances.some((i) => i.id === created.id), "run should not appear for a Programme it has no target relationship with");
});
