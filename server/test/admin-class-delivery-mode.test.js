/**
 * ABRS v2.2 §11 / §13.5 / Appendix A-9 migration coverage.
 *
 * Formerly "Stage 2 — admin-facing delivery-mode/campus configuration on
 * Learning Groups" — that configuration (Tuition Fee, Delivery Mode,
 * Campus) lived on `classes` (routes/classes.js POST/PATCH). The
 * constitution resolves the `classes` table's second, non-progression
 * usage as Operational Group (§11.5) and requires every remaining place
 * `classes` performs that responsibility to be closed (Appendix A-9).
 * This file now verifies both halves of that migration:
 *
 *   1. routes/classes.js (Programme Levels) no longer accepts writes to
 *      feeGHS/deliveryMode/campusId at all — creating or renaming a
 *      Programme Level can never set an Operational Group field again,
 *      while a pre-migration row's legacy values keep resolving
 *      unchanged (back-compat, §20.1's "additive, never destructive").
 *   2. routes/learningInstances.js's operational-groups endpoints are the
 *      sole place Tuition Fee/Delivery Mode/Campus can be set for a
 *      specific Batch/Cohort/Section, and they enforce §11.3's actual
 *      constitutional rule — an override may only name a Delivery Mode
 *      or Campus its own Programme Run has already configured, never an
 *      arbitrary one.
 *
 * Uses the same real-server-process pattern as the file it replaces
 * (fresh temp DB, migrated, real `node src/server.js`), authenticating
 * as an admin by minting a JWT directly with the test's own JWT_SECRET.
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
const JWT_SECRET = "admin-class-delivery-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-admin-class-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "admin-class-delivery-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-admin-class-uploads-"));
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

// Seeds an admin user, a Programme, an active Programme Run (learning_
// instances row + its learning_instance_targets row) already configured
// with one Delivery Mode/Campus/Fee of its own (§8.2's "Operational
// Groups are created after ... Run ... decided what it is delivering",
// §18), a legacy pre-migration class carrying its own raw delivery_mode/
// campus_id (simulating a row this migration must not disturb), and two
// campuses — one the Run has configured, one it hasn't.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'admin-test@example.com', 'x', 'active', 'paid', 1, 'ADM-0001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Admin Delivery Mode Test Programme', 0)"
    ).run(programmeId, offeringType.id);

    const runCampusId = uuid(); // configured on the Run — a valid override target
    db.prepare("INSERT INTO campuses (id, name, active, is_partner) VALUES (?, 'Run-Configured Campus', 1, 0)").run(runCampusId);
    const outsideCampusId = uuid(); // active, but NOT among the Run's own configured campuses
    db.prepare("INSERT INTO campuses (id, name, active, is_partner) VALUES (?, 'Not On This Run Campus', 1, 0)").run(outsideCampusId);

    const instanceId = uuid();
    db.prepare(
      `INSERT INTO learning_instances (id, offering_type_id, programme_id, status, delivery_modes, campus_ids, fee_ghs)
       VALUES (?, ?, ?, 'active', ?, ?, 500)`
    ).run(instanceId, offeringType.id, programmeId, JSON.stringify(["ON_CAMPUS"]), JSON.stringify([runCampusId]));
    db.prepare(
      `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status)
       VALUES (?, ?, 'programme', ?, 1, 'active')`
    ).run(uuid(), instanceId, programmeId);

    // A legacy class predating this feature — created with a raw
    // delivery_mode/campus_id already set, the shape a pre-migration row
    // carries. Nothing in this migration may touch these columns again.
    const legacyClassId = uuid();
    db.prepare(
      "INSERT INTO classes (id, name, sort_order, programme_id, delivery_mode, campus_id, fee_ghs) VALUES (?, 'Existing Legacy Batch', 0, ?, 'ON_CAMPUS', ?, 350)"
    ).run(legacyClassId, programmeId, runCampusId);

    return { adminId, programmeId, instanceId, runCampusId, outsideCampusId, legacyClassId };
  } finally {
    db.close();
  }
}

function adminCookie(adminId) {
  const token = jwt.sign({ sub: adminId, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

function readClass(dbPath, classId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  } finally {
    db.close();
  }
}

function readOperationalGroup(dbPath, id) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM operational_groups WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------
// 1. `classes` (Programme Levels) no longer owns Tuition Fee/Delivery
//    Mode/Campus — Appendix A-9's "must be re-pointed" requirement.
// ---------------------------------------------------------------------

test("classes.js: creating a Programme Level with feeGHS/deliveryMode/campusId is rejected — those are Operational Group fields now (§11.3)", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const res = await fetch(`${server.baseUrl}/api/classes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) },
      body: JSON.stringify({ name: "New Batch", programmeId: fx.programmeId, deliveryMode: "ON_CAMPUS", campusId: fx.runCampusId }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Operational Group/);
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) AS n FROM classes WHERE name = 'New Batch'").get().n;
    db.close();
    assert.equal(count, 0, "the rejected request must not have inserted a row");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("classes.js: a plain create (name only) still succeeds, with fee/delivery/campus left NULL", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const res = await fetch(`${server.baseUrl}/api/classes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) },
      body: JSON.stringify({ name: "Plain New Level", programmeId: fx.programmeId }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.deliveryMode, "ON_CAMPUS", "still resolves through its Programme Run's own single configured mode — read-side fallback unaffected");
    const row = readClass(dbPath, body.id);
    assert.equal(row.delivery_mode, null, "raw column is never written by this endpoint");
    assert.equal(row.fee_ghs, null);
    assert.equal(row.campus_id, null);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("classes.js: PATCH rejects feeGHS/deliveryMode/campusId, and renaming a legacy class never touches its pre-existing override columns", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));

    const rejectRes = await fetch(`${server.baseUrl}/api/classes/${fx.legacyClassId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) },
      body: JSON.stringify({ feeGHS: 999 }),
    });
    assert.equal(rejectRes.status, 400);

    const renameRes = await fetch(`${server.baseUrl}/api/classes/${fx.legacyClassId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) },
      body: JSON.stringify({ name: "Existing Legacy Batch Renamed" }),
    });
    const renameBody = await renameRes.json();
    assert.equal(renameRes.status, 200, JSON.stringify(renameBody));
    assert.equal(renameBody.name, "Existing Legacy Batch Renamed");

    // Legacy pre-migration values are untouched (back-compat read-side
    // resolution keeps working; the endpoint just never writes them again).
    const row = readClass(dbPath, fx.legacyClassId);
    assert.equal(row.delivery_mode, "ON_CAMPUS");
    assert.equal(row.campus_id, fx.runCampusId);
    assert.equal(row.fee_ghs, 350);
    assert.equal(renameBody.deliveryMode, "ON_CAMPUS", "GET-side resolution still reflects the legacy value");
    assert.equal(renameBody.feeGHS, 350);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 2. Operational Groups are the sole owner of these fields from here on,
//    and may only override what their own Programme Run has configured
//    (§11.3's "may not override ... a field the Programme Run does not
//    itself already own").
// ---------------------------------------------------------------------

test("operational-groups: create with a Delivery Mode/Campus the Run has actually configured succeeds", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const res = await fetch(`${server.baseUrl}/api/learning-instances/${fx.instanceId}/operational-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) },
      body: JSON.stringify({ name: "Weekend Batch", deliveryMode: "ON_CAMPUS", campusId: fx.runCampusId, feeGHS: 650 }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.overrides.deliveryMode, "ON_CAMPUS");
    assert.equal(body.overrides.campusId, fx.runCampusId);
    assert.equal(body.overrides.feeGHS, 650);
    const row = readOperationalGroup(dbPath, body.id);
    assert.equal(row.delivery_mode, "ON_CAMPUS");
    assert.equal(row.campus_id, fx.runCampusId);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("operational-groups: a Campus the Run has NOT configured is rejected on create — an Operational Group can't introduce a field its Run doesn't own", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const res = await fetch(`${server.baseUrl}/api/learning-instances/${fx.instanceId}/operational-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) },
      body: JSON.stringify({ name: "Off-Run Campus Batch", deliveryMode: "ON_CAMPUS", campusId: fx.outsideCampusId }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Programme Run's own configured campuses/);
    const count = readOperationalGroup(dbPath, "nonexistent");
    assert.equal(count, undefined);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("operational-groups: a Delivery Mode the Run has NOT configured (e.g. ONLINE on an ON_CAMPUS-only Run) is rejected", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const res = await fetch(`${server.baseUrl}/api/learning-instances/${fx.instanceId}/operational-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) },
      body: JSON.stringify({ name: "Online Batch", deliveryMode: "ONLINE" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Programme Run's own configured delivery modes/);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("operational-groups: a group with no fee override inherits the Run's fee; renaming it never introduces one", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const createRes = await fetch(`${server.baseUrl}/api/learning-instances/${fx.instanceId}/operational-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) },
      body: JSON.stringify({ name: "Inherits Run Fee" }),
    });
    const created = await createRes.json();
    assert.equal(createRes.status, 201, JSON.stringify(created));
    assert.equal(created.overrides.feeGHS, null, "NULL = inherit, never backfilled at creation time (§11.3)");

    const renameRes = await fetch(`${server.baseUrl}/api/learning-instances/${fx.instanceId}/operational-groups/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) },
      body: JSON.stringify({ name: "Inherits Run Fee (renamed)" }),
    });
    const renamed = await renameRes.json();
    assert.equal(renameRes.status, 200, JSON.stringify(renamed));
    assert.equal(renamed.overrides.feeGHS, null);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
