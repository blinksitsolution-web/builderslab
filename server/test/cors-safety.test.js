/**
 * Pure-logic regression tests for the production CORS startup-safety check.
 * Exercises the real extracted function used by server.js at boot
 * (src/utils/corsSafety.js) — no server process is actually started/killed
 * by these tests; they only check the pure decision function.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { isProductionCorsMisconfigured } = require("../src/utils/corsSafety");

test("cors-safety: production with a valid APP_URL is fine", () => {
  assert.equal(isProductionCorsMisconfigured({ NODE_ENV: "production", APP_URL: "https://app.example.com" }), false);
});

test("cors-safety: production with a missing APP_URL is flagged as misconfigured", () => {
  assert.equal(isProductionCorsMisconfigured({ NODE_ENV: "production" }), true);
});

test("cors-safety: production with an empty-string APP_URL is flagged as misconfigured", () => {
  assert.equal(isProductionCorsMisconfigured({ NODE_ENV: "production", APP_URL: "" }), true);
});

test("cors-safety: development with no APP_URL is allowed (local dev convenience preserved)", () => {
  assert.equal(isProductionCorsMisconfigured({ NODE_ENV: "development" }), false);
});

test("cors-safety: unset NODE_ENV (e.g. ad-hoc local run) is not treated as production", () => {
  assert.equal(isProductionCorsMisconfigured({}), false);
});
