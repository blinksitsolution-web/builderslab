/**
 * Sponsor Bulk Registration — Parts 1-5 & 7 of the remediation brief.
 *
 * Real-server-process pattern, matching test/sponsor-credential-visibility
 * .test.js: template download -> upload+validate+preview (priced by the
 * one Pricing Engine, via registrationBreakdown) -> commit (idempotent,
 * creates the same pending_payment shape routes/users.js's individual
 * flow already produces) -> existing-learner reuse/attach.
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
const XLSX = require("xlsx");

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");
const JWT_SECRET = "sponsor-bulk-registration-test-secret-not-for-real-use";

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
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function prepareDb() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-sponsor-bulk-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "sponsor-bulk-registration-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

// Opens an Active Kids STEM Programme Run with an explicit Course target
// (unlike the bare programme-only default some other tests use), so the
// "enroll into every Course belonging to the selected Learning Instance"
// behaviour (Part 5) has something real to grant.
function openKidsStemRunWithCourseTarget(dbPath) {
  const db = new Database(dbPath);
  try {
    const programme = db
      .prepare(
        `SELECT p.id, p.offering_type_id FROM programmes p
         JOIN learning_offering_types t ON t.id = p.offering_type_id
         WHERE t.slug = 'kids_stem' LIMIT 1`
      )
      .get();
    if (!programme) throw new Error("kids_stem programme not seeded");
    const courseId = db.prepare("SELECT id FROM courses WHERE is_open = 1 LIMIT 1").get().id;
    const runId = uuid();
    db.prepare("INSERT INTO learning_instances (id, offering_type_id, programme_id, status, registration_fee_ghs) VALUES (?, ?, ?, 'active', 350)").run(runId, programme.offering_type_id, programme.id);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, is_primary, instance_status) VALUES (?, ?, 'programme', ?, 1, 'active')"
    ).run(uuid(), runId, programme.id);
    db.prepare(
      "INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, course_id, is_primary, instance_status) VALUES (?, ?, 'course', ?, 0, 'active')"
    ).run(uuid(), runId, courseId);
    return { runId, programmeId: programme.id, courseId };
  } finally {
    db.close();
  }
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-sponsor-bulk-uploads-"));
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

function sessionCookie(userId, role) {
  const token = jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

// Seeds a REAL, active sibling/multi-child Discount Policy (§15.7) —
// institution-wide, 2nd-and-later rank, 10% off registration — so tests
// can verify the actual monetary effect (or, for sponsored learners, the
// deliberate absence of one), not just the `discounted` flag in
// isolation.
function seedSiblingDiscountPolicy(dbPath) {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO discount_policies (id, category, eligibility_rule, discount_type, discount_value, applies_to, is_active)
       VALUES (?, 'Sibling (test)', '{"type":"sibling_rank_gte","rank":2}', 'percentage', 10, 'registration', 1)`
    ).run(uuid());
  } finally {
    db.close();
  }
}

function seedSponsorAndCoordinator(dbPath, sponsorName) {
  const db = new Database(dbPath);
  try {
    const sponsorId = uuid();
    db.prepare("INSERT INTO sponsors (id, name, type, is_active) VALUES (?, ?, 'ngo', 1)").run(sponsorId, sponsorName || `Test NGO ${sponsorId}`);
    const coordinatorId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, sponsor_id, coordinator_scope) VALUES (?, 'parent', 'Coordinator', ?, ?, 'active', 'current', date('now'), ?, 'both')"
    ).run(coordinatorId, `coord-${coordinatorId}@example.test`, bcrypt.hashSync("pw123456789", 12), sponsorId);
    return { sponsorId, coordinatorId };
  } finally {
    db.close();
  }
}

function resolveDefaultClassId(dbPath, programmeId) {
  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT id FROM classes WHERE programme_id = ? ORDER BY sort_order ASC, name ASC LIMIT 1").get(programmeId);
    return row ? row.id : null;
  } finally {
    db.close();
  }
}

function seedPendingLearnerUnderCoordinator(dbPath, coordinatorId, sponsorId, classId) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, parent_id, sponsor_id, class_id) VALUES (?, 'learner', 'Pre-existing Pending Child', ?, ?, 'pending_payment', 'unpaid', date('now'), ?, ?, ?)"
    ).run(id, `pending-${id}@example.test`, bcrypt.hashSync("pw123456789", 12), coordinatorId, sponsorId, classId || null);
    return id;
  } finally {
    db.close();
  }
}

function seedUnattachedLearner(dbPath) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    const email = `existing-${id}@example.test`;
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, is_adult) VALUES (?, 'learner', 'Existing Adult', ?, ?, 'pending_payment', 'unpaid', date('now'), 1)"
    ).run(id, email, bcrypt.hashSync("pw123456789", 12));
    return { id, email };
  } finally {
    db.close();
  }
}

function buildWorkbookBuffer(rows) {
  const headers = [
    "Learner Type (child or adult)",
    "Full Name",
    "Email (required for adult learners)",
    "Phone",
    "Age (child learners, 3-21)",
    "Campus",
    "School Name (child learners)",
    "Owns Robotics Kit (Y/N)",
    "Education Level (adult: Senior High / Tertiary / None)",
    "Existing Learner Email or Student ID (leave blank if new)",
  ];
  const aoa = [
    headers,
    ...rows.map((r) => [r.learnerType || "", r.name || "", r.email || "", r.phone || "", r.age ?? "", r.campus || "", r.schoolName || "", r.ownRoboticsKit || "", r.educationLevel || "", r.existingLearnerRef || ""]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Learners");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

test("sponsor-bulk-registration: template downloads as a real xlsx generated from the registration schema", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { runId } = openKidsStemRunWithCourseTarget(dbPath);
    const { sponsorId, coordinatorId } = seedSponsorAndCoordinator(dbPath);

    const res = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/template?learningInstanceId=${runId}`, {
      headers: { Cookie: sessionCookie(coordinatorId, "parent") },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /spreadsheetml/);
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    assert.ok(rows[0].includes("Full Name"));
    assert.ok(rows[0].includes("Learner Type (child or adult)"));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-bulk-registration: an unrelated coordinator cannot touch another sponsor's batch (Part 6 ownership)", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { runId } = openKidsStemRunWithCourseTarget(dbPath);
    const { sponsorId } = seedSponsorAndCoordinator(dbPath, "Sponsor A");
    const { coordinatorId: otherCoordinatorId } = seedSponsorAndCoordinator(dbPath, "Sponsor B"); // different sponsor

    const res = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/template?learningInstanceId=${runId}`, {
      headers: { Cookie: sessionCookie(otherCoordinatorId, "parent") },
    });
    assert.equal(res.status, 403);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-bulk-registration: validate -> preview (priced) -> commit -> idempotent re-commit, new + existing learners", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { runId, courseId } = openKidsStemRunWithCourseTarget(dbPath);
    const { sponsorId, coordinatorId } = seedSponsorAndCoordinator(dbPath);
    const existing = seedUnattachedLearner(dbPath);
    const cookie = sessionCookie(coordinatorId, "parent");

    const buffer = buildWorkbookBuffer([
      { learnerType: "child", name: "New Child One", age: 9 },
      { learnerType: "adult", name: "New Adult One", email: "new-adult-one@example.test", educationLevel: "Tertiary" },
      { learnerType: "adult", name: "Existing Adult", existingLearnerRef: existing.email },
      { learnerType: "child", name: "Bad Row", age: 99 }, // invalid age -> validation error
    ]);

    const form = new FormData();
    form.append("learningInstanceId", runId);
    form.append("file", new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "batch.xlsx");

    const validateRes = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/validate`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    const validated = await validateRes.json();
    assert.equal(validateRes.status, 200, JSON.stringify(validated));
    assert.equal(validated.validation.errors.length, 1, JSON.stringify(validated.validation.errors)); // the bad-age row
    assert.equal(validated.validation.validRowCount, 3);
    assert.equal(validated.preview.categories.newLearners.length, 2);
    assert.equal(validated.preview.categories.existingNotAttached.length, 1);
    assert.equal(validated.preview.pricing.chargeableCount, 3); // 2 new + 1 existing-needs-registration
    assert.ok(validated.preview.pricing.totalPayableGHS > 0);

    // Idempotency check #1: re-uploading the identical file resolves to
    // the SAME batch rather than creating a second one.
    const form2 = new FormData();
    form2.append("learningInstanceId", runId);
    form2.append("file", new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "batch.xlsx");
    const revalidateRes = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/validate`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form2,
    });
    const revalidated = await revalidateRes.json();
    assert.equal(revalidated.batchId, validated.batchId);
    assert.equal(revalidated.reused, true);

    const commitRes = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/${validated.batchId}/commit`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const committed = await commitRes.json();
    assert.equal(commitRes.status, 200, JSON.stringify(committed));
    assert.equal(committed.result.learnersCreated.length, 2);
    assert.equal(committed.result.sponsorshipAssociationsCreated.length, 1);
    assert.equal(committed.result.registrationsCreated.length, 3);

    // Idempotency check #2: committing an already-committed batch again
    // must not double-create anything.
    const recommitRes = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/${validated.batchId}/commit`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(recommitRes.status, 200);
    const recommitted = await recommitRes.json();
    assert.deepEqual(recommitted.result, committed.result);

    // Verify DB state directly: exactly 2 new learner rows under this
    // coordinator, the existing learner now attached + registered, and no
    // duplicate programme_enrollments rows from the re-commit.
    const verifyDb = new Database(dbPath, { readonly: true });
    try {
      const newLearners = verifyDb.prepare("SELECT * FROM users WHERE parent_id = ? AND role = 'learner'").all(coordinatorId);
      assert.equal(newLearners.length, 2);
      newLearners.forEach((l) => {
        assert.equal(l.sponsor_id, sponsorId);
        assert.equal(l.status, "pending_payment");
      });

      const existingRow = verifyDb.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
      assert.equal(existingRow.sponsor_id, sponsorId);

      const enrolmentCount = verifyDb.prepare("SELECT COUNT(*) c FROM programme_enrollments WHERE sponsor_id = ?").get(sponsorId).c;
      assert.equal(enrolmentCount, 3); // exactly 3, not 6 — the re-commit created nothing new

      // Every new registration requested this Run's one Course target.
      const enrolments = verifyDb.prepare("SELECT requested_course_ids FROM programme_enrollments WHERE sponsor_id = ?").all(sponsorId);
      enrolments.forEach((e) => {
        assert.deepEqual(JSON.parse(e.requested_course_ids), [courseId]);
      });
    } finally {
      verifyDb.close();
    }

    // The batch's own audit/report artifact (Part 7) downloads as xlsx too.
    const reportRes = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/${validated.batchId}/report`, {
      headers: { Cookie: cookie },
    });
    assert.equal(reportRes.status, 200);
    assert.match(reportRes.headers.get("content-type") || "", /spreadsheetml/);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-bulk-registration: preview totals correctly include the coordinator's already-pending learners (transparency), while staying undiscounted since every learner here is sponsored", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { runId, programmeId } = openKidsStemRunWithCourseTarget(dbPath);
    const { sponsorId, coordinatorId } = seedSponsorAndCoordinator(dbPath);
    const cookie = sessionCookie(coordinatorId, "parent");
    const classId = resolveDefaultClassId(dbPath, programmeId);

    // Baseline: a fresh coordinator with nothing pending uploads one
    // single-child batch — no sibling rank applies (siblingRank is only
    // assigned when the priced list has more than one learner), so this
    // is charged at the undiscounted rate.
    const soloBuffer = buildWorkbookBuffer([{ learnerType: "child", name: "Solo Child", age: 8 }]);
    const soloForm = new FormData();
    soloForm.append("learningInstanceId", runId);
    soloForm.append("file", new Blob([soloBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "solo.xlsx");
    const soloRes = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/validate`, { method: "POST", headers: { Cookie: cookie }, body: soloForm });
    const solo = await soloRes.json();
    assert.equal(soloRes.status, 200, JSON.stringify(solo));
    const undiscountedRate = solo.preview.pricing.totalPayableGHS;
    assert.equal(solo.preview.pricing.existingPendingGHS, 0);
    assert.equal(solo.preview.pricing.combinedChargeGHS, undiscountedRate);

    // Now seed a pre-existing pending learner under the SAME coordinator
    // (as if from an earlier, not-yet-paid batch/individual add), and
    // upload a second single-child batch. Both are sponsored (every
    // learner under a coordinator is), so — per the sibling/multi-child
    // Discount Policy exclusion — this new child must NOT be discounted
    // just because it lands on what would otherwise be "rank 2" once
    // combined with the existing pending learner. What this scenario DOES
    // still need to get right is the transparency figures: the batch's
    // own amount, what was already pending, and the real combined total
    // the coordinator will actually be charged.
    seedPendingLearnerUnderCoordinator(dbPath, coordinatorId, sponsorId, classId);

    const secondBuffer = buildWorkbookBuffer([{ learnerType: "child", name: "Second Child", age: 8 }]);
    const secondForm = new FormData();
    secondForm.append("learningInstanceId", runId);
    secondForm.append("file", new Blob([secondBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "second.xlsx");
    const secondRes = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/validate`, { method: "POST", headers: { Cookie: cookie }, body: secondForm });
    const second = await secondRes.json();
    assert.equal(secondRes.status, 200, JSON.stringify(second));

    assert.equal(second.preview.pricing.breakdown.length, 1);
    assert.equal(second.preview.pricing.breakdown[0].discounted, false, JSON.stringify(second.preview.pricing));
    // Undiscounted, so the batch's own payable amount is the same
    // full rate as the solo upload above — combining with an existing
    // pending (also sponsored) learner must not shift this.
    assert.equal(second.preview.pricing.totalPayableGHS, undiscountedRate);
    assert.equal(solo.preview.pricing.breakdown[0].discounted, false);
    assert.ok(second.preview.pricing.existingPendingGHS > 0);
    assert.equal(second.preview.pricing.combinedChargeGHS, second.preview.pricing.existingPendingGHS + second.preview.pricing.totalPayableGHS);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("sponsor-bulk-registration: the sibling/multi-child Discount Policy is never applied to sponsored learners, even 2+ in one batch", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  seedSiblingDiscountPolicy(dbPath); // real, active, 10% off 2nd+ rank
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const { runId } = openKidsStemRunWithCourseTarget(dbPath);
    const { sponsorId, coordinatorId } = seedSponsorAndCoordinator(dbPath);
    const cookie = sessionCookie(coordinatorId, "parent");

    // Two NEW children in the SAME upload — without the sponsored
    // exclusion, this is exactly the shape that would rank them 1 and 2
    // and discount the second.
    const buffer = buildWorkbookBuffer([
      { learnerType: "child", name: "Sponsored Child A", age: 8 },
      { learnerType: "child", name: "Sponsored Child B", age: 9 },
    ]);
    const form = new FormData();
    form.append("learningInstanceId", runId);
    form.append("file", new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "batch.xlsx");

    const res = await fetch(`${server.baseUrl}/api/sponsors/${sponsorId}/bulk-registration/validate`, { method: "POST", headers: { Cookie: cookie }, body: form });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const { breakdown } = body.preview.pricing;
    assert.equal(breakdown.length, 2);
    assert.equal(breakdown[0].discounted, false);
    assert.equal(breakdown[1].discounted, false, JSON.stringify(breakdown)); // the real bug this guards: would be true without the fix
    // Same policy, same class, both undiscounted -> identical amounts —
    // proof the 10% policy genuinely never fired for either, not just
    // that the flag says so.
    assert.equal(breakdown[0].amountGHS, breakdown[1].amountGHS);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
