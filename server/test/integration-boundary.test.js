/**
 * Integration-level tests for the previously critical production
 * boundaries, layered on top of the pure-logic/source-pattern unit tests
 * in the other test/*.test.js files (which intentionally don't boot a
 * live server or hit real HTTP — see server-wiring.test.js's own
 * comment). These DO boot the real server as a child process and/or wire
 * up the real Express/multer pipeline, using only dependencies already in
 * package.json (no supertest or other test-only HTTP client — Node 20+'s
 * built-in fetch is enough).
 *
 * Scope, deliberately narrow: server startup, the static-file boundary,
 * /api/health + /api/ready, production error sanitization, CORS startup
 * failure, and one representative upload rejected end-to-end through the
 * real createUploadPipeline() (multer disk storage + content
 * verification), all mounted on a throwaway unauthenticated test route so
 * this stays scoped to the upload-hardening boundary rather than
 * exercising auth/RBAC (out of scope here — see auth's own test
 * coverage).
 *
 * Each server instance under test gets its own temp DB (migrated fresh)
 * and temp uploads dir, and is torn down (SIGTERM, matching production's
 * graceful-shutdown path) at the end of its test.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const net = require("net");

const SERVER_ENTRY = path.join(__dirname, "../src/server.js");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const SERVER_CWD = path.join(__dirname, "..");

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
      // server not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Boots a real server instance (migrate against a fresh temp DB, then
 * `node src/server.js`) with the given env overrides layered on top of
 * the minimum required to boot. Returns { baseUrl, stop(), stderr }.
 * Caller must always call stop() (tests use try/finally).
 */
async function bootServer(envOverrides = {}) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-int-db-"));
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-int-uploads-"));
  const dbPath = path.join(dbDir, "test.db");
  const port = await getFreePort();

  const baseEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    APP_URL: `http://127.0.0.1:${port}`,
    JWT_SECRET: "integration-test-secret-not-for-real-use",
    AI_CREDENTIALS_KEY: "integration-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
    UPLOAD_DIR: uploadDir,
  };
  const env = { ...baseEnv, ...envOverrides };

  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) {
    throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  }

  let stderr = "";
  let stdout = "";
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: SERVER_CWD, env });
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.stdout.on("data", (d) => (stdout += d.toString()));

  function cleanupDirs() {
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    getStderr: () => stderr,
    getStdout: () => stdout,
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) {
          cleanupDirs();
          return resolve();
        }
        child.once("exit", () => {
          cleanupDirs();
          resolve();
        });
        child.kill("SIGTERM");
        // Safety net in case graceful shutdown hangs in this environment.
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 4000);
      });
    },
  };
}

