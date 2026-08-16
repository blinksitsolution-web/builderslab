/**
 * Admin Workflow Redesign checkpoint (Programme Definition + Participation
 * Structure Administration) — targeted coverage for the new
 * routes/learningOfferings.js surfaces:
 *
 *   - GET  /programmes/:id/participation-structures/manage (admin, all
 *     statuses, distinct from the pre-existing active-only public route)
 *   - POST /programmes/:id/participation-structures (create)
 *   - PATCH /participation-structures/:id (edit)
 *   - POST /participation-structures/:id/activate|deactivate|retire
 *   - The `usesProgrammeLevels` / `programmeDefinitionStatus` fields now
 *     attached to GET /programmes and GET /programmes/:id.
 *
 * Same real-server-process pattern as admin-class-delivery-mode.test.js
 * (fresh temp DB, migrated, real `node src/server.js`, admin JWT minted
 * directly) — reused here rather than invented fresh, since it is the
 * established pattern for admin-route coverage in this codebase.
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
const JWT_SECRET = "pps-admin-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-pps-admin-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "pps-admin-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-pps-admin-uploads-"));
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

// Seeds a Super Administrator (full permissions, including
// learningOfferings.edit) and a plain admin restricted to a permission-less
// custom set (Option 2), plus one fresh Programme with no Participation
// Structures or Learning Groups yet.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    if (!superAdminTemplate) throw new Error("Super Administrator template not seeded by migrate.js as expected.");

    const superAdminId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Super Admin', 'pps-super-admin-test@example.com', 'x', 'active', 'paid', 1, 'ADM-9001', date('now'), ?)"
    ).run(superAdminId, superAdminTemplate.id);

    // An admin with an explicit, empty custom permission set (Option 2) —
    // authenticated, but must be refused by every requirePermission("learningOfferings.edit") route.
    const restrictedAdminId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, custom_permissions) VALUES (?, 'admin', 'Test Restricted Admin', 'pps-restricted-admin-test@example.com', 'x', 'active', 'paid', 1, 'ADM-9002', date('now'), '[]')"
    ).run(restrictedAdminId);

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare(
      "INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'PPS Admin Test Programme', 0)"
    ).run(programmeId, offeringType.id);

    return { superAdminId, restrictedAdminId, programmeId };
  } finally {
    db.close();
  }
}

function adminCookie(userId) {
  const token = jwt.sign({ sub: userId, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

function insertClass(dbPath, programmeId, name) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id) VALUES (?, ?, 0, ?)").run(id, name, programmeId);
    return id;
  } finally {
    db.close();
  }
}

test("Participation Structure Administration + Programme Definition status", async (t) => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  const superAdmin = adminCookie(fx.superAdminId);
  const restrictedAdmin = adminCookie(fx.restrictedAdminId);

  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());

    await t.test("(1) a fresh Programme has no Participation Structures and an incomplete Programme Definition", async () => {
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}`, {
        headers: { Cookie: superAdmin },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.deepEqual(body.participationStructures, []);
      assert.equal(body.usesProgrammeLevels, false);
      assert.equal(body.programmeDefinitionStatus.complete, false);
      const psStep = body.programmeDefinitionStatus.steps.find((s) => s.id === "participationStructures");
      assert.equal(psStep.complete, false);
      // Programme Levels isn't applicable yet — no Participation Structure
      // has requested progression, so it must not appear as missing.
      const levelsStep = body.programmeDefinitionStatus.steps.find((s) => s.id === "programmeLevels");
      assert.equal(levelsStep.applicable, false);
      assert.ok(!body.programmeDefinitionStatus.missingSteps.includes("Programme Levels"));
    });

    await t.test("(2) the admin manage route requires auth but not the create permission", async () => {
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}/participation-structures/manage`, {
        headers: { Cookie: restrictedAdmin },
      });
      assert.equal(res.status, 200);
    });

    await t.test("(3) a restricted admin (no learningOfferings.edit) cannot create a Participation Structure", async () => {
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}/participation-structures`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: restrictedAdmin },
        body: JSON.stringify({ name: "Weekend Track", usesProgrammeLevels: true }),
      });
      assert.equal(res.status, 403);
    });

    let structureId;
    await t.test("(4) a Super Administrator can create a Participation Structure, key auto-slugified", async () => {
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}/participation-structures`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: superAdmin },
        body: JSON.stringify({
          name: "Weekend Track",
          usesProgrammeLevels: true,
          usesPromotion: true,
          requiresCourseSelection: false,
          registrantRole: "self",
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.key, "weekend_track");
      assert.equal(body.usesProgrammeLevels, true);
      assert.equal(body.isActive, true);
      assert.equal(body.retiredAt, null);
      structureId = body.id;
    });

    await t.test("(5) creating a second Participation Structure with the same derived key is rejected", async () => {
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}/participation-structures`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: superAdmin },
        body: JSON.stringify({ name: "Weekend Track" }),
      });
      assert.equal(res.status, 400);
    });

    await t.test("(6) an invalid registrantRole is rejected", async () => {
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}/participation-structures`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: superAdmin },
        body: JSON.stringify({ name: "Bogus Role Track", registrantRole: "nonsense" }),
      });
      assert.equal(res.status, 400);
    });

    await t.test("(7) Programme now reports usesProgrammeLevels=true and an applicable-but-incomplete Programme Levels step", async () => {
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}`, {
        headers: { Cookie: superAdmin },
      });
      const body = await res.json();
      assert.equal(body.usesProgrammeLevels, true);
      const levelsStep = body.programmeDefinitionStatus.steps.find((s) => s.id === "programmeLevels");
      assert.equal(levelsStep.applicable, true);
      assert.equal(levelsStep.complete, false);
      assert.ok(body.programmeDefinitionStatus.missingSteps.includes("Programme Levels"));
    });

    await t.test("(8) the Programmes list also carries usesProgrammeLevels, agreeing with the detail route", async () => {
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes?all=true`, { headers: { Cookie: superAdmin } });
      const body = await res.json();
      const row = body.programmes.find((p) => p.id === fx.programmeId);
      assert.equal(row.usesProgrammeLevels, true);
    });

    await t.test("(9) once a Learning Group (class) exists, the Programme Levels step completes", async () => {
      insertClass(dbPath, fx.programmeId, "Foundation");
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}`, {
        headers: { Cookie: superAdmin },
      });
      const body = await res.json();
      const levelsStep = body.programmeDefinitionStatus.steps.find((s) => s.id === "programmeLevels");
      assert.equal(levelsStep.complete, true);
    });

    await t.test("(10) editing the Participation Structure's name/flags persists", async () => {
      const res = await fetch(`${server.baseUrl}/api/learning-offerings/participation-structures/${structureId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: superAdmin },
        body: JSON.stringify({ name: "Weekend Track (renamed)", usesPromotion: false }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.name, "Weekend Track (renamed)");
      assert.equal(body.usesPromotion, false);
      // key is stable/immutable across edits
      assert.equal(body.key, "weekend_track");
    });

    await t.test("(11) deactivate is reversible via activate", async () => {
      let res = await fetch(`${server.baseUrl}/api/learning-offerings/participation-structures/${structureId}/deactivate`, {
        method: "POST",
        headers: { Cookie: superAdmin },
      });
      let body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.isActive, false);

      res = await fetch(`${server.baseUrl}/api/learning-offerings/participation-structures/${structureId}/activate`, {
        method: "POST",
        headers: { Cookie: superAdmin },
      });
      body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.isActive, true);
    });

    await t.test("(12) retire is terminal: sets retiredAt, and blocks further edit/activate/deactivate/re-retire", async () => {
      let res = await fetch(`${server.baseUrl}/api/learning-offerings/participation-structures/${structureId}/retire`, {
        method: "POST",
        headers: { Cookie: superAdmin },
      });
      let body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.isActive, false);
      assert.ok(body.retiredAt);

      res = await fetch(`${server.baseUrl}/api/learning-offerings/participation-structures/${structureId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: superAdmin },
        body: JSON.stringify({ name: "Should not apply" }),
      });
      assert.equal(res.status, 400);

      res = await fetch(`${server.baseUrl}/api/learning-offerings/participation-structures/${structureId}/activate`, {
        method: "POST",
        headers: { Cookie: superAdmin },
      });
      assert.equal(res.status, 400);

      res = await fetch(`${server.baseUrl}/api/learning-offerings/participation-structures/${structureId}/deactivate`, {
        method: "POST",
        headers: { Cookie: superAdmin },
      });
      assert.equal(res.status, 400);

      res = await fetch(`${server.baseUrl}/api/learning-offerings/participation-structures/${structureId}/retire`, {
        method: "POST",
        headers: { Cookie: superAdmin },
      });
      assert.equal(res.status, 400);
    });

    await t.test("(13) the public active-only route no longer lists the retired structure, but /manage still does", async () => {
      let res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}/participation-structures`);
      let body = await res.json();
      assert.equal(body.participationStructures.length, 0);

      res = await fetch(`${server.baseUrl}/api/learning-offerings/programmes/${fx.programmeId}/participation-structures/manage`, {
        headers: { Cookie: superAdmin },
      });
      body = await res.json();
      assert.equal(body.participationStructures.length, 1);
      assert.equal(body.participationStructures[0].id, structureId);
      assert.ok(body.participationStructures[0].retiredAt);
    });
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
