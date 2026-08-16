/**
 * Static/wiring regression tests on server.js's source. These do NOT boot a
 * live server (this environment has no installed dependencies — no
 * express/helmet/cors/etc — so an actual `require("../src/server.js")` or
 * live HTTP request against a running instance isn't possible here). They
 * instead assert, at the source level, that the specific patterns behind
 * each fix are present and haven't regressed. Written to tolerate
 * reformatting/whitespace — they check for tokens/structure, not exact
 * lines.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SERVER_SRC = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

test("static-boundary: server.js never hands express.static the project root or server/ directory", () => {
  // The original BL-001 bug was `express.static(path.join(__dirname, "../../"))`
  // mounted directly at "/" or elsewhere with no allowlist. Assert no
  // remaining express.static call points at FRONTEND_DIR/project root
  // directly (only /images and the explicit per-file allowlist may use it).
  const staticCalls = [...SERVER_SRC.matchAll(/express\.static\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(staticCalls.length > 0, "expected at least one express.static(...) call");
  for (const args of staticCalls) {
    assert.doesNotMatch(
      args,
      /FRONTEND_DIR\)\s*$/,
      "express.static must never be called with the bare project-root directory"
    );
  }
});

test("static-boundary: the legacy public-file allowlist excludes .env, the database, auth.js, and package.json", () => {
  const match = SERVER_SRC.match(/LEGACY_PUBLIC_FILES\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, "expected a LEGACY_PUBLIC_FILES allowlist in server.js");
  const listContents = match[1];
  for (const forbidden of [".env", "builderslab.db", "auth.js", "package.json"]) {
    assert.doesNotMatch(listContents, new RegExp(forbidden.replace(".", "\\.")), `${forbidden} must not be in the public allowlist`);
  }
});

test("static-boundary: legitimate public routes remain wired (/, /app, /images)", () => {
  assert.match(SERVER_SRC, /app\.get\(\s*["']\/["']/, "root route must still exist");
  assert.match(SERVER_SRC, /app\.use\(\s*["']\/app["']/, "/app must still be mounted");
  assert.match(SERVER_SRC, /app\.use\(\s*["']\/images["']/, "/images must still be mounted");
});

test("static-boundary: /server/data and /server/src are never exposed via any static mount or explicit route", () => {
  assert.doesNotMatch(SERVER_SRC, /["']\/server\/data/);
  assert.doesNotMatch(SERVER_SRC, /["']\/server\/src/);
  assert.doesNotMatch(SERVER_SRC, /app\.(get|use)\(\s*["']\/\.env/);
});

test("health-endpoint: GET /api/health exists, is unauthenticated, and returns only a minimal safe body", () => {
  const match = SERVER_SRC.match(/app\.get\(\s*["']\/api\/health["']\s*,\s*([^)]*)\)\s*=>\s*([^;]*);/);
  assert.ok(match, "expected app.get(\"/api/health\", ...) in server.js");
  const handlerBody = match[2];
  assert.match(handlerBody, /status:\s*["']ok["']/, "health endpoint should report a simple ok status");
  // No secrets/env/db/filesystem leakage in the handler body itself.
  for (const forbidden of ["process.env", "req.headers.authorization", "db.prepare", "readFileSync", "JWT_SECRET"]) {
    assert.doesNotMatch(handlerBody, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `health handler must not reference ${forbidden}`);
  }
  // Not gated behind requireAuth/requireRole — it's meant to be a public
  // liveness probe for load balancers/uptime monitors.
  const fullStatement = SERVER_SRC.slice(SERVER_SRC.indexOf('"/api/health"') - 20, SERVER_SRC.indexOf('"/api/health"') + 120);
  assert.doesNotMatch(fullStatement, /requireAuth|requireRole|requirePermission/);
});

test("rate-limiting: a global /api limiter exists and does not remove the stricter auth-specific limiters", () => {
  assert.match(SERVER_SRC, /globalApiLimiter\s*=\s*rateLimit\(/, "expected a globalApiLimiter");
  assert.match(SERVER_SRC, /app\.use\(\s*["']\/api["']\s*,\s*globalApiLimiter\s*\)/, "globalApiLimiter must be mounted on /api");

  assert.match(SERVER_SRC, /authLimiter\s*=\s*rateLimit\(/, "expected the existing authLimiter to remain");
  assert.match(SERVER_SRC, /app\.use\(\s*["']\/api\/auth\/login["']\s*,\s*authLimiter\s*\)/, "login must still use authLimiter");
  assert.match(SERVER_SRC, /app\.use\(\s*["']\/api\/auth\/register["']\s*,\s*authLimiter\s*\)/, "register must still use authLimiter");

  assert.match(SERVER_SRC, /forgotPasswordLimiter\s*=\s*rateLimit\(/, "expected the existing forgotPasswordLimiter to remain");
  assert.match(
    SERVER_SRC,
    /app\.use\(\s*["']\/api\/users\/forgot-password["']\s*,\s*forgotPasswordLimiter\s*\)/,
    "forgot-password must still use forgotPasswordLimiter"
  );

  // The stricter limiters must be declared/mounted before the global one so
  // they aren't accidentally shadowed by route-matching order.
  const globalIdx = SERVER_SRC.indexOf("globalApiLimiter = rateLimit(");
  const authIdx = SERVER_SRC.indexOf("authLimiter = rateLimit(");
  const forgotIdx = SERVER_SRC.indexOf("forgotPasswordLimiter = rateLimit(");
  assert.ok(authIdx > -1 && forgotIdx > -1 && globalIdx > -1);
  assert.ok(authIdx < globalIdx, "authLimiter should be declared before globalApiLimiter");
  assert.ok(forgotIdx < globalIdx, "forgotPasswordLimiter should be declared before globalApiLimiter");
});

test("cors-startup-wiring: server.js actually calls the extracted CORS safety check before app.use(cors(...))", () => {
  assert.match(SERVER_SRC, /require\(["']\.\/utils\/corsSafety["']\)/);
  assert.match(SERVER_SRC, /isProductionCorsMisconfigured\(process\.env\)/);
  const guardIdx = SERVER_SRC.indexOf("isProductionCorsMisconfigured(process.env)");
  const corsUseIdx = SERVER_SRC.indexOf("cors({");
  assert.ok(guardIdx > -1 && corsUseIdx > -1 && guardIdx < corsUseIdx, "the safety check must run before cors() is applied");
  assert.match(SERVER_SRC, /process\.exit\(1\)/, "must actually refuse to start, not just log");
});

test("error-handler-wiring: server.js delegates to the extracted, tested buildErrorResponse", () => {
  assert.match(SERVER_SRC, /require\(["']\.\/utils\/errorResponse["']\)/);
  assert.match(SERVER_SRC, /buildErrorResponse\(err,\s*process\.env\.NODE_ENV === ["']production["']\)/);
});