test("integration: real server boots and answers /api/health and /api/ready", async () => {
  const server = await bootServer();
  try {
    const up = await waitForReady(server.baseUrl, 10000);
    assert.ok(up, `server did not become healthy in time; stderr: ${server.getStderr()}`);

    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const ready = await fetch(`${server.baseUrl}/api/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });
  } finally {
    await server.stop();
  }
});

test("integration: static-file boundary — the project root, server/data, and dotfiles are never served", async () => {
  const server = await bootServer();
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));

    for (const url of ["/.env", "/server/data/builderslab.db", "/src/server.js", "/package.json"]) {
      const res = await fetch(`${server.baseUrl}${url}`);
      assert.equal(res.status, 404, `${url} must not be reachable`);
    }
    // The legacy allowlisted files must still be reachable (boundary is
    // "not everything", not "nothing").
    const legacy = await fetch(`${server.baseUrl}/index.html`);
    assert.equal(legacy.status, 200);
  } finally {
    await server.stop();
  }
});

test("integration: production error sanitization — a real 500 never leaks a stack trace to the client", async () => {
  const server = await bootServer();
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));

    // Malformed JSON body triggers body-parser's SyntaxError, which
    // reaches the central error handler exactly like any other unexpected
    // failure. Whatever status it resolves to, the response body must
    // never contain a stack trace in production.
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const body = await res.json();
    assert.equal("stack" in body, false, "production error responses must never include a stack trace");
    assert.equal(typeof body.error, "string");
  } finally {
    await server.stop();
  }
});

test("integration: every response carries a request ID for log correlation", async () => {
  const server = await bootServer();
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const res = await fetch(`${server.baseUrl}/api/health`);
    const requestId = res.headers.get("x-request-id");
    assert.match(requestId || "", /^[0-9a-f-]{36}$/i);
  } finally {
    await server.stop();
  }
});

test("integration: CORS startup safety — production boot with APP_URL unset refuses to start", async () => {
  const server = await bootServer({ APP_URL: "" });
  try {
    // Give it a moment, then confirm it never came up and exited non-zero
    // rather than silently listening with a broken CORS config.
    await new Promise((r) => setTimeout(r, 1500));
    const up = await waitForReady(server.baseUrl, 500);
    assert.equal(up, false, "server must not accept connections when APP_URL is missing in production");
    assert.notEqual(server.child.exitCode, 0, "server must exit non-zero when refusing to start");
  } finally {
    await server.stop();
  }
});

test("integration: graceful shutdown — SIGTERM closes the server without hanging", async () => {
  const server = await bootServer();
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000));
    const before = Date.now();
    await server.stop();
    const elapsedMs = Date.now() - before;
    assert.equal(server.child.exitCode, 0, "graceful shutdown should exit 0");
    assert.ok(elapsedMs < 4000, "shutdown should complete well before the SIGKILL safety-net fires");
  } finally {
    // already stopped above; stop() is idempotent (checks exitCode first)
    await server.stop();
  }
});

test("integration: a real multipart upload through the actual multer pipeline is rejected + deleted end-to-end", async () => {
  // Exercises createUploadPipeline() wired into a real (throwaway) Express
  // route and hit over real HTTP with a real multipart/form-data body —
  // distinct from upload-security.test.js, which calls verifyUploadedFile()
  // directly without multer or an HTTP layer in between. Mounted
  // unauthenticated on purpose: this test's boundary is the upload
  // pipeline, not auth/RBAC (see auth's own coverage for that boundary).
  const express = require("express");
  const { createUploadPipeline } = require("../src/middleware/upload");

  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-int-mp-uploads-"));
  process.env.UPLOAD_DIR = uploadDir;
  const { upload, verify, uploadDir: resolvedDir } = createUploadPipeline("IMAGE", "test-integration", 8);

  const app = express();
  app.post("/test-upload", upload.single("file"), verify, (req, res) => {
    res.status(200).json({ ok: true, path: req.file.path });
  });
  app.use((err, req, res, next) => {
    res.status(400).json({ error: err.message || "Upload rejected." });
  });

  const port = await getFreePort();
  const server = app.listen(port);
  try {
    const base = `http://127.0.0.1:${port}`;

    // A PHP payload disguised with a .png extension — must be rejected by
    // real content verification and deleted from disk.
    const phpPayload = new Blob([Buffer.from("<?php system($_GET['c']); ?>")], { type: "image/png" });
    const badForm = new FormData();
    badForm.append("file", phpPayload, "fake.png");
    const badRes = await fetch(`${base}/test-upload`, { method: "POST", body: badForm });
    assert.equal(badRes.status, 400);
    const filesAfterReject = fs.readdirSync(resolvedDir);
    assert.equal(filesAfterReject.length, 0, "rejected upload must not remain on disk");

    // A real PNG must still succeed through the same real pipeline.
    const realPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(20)]);
    const goodForm = new FormData();
    goodForm.append("file", new Blob([realPng], { type: "image/png" }), "real.png");
    const goodRes = await fetch(`${base}/test-upload`, { method: "POST", body: goodForm });
    assert.equal(goodRes.status, 200);
    const filesAfterAccept = fs.readdirSync(resolvedDir);
    assert.equal(filesAfterAccept.length, 1, "a valid upload must be persisted");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});
