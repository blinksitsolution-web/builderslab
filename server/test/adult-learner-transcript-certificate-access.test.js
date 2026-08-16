/**
 * Stage 1 — Adult Learner Transcript and Certificate Access.
 *
 * Backend authorization for GET /api/grades/:userId/transcript and
 * GET /api/certificates/learner/:userId was already correct (both are
 * gated by requireSelfParentOrStaff + requireActiveAccess, which already
 * allow the user themself — see server/src/middleware/auth.js). The
 * actual bug was that the React app had no route/page for a learner
 * logged in directly (an adult learner, role:"learner") to reach either
 * endpoint at all — only parent/* and admin/* routes existed (see
 * client/src/routing/AppRoutes.jsx). This test locks in the backend
 * contract those new pages (LearnerTranscriptsPage.jsx /
 * LearnerCertificatesPage.jsx) rely on: a solo adult learner can fetch
 * their own transcript and certificates, and still cannot fetch another
 * unrelated learner's.
 *
 * Same real-server-process pattern as payment-verify-authorization.test.js.
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
const JWT_SECRET = "adult-learner-access-test-secret-not-for-real-use";

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
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-adult-access-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    NODE_ENV: "production",
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "adult-learner-access-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-adult-access-uploads-"));
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

// One standalone (parent-less) adult learner, plus a second, unrelated
// adult learner used to prove cross-account access is still refused.
function seedFixtures(dbPath) {
  const db = new Database(dbPath);
  try {
    const mkUser = (extra = {}) => {
      const id = uuid();
      db.prepare(
        "INSERT INTO users (id, role, name, email, password_hash, status, payment_status, joined_date, parent_id, is_adult) VALUES (?, 'learner', ?, ?, 'x', 'active', 'current', date('now'), NULL, 1)"
      ).run(id, extra.name || "Adult Learner", `adult-${id}@example.test`);
      return id;
    };

    const adultId = mkUser({ name: "Solo Adult Learner" });
    const otherAdultId = mkUser({ name: "Unrelated Adult Learner" });

    return { adultId, otherAdultId };
  } finally {
    db.close();
  }
}

test("adult-learner-access: an adult learner can fetch their own transcript", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const res = await fetch(`${server.baseUrl}/api/grades/${fx.adultId}/transcript`, {
      headers: { Cookie: sessionCookie(fx.adultId, "learner") },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.learner, "transcript response should include the learner's own record");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("adult-learner-access: an adult learner can fetch their own certificates", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const res = await fetch(`${server.baseUrl}/api/certificates/learner/${fx.adultId}`, {
      headers: { Cookie: sessionCookie(fx.adultId, "learner") },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.certificates));
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("adult-learner-access: an adult learner cannot fetch another unrelated learner's transcript or certificates", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const fx = seedFixtures(dbPath);

    const transcriptRes = await fetch(`${server.baseUrl}/api/grades/${fx.otherAdultId}/transcript`, {
      headers: { Cookie: sessionCookie(fx.adultId, "learner") },
    });
    assert.equal(transcriptRes.status, 403);

    const certsRes = await fetch(`${server.baseUrl}/api/certificates/learner/${fx.otherAdultId}`, {
      headers: { Cookie: sessionCookie(fx.adultId, "learner") },
    });
    assert.equal(certsRes.status, 403);
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
