/**
 * Regression test: GET /api/learning-offerings/programme-runs/registration-config
 * must narrow participationStructureOptions down to a Learning Instance's
 * (Programme Run's) own configured Participation Structure, when it has
 * one, rather than always returning the Programme's full menu.
 *
 * Scenario (as reported): a Kids STEM Builders' Lab Programme has more
 * than one Participation Structure available (e.g. Structured School
 * Club and Individual Course). One of its Learning Instances — "WIS
 * 2026" — is configured with participationStructure:
 * "structured_school_club". A parent registering a learner into WIS 2026
 * must only ever see "Structured School Club" as a choice; letting them
 * pick "Individual Course" for a Run that was never configured to run
 * that structure breaks downstream assumptions
 * (resolveActiveInstanceForRegistration / entry-class resolution /
 * promotion all trust a Run's registrants share its configured
 * structure).
 *
 * Same real-server-process pattern as builderslab-architecture.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const Database = require("better-sqlite3");
const { v4: uuid } = require("uuid");

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");
const JWT_SECRET = "reg-config-instance-ps-scoping-test-secret-key";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-config-ps-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "reg-config-instance-ps-scoping-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-config-ps-uploads-"));
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

function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const kidsOfferingType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'WIS Test Programme', 0)").run(programmeId, kidsOfferingType.id);

    // WIS 2026 — an Active Learning Instance explicitly configured with
    // "structured_school_club" as ITS OWN Participation Structure.
    const wis2026Id = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, name, status, registration_fee_ghs, participation_structure) VALUES (?, ?, ?, 'WIS 2026', 'active', 350, 'structured_school_club')"
    ).run(wis2026Id, kidsOfferingType.id, programmeId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), wis2026Id, programmeId);

    // A sibling Programme with an Active Run that has NO configured
    // Participation Structure yet (participation_structure stays NULL) —
    // proves the legacy/unconfigured case keeps seeing the full menu.
    const legacyProgrammeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Legacy Unconfigured Programme', 1)").run(legacyProgrammeId, kidsOfferingType.id);
    const legacyRunId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)"
    ).run(legacyRunId, kidsOfferingType.id, legacyProgrammeId);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), legacyRunId, legacyProgrammeId);

    return { programmeId, wis2026Id, legacyProgrammeId, legacyRunId };
  } finally {
    db.close();
  }
}

test("registration-config narrows participationStructureOptions to a Learning Instance's own configured Participation Structure", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());

    // WIS 2026 is the Programme's only Active Run, so no instanceId is
    // even needed to resolve it — mirrors exactly what a parent's browser
    // calls the moment they pick this Programme on the registration page.
    const res = await fetch(`${server.baseUrl}/api/learning-offerings/programme-runs/registration-config?programmeId=${fx.programmeId}`);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.hasActiveRun, true);
    assert.equal(body.instanceId, fx.wis2026Id);
    assert.equal(body.instanceName, "WIS 2026");
    assert.equal(body.runParticipationStructure, "structured_school_club");

    // The whole point: only ONE option comes back, and it's the Run's own
    // configured structure — never "individual_course" or
    // "structured_other", even though this Programme's offering type
    // (kids_stem) would otherwise make those valid choices too.
    assert.equal(body.participationStructureOptions.length, 1);
    assert.equal(body.participationStructureOptions[0].key, "structured_school_club");
    assert.equal(body.participationStructureOptions[0].name, "Structured School Club");

    // Sibling Programme's Run has no configured Participation Structure
    // (participation_structure: null) — unchanged, historical behaviour:
    // the full Programme-scoped menu is still offered.
    const legacyRes = await fetch(`${server.baseUrl}/api/learning-offerings/programme-runs/registration-config?programmeId=${fx.legacyProgrammeId}`);
    const legacyBody = await legacyRes.json();
    assert.equal(legacyRes.status, 200, JSON.stringify(legacyBody));
    assert.equal(legacyBody.hasActiveRun, true);
    assert.equal(legacyBody.runParticipationStructure, null);
    assert.equal(legacyBody.participationStructureOptions.length, 3);
    assert.deepEqual(
      legacyBody.participationStructureOptions.map((s) => s.key).sort(),
      ["individual_course", "structured_other", "structured_school_club"]
    );
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
