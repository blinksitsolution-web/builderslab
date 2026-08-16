/**
 * Focused regression tests for the Builders' Lab architecture additions
 * (v29): the Course layer (Programme -> Course -> Module), per-Class
 * curriculum mapping, participation_structure on Learning Instances /
 * programme_enrollments, and HYBRID delivery mode. Same real-server-
 * process pattern as admin-class-delivery-mode.test.js (fresh temp DB,
 * migrated, real `node src/server.js`).
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
const JWT_SECRET = "builderslab-architecture-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-arch-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "builderslab-architecture-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-arch-uploads-"));
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
    const adminId = uuid();
    const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator'").get();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, role_template_id) VALUES (?, 'admin', 'Test Admin', 'admin-arch-test@example.com', 'x', 'active', 'paid', 1, 'ADM-9001', date('now'), ?)"
    ).run(adminId, superAdminTemplate ? superAdminTemplate.id : null);

    const kidsOfferingType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Builders Lab Arch Test', 0)").run(programmeId, kidsOfferingType.id);

    const otherProgrammeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'A Different Programme', 1)").run(otherProgrammeId, kidsOfferingType.id);

    const courseId = uuid();
    db.prepare("INSERT INTO courses (id, title, is_open, programme_id) VALUES (?, 'Module One', 0, ?)").run(courseId, programmeId);

    // A module that already belongs to the OTHER programme — used to
    // prove a course can't claim a module from a different programme.
    const otherModuleId = uuid();
    db.prepare("INSERT INTO courses (id, title, is_open, programme_id) VALUES (?, 'Other Programme Module', 0, ?)").run(otherModuleId, otherProgrammeId);

    const foundationClass = db.prepare("SELECT id FROM classes WHERE name = 'Foundation'").get();

    const activeCampusId = uuid();
    db.prepare("INSERT INTO campuses (id, name, active, is_partner) VALUES (?, 'Arch Test Campus', 1, 0)").run(activeCampusId);

    // Registration Source of Truth: an admin must intentionally open an
    // Active Programme Run before registration into a programme is
    // possible — simulated for both test programmes here.
    const armId = uuid();
    db.prepare("INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)").run(armId, kidsOfferingType.id, programmeId);
    db.prepare("INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')").run(uuid(), armId, programmeId);

    return { adminId, programmeId, otherProgrammeId, courseId, otherModuleId, foundationClassId: foundationClass.id, activeCampusId, kidsOfferingTypeId: kidsOfferingType.id };
  } finally {
    db.close();
  }
}

test("registration's Course/Module-selection gate is config-driven (programmeHasOpenModules), not a hardcoded Kids STEM/Builders' Lab check", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());

    // Open the fixture's Module so fx.programmeId (a Kids STEM programme)
    // now has a real, self-registrable open Module.
    const db = new Database(dbPath);
    db.prepare("UPDATE courses SET is_open = 1 WHERE id = ?").run(fx.courseId);
    // fx.programmeId has no Learning Group of its own yet (seedFixtures
    // only gives it Modules) — give it one so programmeId-only registration
    // (no explicit classId) can resolve an entry class, same as any real
    // Programme would need before self-registration can work.
    db.prepare("INSERT INTO classes (id, name, programme_id, sort_order) VALUES (?, 'Arch Test Entry Class', ?, 0)").run(
      uuid(),
      fx.programmeId
    );
    db.close();

    // 1) Registering into a programme WITH an open Module, no
    //    participationStructure sent, and no modules chosen — still
    //    correctly rejected: the programme genuinely has a Course/Module
    //    choice to make.
    const missingRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "parent-learner",
        programmeId: fx.programmeId,
        parent: { name: "Config Parent", email: `parent-${uuid()}@example.test`, password: "parentpass123" },
        learner: { name: "Config Child", dateOfBirth: "2016-01-01" },
      }),
    });
    assert.equal(missingRes.status, 400);
    const missingBody = await missingRes.json();
    assert.match(missingBody.error, /choose at least one module/i);

    // 2) The exact same programme, but participationStructure =
    //    "structured_school_club" — per spec, School Club selection means
    //    the parent is never asked to choose a Course/Module, even though
    //    this programme has one configured.
    const schoolClubRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "parent-learner",
        programmeId: fx.programmeId,
        participationStructure: "structured_school_club",
        parent: { name: "Club Parent", email: `parent-${uuid()}@example.test`, password: "parentpass123" },
        learner: { name: "Club Child", dateOfBirth: "2016-01-01" },
      }),
    });
    assert.equal(schoolClubRes.status, 200, JSON.stringify(await schoolClubRes.json()));

    // 3) A DIFFERENT programme under the SAME "kids_stem" offering type,
    //    with NO open Modules configured, never requires module selection
    //    — proving the gate is driven by the target programme's own
    //    configuration, not by the "kids_stem" slug.
    const noModulesClassId = uuid();
    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO classes (id, name, programme_id) VALUES (?, 'Other Programme Class', ?)").run(
      noModulesClassId,
      fx.otherProgrammeId
    );
    const otherRunId = uuid();
    db2.prepare("INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)").run(otherRunId, fx.kidsOfferingTypeId, fx.otherProgrammeId);
    db2.prepare("INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')").run(uuid(), otherRunId, fx.otherProgrammeId);
    db2.close();

    const otherProgRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "parent-learner",
        classId: noModulesClassId,
        parent: { name: "Other Parent", email: `parent-${uuid()}@example.test`, password: "parentpass123" },
        learner: { name: "Other Child", dateOfBirth: "2016-01-01" },
      }),
    });
    assert.equal(otherProgRes.status, 200, JSON.stringify(await otherProgRes.json()));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("Programme Run operational config (v31): Delivery Modes/Campuses/Fee/Installments/Capacity/Instructor persist and resolve through Classes", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

    // A real instructor to assign to the Run.
    const instructorId = uuid();
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date) VALUES (?, 'instructor', 'Config Instructor', 'config-instr@example.test', 'x', 'active', 'paid', 1, 'INS-7001', date('now'))"
    ).run(instructorId);
    // seedFixtures already opened an Active Programme Run for fx.programmeId
    // (registration now hard-requires one to exist). This test exercises
    // create+activate of a fresh Run itself, and only one Active run per
    // Programme is allowed at a time, so archive the fixture's pre-seeded
    // one first — same as an admin retiring a run before opening the next.
    db.prepare("UPDATE learning_instances SET status = 'archived' WHERE programme_id = ? AND status = 'active'").run(fx.programmeId);
    db.prepare("UPDATE learning_instance_targets SET instance_status = 'archived' WHERE programme_id = ? AND instance_status = 'active'").run(fx.programmeId);
    db.close();

    // Create AND activate the Programme Run — resolveClassOperationalConfig
    // only falls back to a Run that's actually the ACTIVE one for its
    // Programme (same rule every other Learning-Instance-aware feature in
    // this codebase already follows).
    const createRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offeringTypeId: fx.kidsOfferingTypeId, programmeId: fx.programmeId }),
    });
    assert.equal(createRes.status, 200, JSON.stringify(await createRes.clone().json()));
    const instance = await createRes.json();
    const activateRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/activate`, { method: "POST", headers });
    assert.equal(activateRes.status, 200, JSON.stringify(await activateRes.json()));

    // Invalid delivery mode is rejected.
    const badRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ deliveryModes: ["NOT_REAL"] }),
    });
    assert.equal(badRes.status, 400);

    // Configure the Run's operational settings.
    const configRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        deliveryModes: ["ON_CAMPUS"],
        campusIds: [fx.activeCampusId],
        feeGHS: 777,
        registrationFeeGHS: 350,
        installmentsEnabled: true,
        capacity: 30,
        instructorId,
      }),
    });
    assert.equal(configRes.status, 200, JSON.stringify(await configRes.clone().json()));
    const configured = await configRes.json();
    assert.deepEqual(configured.deliveryModes, ["ON_CAMPUS"]);
    assert.deepEqual(configured.campusIds, [fx.activeCampusId]);
    assert.equal(configured.feeGHS, 777);
    assert.equal(configured.installmentsEnabled, true);
    assert.equal(configured.capacity, 30);
    assert.equal(configured.instructorId, instructorId);

    // GET .../programme-runs/registration-config?programmeId=... — the
    // single config endpoint the registration frontend should now consume
    // — returns exactly this Run's operational config, unauthenticated.
    const regConfigRes = await fetch(`${server.baseUrl}/api/learning-offerings/programme-runs/registration-config?programmeId=${fx.programmeId}`);
    const regConfig = await regConfigRes.json();
    assert.equal(regConfigRes.status, 200, JSON.stringify(regConfig));
    assert.equal(regConfig.hasActiveRun, true);
    assert.equal(regConfig.instanceId, instance.id);
    assert.deepEqual(regConfig.deliveryModes, ["ON_CAMPUS"]);
    assert.equal(regConfig.campuses.length, 1);
    assert.equal(regConfig.campuses[0].id, fx.activeCampusId);
    assert.equal(regConfig.feeGHS, 777);
    assert.equal(regConfig.installmentsEnabled, true);
    assert.deepEqual(regConfig.participationStructures, ["structured_school_club", "structured_other", "individual_course"]);

    // A Programme with no Active Run at all reports hasActiveRun: false —
    // never a 500/guessed config.
    const noRunConfigRes = await fetch(`${server.baseUrl}/api/learning-offerings/programme-runs/registration-config?programmeId=${fx.otherProgrammeId}`);
    const noRunConfig = await noRunConfigRes.json();
    assert.equal(noRunConfigRes.status, 200, JSON.stringify(noRunConfig));
    assert.equal(noRunConfig.hasActiveRun, false);

    // A brand-new Class under this Programme, with NO delivery_mode/
    // campus_id/fee_ghs of its own, now resolves all three from its
    // Programme Run instead of staying null/legacy.
    const classCreateRes = await fetch(`${server.baseUrl}/api/classes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Run-Configured Batch", programmeId: fx.programmeId }),
    });
    const cls = await classCreateRes.json();
    assert.equal(classCreateRes.status, 200, JSON.stringify(cls));
    assert.equal(cls.deliveryMode, "ON_CAMPUS");
    assert.equal(cls.campusId, fx.activeCampusId);
    assert.equal(cls.feeGHS, 777);

    // ABRS v2.2 §11.3 — a per-batch fee override is now an Operational
    // Group responsibility, not a Class (Programme Level) one. Creating a
    // Class can no longer carry a fee override at all (verified
    // elsewhere, admin-class-delivery-mode.test.js); the equivalent
    // "Bootcamp-style Weekend batch with its own fee" back-compat
    // scenario now lives on operational-groups, scoped to the Run.
    const rejectedFeeOnClass = await fetch(`${server.baseUrl}/api/classes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Attempted Overridden Batch", programmeId: fx.programmeId, feeGHS: 999 }),
    });
    assert.equal(rejectedFeeOnClass.status, 400, "classes.js must no longer accept a fee override at all — §11.3/Appendix A-9");

    const ogRes = await fetch(`${server.baseUrl}/api/learning-instances/${instance.id}/operational-groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Weekend Batch", feeGHS: 999 }),
    });
    const og = await ogRes.json();
    assert.equal(ogRes.status, 201, JSON.stringify(og));
    assert.equal(og.overrides.feeGHS, 999);
    // ...but its Delivery Mode/Campus, which it did NOT override, still
    // resolve through the Run (single-level override, §11.3).
    assert.equal(og.overrides.deliveryMode, null);
    assert.equal(og.overrides.campusId, null);

    // GET /api/classes/public?programmeId=... (the public registration
    // endpoint) reflects the same resolved values.
    const publicClassesRes = await fetch(`${server.baseUrl}/api/classes/public?programmeId=${fx.programmeId}`);
    const { classes: publicClasses } = await publicClassesRes.json();
    const publicCls = publicClasses.find((c) => c.id === cls.id);
    assert.equal(publicCls.deliveryMode, "ON_CAMPUS");
    assert.equal(publicCls.campusId, fx.activeCampusId);
    assert.equal(publicCls.feeGHS, 777);

    // Registering into this Run-configured Class now snapshots the
    // resolved Delivery Mode/Campus/Academic Period onto the enrolment row
    // (v31 spec: "every enrollment must know Delivery Mode, Campus,
    // Academic Period, Course"), not just the learning_instance_id it
    // already recorded.
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "parent-learner",
        classId: cls.id,
        parent: { name: "Snapshot Parent", email: `parent-${uuid()}@example.test`, password: "parentpass123" },
        learner: { name: "Snapshot Child", dateOfBirth: "2016-01-01" },
      }),
    });
    const regBody = await regRes.json();
    assert.equal(regRes.status, 200, JSON.stringify(regBody));
    const db3 = new Database(dbPath);
    const enrolmentRow = db3
      .prepare("SELECT * FROM programme_enrollments WHERE user_id = ? AND is_primary = 1")
      .get(regBody.learnerId);
    db3.close();
    assert.equal(enrolmentRow.delivery_mode, "ON_CAMPUS");
    assert.equal(enrolmentRow.campus_id, fx.activeCampusId);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

function adminCookie(adminId) {
  const token = jwt.sign({ sub: adminId, role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

test("Builders' Lab architecture (v29): courses, curriculum mapping, participation structure, hybrid mode", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath);
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const headers = { "Content-Type": "application/json", Cookie: adminCookie(fx.adminId) };

    // ---- Course Groups CRUD -----------------------------------------------
    const createRes = await fetch(`${server.baseUrl}/api/course-groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({ programmeId: fx.programmeId, name: "Robotics Engineering", description: "Robots!" }),
    });
    assert.equal(createRes.status, 200);
    const course = await createRes.json();
    assert.equal(course.name, "Robotics Engineering");
    assert.equal(course.programmeId, fx.programmeId);
    assert.equal(course.isActive, true);

    // Duplicate name under the same programme is rejected.
    const dupRes = await fetch(`${server.baseUrl}/api/course-groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({ programmeId: fx.programmeId, name: "Robotics Engineering" }),
    });
    assert.equal(dupRes.status, 409);

    // Public GET (no auth) returns it.
    const listRes = await fetch(`${server.baseUrl}/api/course-groups?programmeId=${fx.programmeId}`);
    const { courseGroups } = await listRes.json();
    assert.ok(courseGroups.some((c) => c.id === course.id));

    // ---- Assign a module to the course group ----------------------------
    const assignRes = await fetch(`${server.baseUrl}/api/modules/${fx.courseId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ courseGroupId: course.id }),
    });
    assert.equal(assignRes.status, 200);

    // A module belonging to a DIFFERENT programme cannot be grouped under
    // this course group, even though the course group itself exists.
    const crossProgrammeRes = await fetch(`${server.baseUrl}/api/modules/${fx.otherModuleId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ courseGroupId: course.id }),
    });
    assert.equal(crossProgrammeRes.status, 400);

    // Course group now shows the assigned module.
    const detailRes = await fetch(`${server.baseUrl}/api/course-groups/${course.id}`);
    const detail = await detailRes.json();
    assert.ok(detail.courses.some((m) => m.id === fx.courseId));

    // Deleting a course group still holding a module is blocked (409),
    // matching modules.js's own "can't delete something still referenced" posture.
    const blockedDeleteRes = await fetch(`${server.baseUrl}/api/course-groups/${course.id}`, { method: "DELETE", headers });
    assert.equal(blockedDeleteRes.status, 409);

    // ---- Per-Class curriculum mapping ----------------------------------
    const mapRes = await fetch(`${server.baseUrl}/api/course-groups/${course.id}/classes/${fx.foundationClassId}/courses`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ courseIds: [fx.courseId] }),
    });
    assert.equal(mapRes.status, 200);

    // A module not belonging to this course group can't be mapped in.
    const badMapRes = await fetch(`${server.baseUrl}/api/course-groups/${course.id}/classes/${fx.foundationClassId}/courses`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ courseIds: [fx.otherModuleId] }),
    });
    assert.equal(badMapRes.status, 400);

    const mapGetRes = await fetch(`${server.baseUrl}/api/course-groups/${course.id}/classes/${fx.foundationClassId}/courses`);
    const { courses: mappedModules } = await mapGetRes.json();
    assert.equal(mappedModules.length, 1);
    assert.equal(mappedModules[0].id, fx.courseId);

    // ---- Learning Instance participation_structure ---------------------
    const badLiRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offeringTypeId: fx.kidsOfferingTypeId, programmeId: fx.programmeId, participationStructure: "not_a_real_value" }),
    });
    assert.equal(badLiRes.status, 400);

    const goodLiRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offeringTypeId: fx.kidsOfferingTypeId, programmeId: fx.programmeId, participationStructure: "structured_school_club" }),
    });
    assert.equal(goodLiRes.status, 200);
    const li = await goodLiRes.json();
    assert.equal(li.participationStructure, "structured_school_club");

    const editLiRes = await fetch(`${server.baseUrl}/api/learning-instances/${li.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ participationStructure: "individual_course" }),
    });
    assert.equal(editLiRes.status, 200);
    const editedLi = await editLiRes.json();
    assert.equal(editedLi.participationStructure, "individual_course");

    // A Learning Instance created without one stays null — never guessed.
    const unspecifiedLiRes = await fetch(`${server.baseUrl}/api/learning-instances`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offeringTypeId: fx.kidsOfferingTypeId, courseId: fx.courseId }),
    });
    assert.equal(unspecifiedLiRes.status, 200);
    const unspecifiedLi = await unspecifiedLiRes.json();
    assert.equal(unspecifiedLi.participationStructure, null);

    // ---- HYBRID delivery mode --------------------------------------------
    // ABRS v2.2 §11.3 — Delivery Mode/Campus are Operational Group
    // overrides now, not Class fields; classes.js rejects them outright
    // regardless of value (verified in admin-class-delivery-mode.test.js).
    // HYBRID's "still needs a campus" validation now lives on
    // operational-groups, checked against the Run's own configuration.
    const rejectedHybridOnClass = await fetch(`${server.baseUrl}/api/classes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Hybrid Batch", programmeId: fx.programmeId, deliveryMode: "HYBRID" }),
    });
    assert.equal(rejectedHybridOnClass.status, 400, "classes.js must reject a Delivery Mode field outright, HYBRID included");

    // `li` (created above) hasn't configured any Delivery Mode/Campus of
    // its own yet — an Operational Group override is only ever valid
    // against what its own Run already owns (§11.3), so configure the Run
    // for HYBRID first.
    const configureHybridRes = await fetch(`${server.baseUrl}/api/learning-instances/${li.id}/operational-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ deliveryModes: ["HYBRID"], campusIds: [fx.activeCampusId] }),
    });
    assert.equal(configureHybridRes.status, 200, JSON.stringify(await configureHybridRes.clone().json()));

    const hybridNoCampusRes = await fetch(`${server.baseUrl}/api/learning-instances/${li.id}/operational-groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Hybrid Batch (no campus)", deliveryMode: "HYBRID" }),
    });
    // The Run allows HYBRID with no campus set at the Operational Group
    // level — that's a valid "inherit the Run's own campus" state, not an
    // invalid one; §11.3 has no HYBRID-requires-campus rule of its own
    // (that was classes.js's now-removed, narrower validation).
    assert.equal(hybridNoCampusRes.status, 201, JSON.stringify(await hybridNoCampusRes.clone().json()));

    const hybridRes = await fetch(`${server.baseUrl}/api/learning-instances/${li.id}/operational-groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Hybrid Batch", deliveryMode: "HYBRID", campusId: fx.activeCampusId }),
    });
    assert.equal(hybridRes.status, 201);
    const hybridGroup = await hybridRes.json();
    assert.equal(hybridGroup.overrides.deliveryMode, "HYBRID");
    assert.equal(hybridGroup.overrides.campusId, fx.activeCampusId);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
