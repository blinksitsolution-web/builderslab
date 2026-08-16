/**
 * Regression tests for two follow-ups to the v31 Programme Run
 * operational-ownership migration:
 *
 *   (v32) Registration Window ownership moves from `programmes` to the
 *   Programme Run (`learning_instances`) — legacy Programme-level dates
 *   now act only as a fallback for a Programme whose active Run hasn't
 *   configured its own window. See utils/learningInstances.js's
 *   resolveProgrammeRegistrationOpen() and migrate.js's v32 comment.
 *
 *   Instructor Assignment completion — GET /api/users' additive
 *   role=instructor + programmeId/offeringTypeId eligibility filter,
 *   used by the Programme Run admin UI's instructor selector.
 *
 * Same real-server-process pattern as builderslab-architecture.test.js
 * (fresh temp DB, migrated, real `node src/server.js`).
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
const JWT_SECRET = "registration-window-instructor-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-regwin-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "registration-window-instructor-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-regwin-uploads-"));
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
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'admin-regwin-test@example.com', 'x', 'active', 'paid', 1, 'ADM-9101', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const kidsOfferingType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();

    const programmeId = uuid();
    // Registration Window ownership consolidation (ABRS v2.2 §2.1/§8.2/§16):
    // `programmes` no longer has any registration_* columns at all — only
    // the Programme Run (`learning_instances`) owns a registration window.
    // Programme-level registration windows are constitutionally prohibited.
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'RegWin Test Programme', 0)").run(
      programmeId,
      kidsOfferingType.id
    );

    const otherProgrammeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'RegWin Other Programme', 1)").run(
      otherProgrammeId,
      kidsOfferingType.id
    );

    const entryClassId = uuid();
    db.prepare("INSERT INTO classes (id, name, programme_id, sort_order) VALUES (?, 'RegWin Entry Class', ?, 0)").run(entryClassId, programmeId);

    // Adult-audience fixture (Kids STEM requires a parent account, so the
    // adult self-registration bypass test needs a programme under an
    // offering type that actually allows adult audience).
    const adultOfferingType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const adultProgrammeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'RegWin Adult Programme', 2)").run(
      adultProgrammeId,
      adultOfferingType.id
    );
    const adultEntryClassId = uuid();
    db.prepare("INSERT INTO classes (id, name, programme_id, sort_order) VALUES (?, 'RegWin Adult Entry Class', ?, 0)").run(adultEntryClassId, adultProgrammeId);

    return {
      adminId,
      programmeId,
      otherProgrammeId,
      kidsOfferingTypeId: kidsOfferingType.id,
      entryClassId,
      adultProgrammeId,
      adultEntryClassId,
    };
  } finally {
    db.close();
  }
}

test("Registration Window (v32/consolidation): no Programme-level fallback exists; only the Programme Run's own window governs, and an unconfigured Run is open by default", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

    function registerPayload() {
      return {
        kind: "parent-learner",
        classId: fx.entryClassId,
        participationStructure: "structured_school_club",
        parent: { name: "RegWin Parent", email: `regwin-${uuid()}@example.test`, password: "parentpass123" },
        learner: { name: "RegWin Child", dateOfBirth: "2016-01-01" },
      };
    }

    // 1) No Run at all yet -> CLOSED. Registration Source of Truth:
    //    registration is only ever permitted through an ACTIVE Programme
    //    Run — there is no Programme-level fallback at all any more
    //    (`programmes` has no registration_* columns to fall back to;
    //    Single Ownership Principle §2.1/§8.2/§16). The classId branch's
    //    own registration-window check (resolveProgrammeRegistrationOpen,
    //    which returns false with no Active Run) fires first here, giving
    //    a 409 with the generic "currently closed" message.
    const noRunRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerPayload()),
    });
    assert.equal(noRunRes.status, 409, JSON.stringify(await noRunRes.clone().json()));
    const noRunBody = await noRunRes.json();
    assert.match(noRunBody.error, /no available registration opportunities|registration.*closed/i);

    // The public programmes listing agrees: registrationOpen is false.
    const listBeforeRunRes = await fetch(`${server.baseUrl}/api/learning-offerings/programmes?offeringTypeId=${fx.kidsOfferingTypeId}`, { headers });
    const listBeforeRun = await listBeforeRunRes.json();
    const progBeforeRun = listBeforeRun.programmes.find((p) => p.id === fx.programmeId);
    assert.equal(progBeforeRun.registrationOpen, false);

    // 2) Create + activate a Programme Run for this Programme, WITHOUT
    //    configuring its own registration window at all -> OPEN BY
    //    DEFAULT. This is the corrected behaviour: an Active Run with no
    //    registration fields touched is simply unrestricted (the same
    //    "not configured yet = unrestricted" convention every other
    //    nullable operational-config field in this codebase already
    //    uses) — never a reason to consult the Programme, which no longer
    //    has anything to consult.
    const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offeringTypeId: fx.kidsOfferingTypeId, programmeId: fx.programmeId }),
    });
    assert.equal(createRes.status, 200, JSON.stringify(await createRes.clone().json()));
    const instance = await createRes.json();
    const activateRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/activate`, { method: "POST", headers });
    assert.equal(activateRes.status, 200, JSON.stringify(await activateRes.json()));

    assert.equal(instance.registrationWindowConfigured, false);
    assert.equal(instance.registrationOpensAt, null);

    // A newly created Run has no Registration Fee of its own (§15.1/§19 —
    // the pricing engine no longer silently substitutes the legacy
    // site-wide fee once a Run is in context; see pricingEngine.js's
    // resolveStandardBaseAmount()), so it must be configured here purely
    // so registration can price itself. This is orthogonal to the
    // Registration Window under test: setting only registrationFeeGHS
    // leaves registration_opens_at/deadline/force_* untouched, so
    // registrationWindowConfigured stays false as asserted above.
    const configFeeRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ registrationFeeGHS: 350 }),
    });
    assert.equal(configFeeRes.status, 200, JSON.stringify(await configFeeRes.clone().json()));

    const openByDefaultRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerPayload()),
    });
    assert.equal(
      openByDefaultRes.status,
      200,
      JSON.stringify(await openByDefaultRes.clone().json()),
      "an Active Run with no registration window configured must be open by default"
    );

    const listAfterActivateRes = await fetch(`${server.baseUrl}/api/learning-offerings/programmes?offeringTypeId=${fx.kidsOfferingTypeId}`, { headers });
    const listAfterActivate = await listAfterActivateRes.json();
    assert.equal(listAfterActivate.programmes.find((p) => p.id === fx.programmeId).registrationOpen, true);

    // 3) Configure the RUN's own deadline into the past -> now closed,
    //    purely from the Run's own field (no Programme column involved).
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const configDeadlineRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ registrationDeadline: past }),
    });
    assert.equal(configDeadlineRes.status, 200, JSON.stringify(await configDeadlineRes.clone().json()));
    const configuredDeadline = await configDeadlineRes.json();
    assert.equal(configuredDeadline.registrationWindowConfigured, true);
    assert.equal(configuredDeadline.registrationOpen, false);

    const closedByDeadlineRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerPayload()),
    });
    assert.equal(closedByDeadlineRes.status, 409);

    // 4) Force-open despite the past deadline -> the explicit override
    //    wins over the Run's own deadline field.
    const configOpenRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ registrationForceOpen: true }),
    });
    assert.equal(configOpenRes.status, 200, JSON.stringify(await configOpenRes.clone().json()));
    const configuredOpen = await configOpenRes.json();
    assert.equal(configuredOpen.registrationForceOpen, true);
    assert.equal(configuredOpen.registrationOpen, true);

    const openViaForceRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerPayload()),
    });
    assert.equal(openViaForceRes.status, 200, JSON.stringify(await openViaForceRes.clone().json()), "force-open should override the Run's own past deadline");

    const listAfterForceOpenRes = await fetch(`${server.baseUrl}/api/learning-offerings/programmes?offeringTypeId=${fx.kidsOfferingTypeId}`, { headers });
    const listAfterForceOpen = await listAfterForceOpenRes.json();
    assert.equal(listAfterForceOpen.programmes.find((p) => p.id === fx.programmeId).registrationOpen, true);

    // 5) Flip the RUN to force-closed -> closed again.
    const configClosedRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ registrationForceOpen: false, registrationForceClosed: true }),
    });
    assert.equal(configClosedRes.status, 200, JSON.stringify(await configClosedRes.clone().json()));
    const configuredClosed = await configClosedRes.json();
    assert.equal(configuredClosed.registrationOpen, false);

    const closedViaRunRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerPayload()),
    });
    assert.equal(closedViaRunRes.status, 409);

    // 6) The registration-config endpoint surfaces the Run's window fields
    //    directly, for the (future) registration UI to consume.
    const regConfigRes = await fetch(`${server.baseUrl}/api/learning-offerings/programme-runs/registration-config?programmeId=${fx.programmeId}`);
    const regConfig = await regConfigRes.json();
    assert.equal(regConfigRes.status, 200, JSON.stringify(regConfig));
    assert.equal(regConfig.registrationForceClosed, true);
    assert.equal(regConfig.registrationOpen, false);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("Registration Window bypass fix: a bare programmeId (no explicit classId) must still enforce the registration window, on every self-registration path", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

    // Close registration via each Programme's own Active Run (Registration
    // Window ownership consolidation — `programmes` has no registration_*
    // columns any more; only a Programme Run can be closed). Using a
    // force-closed Active Run here, rather than just leaving no Run at
    // all, is deliberate: it isolates the assertion to "does the
    // programmeId-only branch actually check the Run's registration
    // window", rather than incidentally passing only because of the
    // separate no-active-run catch-all.
    async function createClosedRun(programmeId, offeringTypeId) {
      const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
        method: "POST",
        headers,
        body: JSON.stringify({ offeringTypeId, programmeId }),
      });
      const instance = await createRes.json();
      assert.equal(createRes.status, 200, JSON.stringify(instance));
      const activateRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/activate`, { method: "POST", headers });
      assert.equal(activateRes.status, 200, JSON.stringify(await activateRes.json()));
      const closeRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ registrationForceClosed: true }),
      });
      assert.equal(closeRes.status, 200, JSON.stringify(await closeRes.clone().json()));
      return instance.id;
    }

    const adultOfferingType = await (async () => {
      const db1 = new Database(dbPath);
      try {
        const prog = db1.prepare("SELECT offering_type_id FROM programmes WHERE id = ?").get(fx.adultProgrammeId);
        return prog.offering_type_id;
      } finally {
        db1.close();
      }
    })();

    await createClosedRun(fx.programmeId, fx.kidsOfferingTypeId);
    await createClosedRun(fx.adultProgrammeId, adultOfferingType);

    // 1) parent-learner, programmeId only (no classId) — previously bypassed
    //    the registration-window check entirely.
    const parentBypassRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "parent-learner",
        programmeId: fx.programmeId,
        participationStructure: "structured_school_club",
        parent: { name: "Bypass Parent", email: `regwin-bypass-${uuid()}@example.test`, password: "parentpass123" },
        learner: { name: "Bypass Child", dateOfBirth: "2016-01-01" },
      }),
    });
    assert.equal(parentBypassRes.status, 409, JSON.stringify(await parentBypassRes.clone().json()));

    // 2) adult self-registration, programmeId only (no classId) — same fix.
    //    Uses the Adult Professional fixture programme since Kids STEM
    //    requires a parent account and would fail for an unrelated reason.
    const adultBypassRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "adult",
        programmeId: fx.adultProgrammeId,
        participationStructure: "structured_school_club",
        adult: { name: "Bypass Adult", email: `regwin-bypass-adult-${uuid()}@example.test`, password: "adultpass123" },
      }),
    });
    assert.equal(adultBypassRes.status, 409, JSON.stringify(await adultBypassRes.clone().json()));

    // 3) coordinator adding a child under an existing parent, programmeId
    //    only (no classId) — same fix, routes/users.js POST /:parentId/children.
    const coordParentRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "parent-learner",
        classId: fx.entryClassId,
        participationStructure: "structured_school_club",
        parent: { name: "Coord Parent", email: `regwin-coord-${uuid()}@example.test`, password: "parentpass123" },
        learner: { name: "Coord First Child", dateOfBirth: "2016-01-01" },
      }),
    });
    // The entryClass registration was itself closed by the same deadline —
    // confirms the fixture, then we create the parent directly in the DB
    // for the coordinator sub-test so we're only exercising the
    // programmeId-only branch of POST /:parentId/children, not re-testing
    // step 1 above.
    assert.equal(coordParentRes.status, 409);
    const db2 = new Database(dbPath);
    const coordParentId = uuid();
    db2.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, student_code) VALUES (?, 'parent', 'Coord Parent', 'coord-parent-regwin@example.test', 'x', 'active', 'paid', date('now'), 'PAR-9401')"
    ).run(coordParentId);
    db2.close();

    const addChildRes = await fetch(`${server.baseUrl}/api/users/${coordParentId}/children`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Coord Bypass Child", programmeId: fx.programmeId }),
    });
    assert.equal(addChildRes.status, 409, JSON.stringify(await addChildRes.clone().json()));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("Instructor Assignment: GET /api/users?role=instructor eligibility filter, and assign/replace/remove via operational-config", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

    const db = new Database(dbPath);
    const eligibleInstructorId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date) VALUES (?, 'instructor', 'Eligible Instructor', 'eligible-instr@example.test', 'x', 'active', 'paid', 1, 'INS-8001', date('now'))"
    ).run(eligibleInstructorId);
    const ineligibleInstructorId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date) VALUES (?, 'instructor', 'Ineligible Instructor', 'ineligible-instr@example.test', 'x', 'active', 'paid', 1, 'INS-8002', date('now'))"
    ).run(ineligibleInstructorId);

    // Assign the eligible instructor to a Class under fx.programmeId via
    // `instructor_assignments` — the single Instructor Assignment table
    // (ABRS v2.2 §2.1/§8.2/§9/§13; utils/instructorScope.js) this codebase
    // now uses everywhere, in place of the legacy instructor_classes table
    // this replaces. A grant is always anchored to a Programme Run
    // (learning_instance_id), optionally narrowed to a Class.
    const classRow = db.prepare("SELECT id FROM classes WHERE programme_id = ?").get(fx.programmeId);
    const eligibilityInstanceId = uuid();
    db.prepare(
      "INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)"
    ).run(eligibilityInstanceId, fx.kidsOfferingTypeId, fx.programmeId);
    db.prepare(
      "INSERT INTO instructor_assignments (id, instructor_id, learning_instance_id, class_id) VALUES (?, ?, ?, ?)"
    ).run(uuid(), eligibleInstructorId, eligibilityInstanceId, classRow.id);
    db.close();

    // Without any programmeId/offeringTypeId scope, both instructors are
    // still visible — the new filter is opt-in only, existing callers are
    // unaffected.
    const unscopedRes = await fetch(`${server.baseUrl}/api/users?role=instructor`, { headers });
    const unscoped = await unscopedRes.json();
    assert.equal(unscopedRes.status, 200);
    const unscopedIds = unscoped.users.map((u) => u.id);
    assert.ok(unscopedIds.includes(eligibleInstructorId));
    assert.ok(unscopedIds.includes(ineligibleInstructorId));

    // Scoped to fx.programmeId: only the eligible (assigned) instructor
    // comes back.
    const scopedRes = await fetch(`${server.baseUrl}/api/users?role=instructor&programmeId=${fx.programmeId}`, { headers });
    const scoped = await scopedRes.json();
    assert.equal(scopedRes.status, 200);
    const scopedIds = scoped.users.map((u) => u.id);
    assert.ok(scopedIds.includes(eligibleInstructorId));
    assert.ok(!scopedIds.includes(ineligibleInstructorId));

    // Scoped to a DIFFERENT programme: the eligible instructor (assigned
    // only to fx.programmeId's class) is correctly excluded.
    const otherScopedRes = await fetch(`${server.baseUrl}/api/users?role=instructor&programmeId=${fx.otherProgrammeId}`, { headers });
    const otherScoped = await otherScopedRes.json();
    assert.equal(otherScopedRes.status, 200);
    assert.ok(!otherScoped.users.map((u) => u.id).includes(eligibleInstructorId));

    // Search term narrows within the eligible set.
    const searchRes = await fetch(`${server.baseUrl}/api/users?role=instructor&programmeId=${fx.programmeId}&search=Eligible`, { headers });
    const searched = await searchRes.json();
    assert.equal(searched.users.length, 1);
    assert.equal(searched.users[0].id, eligibleInstructorId);

    // ---- Assign / replace / remove via the Run's operational-config ----
    const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offeringTypeId: fx.kidsOfferingTypeId, programmeId: fx.programmeId }),
    });
    const instance = await createRes.json();
    assert.equal(createRes.status, 200, JSON.stringify(instance));

    // Assign.
    const assignRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ instructorId: eligibleInstructorId }),
    });
    const assigned = await assignRes.json();
    assert.equal(assignRes.status, 200, JSON.stringify(assigned));
    assert.equal(assigned.instructorId, eligibleInstructorId);
    assert.equal(assigned.instructorName, "Eligible Instructor");

    // Replace with a second, also-eligible instructor.
    const db2 = new Database(dbPath);
    db2.prepare(
      "INSERT INTO instructor_assignments (id, instructor_id, learning_instance_id, class_id) VALUES (?, ?, ?, ?)"
    ).run(uuid(), ineligibleInstructorId, eligibilityInstanceId, classRow.id);
    db2.close();
    const replaceRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ instructorId: ineligibleInstructorId }),
    });
    const replaced = await replaceRes.json();
    assert.equal(replaceRes.status, 200, JSON.stringify(replaced));
    assert.equal(replaced.instructorId, ineligibleInstructorId);

    // Remove.
    const removeRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ instructorId: null }),
    });
    const removed = await removeRes.json();
    assert.equal(removeRes.status, 200, JSON.stringify(removed));
    assert.equal(removed.instructorId, null);
    assert.equal(removed.instructorName, null);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
