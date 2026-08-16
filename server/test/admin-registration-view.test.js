/**
 * Stage 4H — Admin view of complete registration information.
 *
 * GET /api/users/:userId (routes/users.js -> utils/userView.js's
 * getFullUser) already returns every raw column on the users row
 * (toPublicUser spreads `SELECT *`, minus password_hash/
 * temp_password_plaintext) — country/town/school_name/education_level/
 * age/joined_date/status were already there, just not all rendered by
 * AccountDetailDrawer.jsx. The one genuine gap: className was resolved
 * from the learner's class_id, but not the Programme it belongs to, the
 * delivery mode, or the parent/guardian's actual name (only the raw
 * parent_id FK). This locks in the two new resolved fields
 * (programmeName/deliveryMode, parentName) and confirms the endpoint
 * still never leaks password_hash/temp_password_plaintext.
 *
 * Same real-server-process pattern as sponsor-credential-visibility
 * .test.js.
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
const JWT_SECRET = "admin-registration-view-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-admin-reg-view-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "admin-registration-view-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-admin-reg-view-uploads-"));
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

function seedAdmin(dbPath) {
  const db = new Database(dbPath);
  try {
    const id = uuid();
    db.prepare(
      "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date) VALUES (?, 'admin', 'Test Admin', ?, ?, 'active', 'current', date('now'))"
    ).run(id, `admin-${id}@example.test`, bcrypt.hashSync("adminpass123", 12));
    return id;
  } finally {
    db.close();
  }
}

// Seeds a parent + one learner child, the child placed into the seeded
// "Enrol Dup Test Programme" pattern reused from Stage 4D — a fresh
// Programme + Learning Group with a delivery_mode set, so
// programmeName/deliveryMode have something real to resolve.
function seedParentAndLearner(dbPath) {
  const db = new Database(dbPath);
  try {
    const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'adult_professional'").get();
    const programmeId = uuid();
    db.prepare("INSERT INTO programmes (id, offering_type_id, name, sort_order) VALUES (?, ?, 'Registration View Test Programme', 0)").run(programmeId, offeringType.id);
    const classId = uuid();
    db.prepare("INSERT INTO classes (id, name, sort_order, programme_id, delivery_mode) VALUES (?, 'Morning Batch', 0, ?, 'ONLINE')").run(classId, programmeId);

    const parentId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, country, town)
       VALUES (?, 'parent', 'Registering Parent', ?, ?, 'active', 'current', date('now'), 'GH', 'Kumasi')`
    ).run(parentId, `parent-${parentId}@example.test`, bcrypt.hashSync("parentpass123", 12));

    const childId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, country, town, school_name, class_id, parent_id, student_code, age, own_robotics_kit)
       VALUES (?, 'learner', 'Registration View Child', ?, ?, 'pending_payment', 'unpaid', date('now'), 'GH', 'Kumasi', 'Kumasi Model School', ?, ?, ?, 10, 1)`
    ).run(childId, `child-${childId}@example.test`, bcrypt.hashSync("childpass123", 12), classId, parentId, `T-${childId.slice(0, 8)}`);

    return { parentId, childId, programmeId, classId };
  } finally {
    db.close();
  }
}

test("admin-registration-view: an admin fetching a learner's account sees the full registration detail set, including resolved programme/delivery-mode and parent/guardian name", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const adminId = seedAdmin(dbPath);
    const { parentId, childId } = seedParentAndLearner(dbPath);

    const res = await fetch(`${server.baseUrl}/api/users/${childId}`, {
      headers: { Cookie: sessionCookie(adminId, "admin") },
    });
    assert.equal(res.status, 200);
    const { user } = await res.json();

    // Already-existing raw fields (were always in the row, just an audit
    // that they're actually present on the response).
    assert.equal(user.name, "Registration View Child");
    assert.equal(user.country, "GH");
    assert.equal(user.town, "Kumasi");
    assert.equal(user.school_name, "Kumasi Model School");
    assert.equal(user.age, 10);
    assert.equal(user.own_robotics_kit, 1);
    assert.ok(user.joined_date);
    assert.equal(user.status, "pending_payment");

    // Newly resolved fields (Stage 4H).
    assert.equal(user.programmeName, "Registration View Test Programme");
    assert.equal(user.deliveryMode, "ONLINE");
    assert.equal(user.parentName, "Registering Parent");

    // Never leaked, regardless of viewer.
    assert.equal(user.password_hash, undefined);
    assert.equal(user.temp_password_plaintext, undefined);

    // Sanity: the parent's own record also carries country/town.
    const parentRes = await fetch(`${server.baseUrl}/api/users/${parentId}`, {
      headers: { Cookie: sessionCookie(adminId, "admin") },
    });
    const { user: parentUser } = await parentRes.json();
    assert.equal(parentUser.town, "Kumasi");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("admin-registration-view: an adult self-registered learner (no parent_id) has parentName null, not an error", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const adminId = seedAdmin(dbPath);
    const db = new Database(dbPath);
    const adultId = uuid();
    db.prepare(
      `INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, is_adult, country, town, student_code)
       VALUES (?, 'learner', 'Solo Adult Learner', ?, ?, 'active', 'current', date('now'), 1, 'GH', 'Accra', ?)`
    ).run(adultId, `adult-${adultId}@example.test`, bcrypt.hashSync("adultpass123", 12), `T-${adultId.slice(0, 8)}`);
    db.close();

    const res = await fetch(`${server.baseUrl}/api/users/${adultId}`, {
      headers: { Cookie: sessionCookie(adminId, "admin") },
    });
    const { user } = await res.json();
    assert.equal(user.parentName, undefined);
    assert.equal(user.town, "Accra");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
