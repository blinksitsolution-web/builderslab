/**
 * Focused tests for the smallest additive Paystack hosted card-payment
 * flow: the explicit `method` boundary on POST /payments/:userId/initiate
 * (MOBILE_MONEY vs CARD) and the new `paystack.initiateCardCharge()`
 * helper.
 *
 * Section A runs against the real server process (same pattern as
 * delivery-mode-registration.test.js / country-registration.test.js),
 * but deliberately does NOT set NODE_ENV=production — unlike those files
 * — because these tests need the existing dev/test fallback in
 * routes/payments.js (auto-completes a payment when no
 * PAYSTACK_SECRET_KEY is configured) to exercise the CARD branch without
 * a real Paystack account or network access to api.paystack.co (not on
 * this environment's egress allowlist). This is exactly the "existing
 * development/test fallback conventions" the task calls for.
 *
 * Section B unit-tests paystack.initiateCardCharge() in isolation with a
 * mocked global.fetch, since the dev-fallback in Section A means Paystack
 * is never actually called there — this is the only place that verifies
 * the actual hosted-checkout request shape (GHS currency, card channel,
 * callback_url, pesewas amount) and that authorization_url propagates.
 *
 * Does not re-test anything already covered: not Ghana MoMo initiation
 * itself (existing 85 tests + this file's own unchanged-MoMo case), not
 * registration/country validation (country-registration.test.js), not
 * currency-column defaulting (payments-currency.test.js).
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
const JWT_SECRET = "card-payment-test-secret-not-for-real-use";

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

// NOTE: NODE_ENV deliberately NOT "production" here — see file header.
function prepareDb() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-card-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const env = {
    ...process.env,
    JWT_SECRET,
    AI_CREDENTIALS_KEY: "card-payment-test-ai-key-not-for-real-use",
    DB_PATH: dbPath,
  };
  delete env.NODE_ENV;
  delete env.PAYSTACK_SECRET_KEY; // ensure the dev fallback actually fires
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], { cwd: SERVER_CWD, env, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`migrate failed (exit ${migrate.status}): ${migrate.stderr}`);
  return { dbDir, dbPath, env };
}

async function startServer({ dbPath, env }) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-card-uploads-"));
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

// Same shape issueSession() produces ({sub, role} — middleware/auth.js) —
// mints a session cookie directly rather than going through login, since
// only the payments endpoint is in scope here.
function sessionCookie(userId, role) {
  const token = jwt.sign({ sub: userId, role }, JWT_SECRET, { expiresIn: "1h" });
  return `dtl_token=${token}`;
}

function readUser(dbPath, userId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  } finally {
    db.close();
  }
}

function readPaymentByRef(dbPath, ref) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM payments WHERE paystack_ref = ?").get(ref);
  } finally {
    db.close();
  }
}

async function registerAdult(baseUrl, overrides = {}) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "adult",
      courseIds: ["HW-05"],
      adult: {
        name: "Test Learner",
        email: `learner-${uuid()}@example.com`,
        password: "Passw0rd123",
        phone: "0501234567",
        ...overrides,
      },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

// ---- Section A: full-server, dev-fallback -------------------------------

test("card-payment: MOBILE_MONEY (implicit, method omitted) is completely unchanged — existing callers keep working", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const reg = await registerAdult(server.baseUrl);
    const cookie = sessionCookie(reg.learnerId, "learner");
    const res = await fetch(`${server.baseUrl}/api/payments/${reg.learnerId}/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ type: "registration", network: "MTN", momoNumber: "0501234567" }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, "success");
    const payment = readPaymentByRef(dbPath, body.reference);
    assert.equal(payment.method, "MTN MoMo");
    assert.equal(payment.momo_number, "0501234567");
    assert.equal(payment.currency, "GHS");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("card-payment: an invalid payment method is rejected, no payment row created", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const reg = await registerAdult(server.baseUrl);
    const cookie = sessionCookie(reg.learnerId, "learner");
    const before = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) as n FROM payments").get().n;
    const res = await fetch(`${server.baseUrl}/api/payments/${reg.learnerId}/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ type: "registration", method: "BITCOIN" }),
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(body.error, /method/i);
    const after = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) as n FROM payments").get().n;
    assert.equal(after, before, "a rejected method must not create a payment row");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("card-payment: explicit CARD method reaches the hosted-card branch, uses the authoritative GHS fee, no momoNumber required", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const reg = await registerAdult(server.baseUrl, { country: "US", phone: "+14155550123" });
    const cookie = sessionCookie(reg.learnerId, "learner");
    // Deliberately no network/momoNumber at all — the CARD path must not
    // require them, and must not be rejected for lacking them.
    const res = await fetch(`${server.baseUrl}/api/payments/${reg.learnerId}/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ type: "registration", method: "CARD" }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.method, "CARD");
    // No real Paystack call happens under the dev fallback, so there's no
    // real authorization_url to propagate here — see the file header and
    // Section B, which verifies authorization_url propagation directly
    // against a mocked Paystack response instead.
    assert.equal(body.authorizationUrl, null);
    assert.equal(body.status, "success");

    const payment = readPaymentByRef(dbPath, body.reference);
    assert.equal(payment.method, "Card");
    assert.equal(payment.momo_number, null, "a card payment must never carry a Ghana MoMo number");
    assert.equal(payment.currency, "GHS", "GHS stays authoritative even for the card path");
    assert.equal(payment.amount, 350, "must use the same authoritative fee resolution as Mobile Money (default registration fee)");
    assert.equal(payment.status, "successful");

    const user = readUser(dbPath, reg.learnerId);
    assert.equal(user.status, "active", "activateSuccessfulPayment() must apply identically regardless of payment method");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("card-payment: CARD and MOBILE_MONEY registrations from the same run use the same GHS amount for the same fee type", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const momoReg = await registerAdult(server.baseUrl);
    const cardReg = await registerAdult(server.baseUrl, { country: "GB", phone: "+447911123456" });

    const momoRes = await fetch(`${server.baseUrl}/api/payments/${momoReg.learnerId}/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(momoReg.learnerId, "learner") },
      body: JSON.stringify({ type: "registration", method: "MOBILE_MONEY", network: "MTN", momoNumber: "0501234567" }),
    });
    const cardRes = await fetch(`${server.baseUrl}/api/payments/${cardReg.learnerId}/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie(cardReg.learnerId, "learner") },
      body: JSON.stringify({ type: "registration", method: "CARD" }),
    });
    const momoBody = await momoRes.json();
    const cardBody = await cardRes.json();
    assert.equal(momoRes.status, 200, JSON.stringify(momoBody));
    assert.equal(cardRes.status, 200, JSON.stringify(cardBody));

    const momoPayment = readPaymentByRef(dbPath, momoBody.reference);
    const cardPayment = readPaymentByRef(dbPath, cardBody.reference);
    assert.equal(momoPayment.amount, cardPayment.amount, "switching method must not change the resolved fee amount");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("card-payment: CARD method also works for the ongoing monthly-fee payment (type=monthly), not just registration — the path PayMonthlyFeeModal.jsx now uses for non-Ghana accounts", async () => {
  const { dbDir, dbPath, env } = prepareDb();
  const server = await startServer({ dbPath, env });
  try {
    assert.ok(await waitForReady(server.baseUrl, 10000), server.getStderr());
    const reg = await registerAdult(server.baseUrl, { country: "NG", phone: "+2348012345678" });
    const cookie = sessionCookie(reg.learnerId, "learner");
    const res = await fetch(`${server.baseUrl}/api/payments/${reg.learnerId}/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ type: "monthly", method: "CARD" }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.method, "CARD");
    assert.equal(body.status, "success"); // dev fallback

    const payment = readPaymentByRef(dbPath, body.reference);
    assert.equal(payment.type, "monthly");
    assert.equal(payment.method, "Card");
    assert.equal(payment.momo_number, null);
    assert.equal(payment.currency, "GHS");
    assert.equal(payment.status, "successful");

    const user = readUser(dbPath, reg.learnerId);
    assert.equal(user.payment_status, "current", "activateSuccessfulPayment() must mark the account current for a monthly CARD payment exactly as it does for Mobile Money");
  } finally {
    await server.stop();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

// ---- Section B: paystack.initiateCardCharge() unit test -----------------

test("paystack.initiateCardCharge: posts a GHS hosted-checkout request and propagates authorization_url", async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-card-unit-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], {
    cwd: SERVER_CWD,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: "utf8",
  });
  assert.equal(migrate.status, 0, migrate.stderr);

  const originalFetch = global.fetch;
  const originalDbPath = process.env.DB_PATH;
  const originalKey = process.env.PAYSTACK_SECRET_KEY;
  process.env.DB_PATH = dbPath; // getSetting() -> db/db.js reads this at require time
  process.env.PAYSTACK_SECRET_KEY = "sk_test_fake_key_for_unit_test";

  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        status: true,
        data: { authorization_url: "https://checkout.paystack.com/abc123", access_code: "abc123", reference: captured.body.reference },
      }),
    };
  };

  delete require.cache[require.resolve("../src/db/db")];
  delete require.cache[require.resolve("../src/utils/settings")];
  delete require.cache[require.resolve("../src/utils/paystack")];
  const paystack = require("../src/utils/paystack");

  try {
    const result = await paystack.initiateCardCharge({
      email: "learner@example.test",
      amountGHS: 350,
      reference: "DTL-unit-test-ref",
      callbackUrl: "http://127.0.0.1:9999/app/register",
    });
    assert.equal(captured.url, "https://api.paystack.co/transaction/initialize");
    assert.equal(captured.body.currency, "GHS");
    assert.equal(captured.body.amount, 35000, "amount must be in pesewas, same unit as Mobile Money");
    assert.deepEqual(captured.body.channels, ["card"]);
    assert.equal(captured.body.callback_url, "http://127.0.0.1:9999/app/register");
    assert.equal(captured.body.reference, "DTL-unit-test-ref");
    assert.equal(result.authorization_url, "https://checkout.paystack.com/abc123", "authorization_url must propagate back to the caller");
  } finally {
    global.fetch = originalFetch;
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalKey;
    delete require.cache[require.resolve("../src/db/db")];
    delete require.cache[require.resolve("../src/utils/settings")];
    delete require.cache[require.resolve("../src/utils/paystack")];
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
