/**
 * Certificate branding — Institution logo + optional Partner/Campus logo.
 *
 * Root cause (blank-page/branding remediation, Part 2): certificates.js's
 * brandingFor() only ever read campus_branding_profiles, whose
 * `institution_logo_path` column is a one-time migration SEED copied from
 * the real, authoritative Institution logo (site_settings 'branding'.
 * logoPath — the same source routes/grades.js's Transcript endpoint uses)
 * and never kept in sync afterwards. The client also expected a `logoPath`
 * key that never existed on the branding object at all. Net effect: no
 * certificate has ever actually rendered an Institution logo, confirmed
 * against production data before this fix (every campus's
 * institution_logo_path frozen at its original seed value).
 *
 * This test proves, over real HTTP against a real server process:
 *   1. A certificate's branding snapshot always includes the CURRENT
 *      authoritative Institution logo — even for a campus with no
 *      campus_branding_profiles row at all.
 *   2. Updating the authoritative Institution logo (Site Settings ->
 *      Branding) changes what a certificate issued afterwards snapshots
 *      — proving it's resolved from that live source, not a frozen
 *      per-campus copy.
 *   3. A campus's own Partner/Campus logo (partner_logo_path) is included
 *      alongside the Institution logo when configured, and is absent
 *      (not substituted, not required) when it isn't.
 *
 * Same real-server-process harness as certificate-historical-run.test.js.
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

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");
const JWT_SECRET = "certificate-institution-partner-logo-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-cert-logo-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "certificate-institution-partner-logo-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-cert-logo-uploads-"));
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

// Seeds one admin, one learner at a campus with NO campus_branding_profiles
// row at all (proving the Institution logo doesn't depend on one existing),
// a minimal certificate template, and sets the authoritative Institution
// logo via the real branding setting row (same shape routes/settings.js
// writes, same one routes/grades.js's Transcript reads).
function seedFixtures(dbPath, { institutionLogoPath }) {
  const db = new Database(dbPath);
  try {
    db.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES ('branding', ?)").run(
      JSON.stringify({ logoPath: institutionLogoPath, signaturePath: null, adminSignatureName: "Test Admin" })
    );

    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Cert Logo Test Programme', 0)").run(
      programmeId,
      offeringType.id
    );

    const adminId = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date) VALUES (?, 'admin', 'Test Admin', ?, ?, 'active', 'current', 1, 'ADM-CLT-0001', date('now'))"
    ).run(adminId, `admin-${uuid()}@example.test`, bcrypt.hashSync("adminpass123", 12));

    // Deliberately NO campuses row / campus_branding_profiles row for this
    // campus name — brandingFor() must still resolve the mandatory
    // Institution logo without one.
    const learnerId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, campus)
       VALUES (?, 'learner', 'Logo Test Learner', ?, ?, 'active', 'current', 1, 'STU-CLT-0001', date('now'), 'Campus With No Branding Profile')`
    ).run(learnerId, `learner-${uuid()}@example.test`, bcrypt.hashSync("learnerpass123", 12));

    const enrollmentId = uuid();
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, is_primary, status, payment_status, joined_date)
       VALUES (?, ?, ?, 1, 'active', 'current', date('now'))`
    ).run(enrollmentId, learnerId, programmeId);

    // A second learner, so a test can issue twice (once before, once after
    // an authoritative-logo change) without tripping the "already issued"
    // idempotency guard, which dedupes on template+learner+course+period,
    // not on branding content.
    const learner2Id = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, is_adult, student_code, joined_date, campus)
       VALUES (?, 'learner', 'Logo Test Learner 2', ?, ?, 'active', 'current', 1, 'STU-CLT-0002', date('now'), 'Campus With No Branding Profile')`
    ).run(learner2Id, `learner2-${uuid()}@example.test`, bcrypt.hashSync("learnerpass123", 12));
    db.prepare(
      `INSERT INTO programme_enrollments (id, user_id, programme_id, is_primary, status, payment_status, joined_date)
       VALUES (?, ?, ?, 1, 'active', 'current', date('now'))`
    ).run(uuid(), learner2Id, programmeId);

    const templateId = uuid();
    db.prepare(
      `INSERT INTO certificate_templates (id, name, type, title, body, placeholders, show_academic_stats)
       VALUES (?, 'Minimal Cert Logo Test Template', 'honor', 'Certificate of Honor', 'Awarded to {{student_name}}', '["student_name","certificate_number"]', 0)`
    ).run(templateId);

    return { adminId, learnerId, learner2Id, templateId };
  } finally {
    db.close();
  }
}

function addPartnerCampusBrandingProfile(dbPath, { campusName, partnerLogoPath }) {
  const db = new Database(dbPath);
  try {
    db.prepare("INSERT OR IGNORE INTO campuses (id, name, active) VALUES (?, ?, 1)").run(uuid(), campusName);
    db.prepare(
      `INSERT INTO campus_branding_profiles (id, campus_name, institution_name, partner_logo_path)
       VALUES (?, ?, 'Dalijay Tech Hub', ?)`
    ).run(uuid(), campusName, partnerLogoPath);
  } finally {
    db.close();
  }
}

function setLearnerCampus(dbPath, learnerId, campusName) {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE users SET campus = ? WHERE id = ?").run(campusName, learnerId);
  } finally {
    db.close();
  }
}

async function issueCertificate(baseUrl, adminId, templateId, learnerId) {
  const res = await fetch(`${baseUrl}/api/certificates/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie(adminId, "admin") },
    body: JSON.stringify({ templateId, learnerIds: [learnerId] }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.issued, 1, JSON.stringify(body));
  // POST /issue's certificates[] are raw DB rows — branding_snapshot is a
  // JSON string here (unlike GET /:id, which parses it into `branding`).
  const raw = body.certificates[0];
  return { ...raw, branding: JSON.parse(raw.branding_snapshot) };
}

test("certificate branding: Institution logo is always present, resolved from the same authoritative source as Transcript, even with no campus branding profile", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath, { institutionLogoPath: "/uploads/branding/institution-v1.png" });
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());

    const cert = await issueCertificate(server.baseUrl, fx.adminId, fx.templateId, fx.learnerId);
    assert.equal(
      cert.branding.logoPath,
      "/uploads/branding/institution-v1.png",
      "Institution logo must be present and equal to the authoritative branding.logoPath, even for a campus with no branding profile"
    );
    assert.ok(!cert.branding.partner_logo_path, "no Partner/Campus logo should appear when none is configured");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("certificate branding: Institution logo tracks the live authoritative source, not a stale per-campus copy", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath, { institutionLogoPath: "/uploads/branding/institution-v1.png" });
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());

    const first = await issueCertificate(server.baseUrl, fx.adminId, fx.templateId, fx.learnerId);
    assert.equal(first.branding.logoPath, "/uploads/branding/institution-v1.png");

    // Admin updates the Institution logo the same way routes/settings.js's
    // POST /branding/logo does — a direct site_settings 'branding' write.
    const db = new Database(dbPath);
    db.prepare("UPDATE site_settings SET value = ? WHERE key = 'branding'").run(
      JSON.stringify({ logoPath: "/uploads/branding/institution-v2.png", signaturePath: null, adminSignatureName: "Test Admin" })
    );
    db.close();

    const second = await issueCertificate(server.baseUrl, fx.adminId, fx.templateId, fx.learner2Id);
    assert.equal(
      second.branding.logoPath,
      "/uploads/branding/institution-v2.png",
      "a certificate issued after the Institution logo changes must snapshot the NEW logo, proving it resolves live from the authoritative source"
    );
    // Preserve existing certificate data: the first (already-issued)
    // certificate's snapshot must be unaffected by the later change.
    const firstFresh = await fetch(`${server.baseUrl}/api/certificates/${first.id}`, {
      headers: { Cookie: sessionCookie(fx.adminId, "admin") },
    }).then((r) => r.json());
    assert.equal(firstFresh.branding.logoPath, "/uploads/branding/institution-v1.png", "already-issued certificates must not be altered retroactively");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("certificate branding: Partner/Campus logo is included alongside the Institution logo when configured for the learner's campus", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const fx = seedFixtures(dbPath, { institutionLogoPath: "/uploads/branding/institution-v1.png" });
  addPartnerCampusBrandingProfile(dbPath, {
    campusName: "Woodbridge Partner Campus",
    partnerLogoPath: "/uploads/branding/woodbridge-partner-logo.png",
  });
  setLearnerCampus(dbPath, fx.learnerId, "Woodbridge Partner Campus");
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());

    const cert = await issueCertificate(server.baseUrl, fx.adminId, fx.templateId, fx.learnerId);
    assert.equal(cert.branding.logoPath, "/uploads/branding/institution-v1.png", "Institution logo is still present alongside a Partner/Campus logo");
    assert.equal(
      cert.branding.partner_logo_path,
      "/uploads/branding/woodbridge-partner-logo.png",
      "the configured Partner/Campus logo must be included, never substituted for the Institution logo"
    );
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
