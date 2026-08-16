/**
 * Pure-logic regression tests for the production error-sanitization fix.
 * Exercises the real extracted function used by server.js's central error
 * handler (src/utils/errorResponse.js) — no Express instance required.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildErrorResponse } = require("../src/utils/errorResponse");

test("error-handling: production 5xx responses never leak internals", () => {
  const sqlErr = new Error("SQLITE_ERROR: no such column: users.ssn at /home/app/server/src/routes/users.js:123");
  sqlErr.status = 500;
  const { status, body } = buildErrorResponse(sqlErr, /* isProduction */ true);

  assert.equal(status, 500);
  assert.equal(body.error, "Something went wrong.");
  assert.equal(body.stack, undefined, "stack trace must never be sent to the client in production");
  assert.doesNotMatch(JSON.stringify(body), /SQLITE_ERROR/);
  assert.doesNotMatch(JSON.stringify(body), /\/home\/app/);
});

test("error-handling: production 500 with no explicit status still collapses to the generic message", () => {
  const err = new Error("ENOENT: no such file or directory, open '/server/data/builderslab.db'");
  const { status, body } = buildErrorResponse(err, true);
  assert.equal(status, 500);
  assert.equal(body.error, "Something went wrong.");
  assert.doesNotMatch(JSON.stringify(body), /builderslab\.db/);
});

test("error-handling: deliberate 4xx validation messages remain available in production", () => {
  const validationErr = new Error("Title and module are required.");
  validationErr.status = 400;
  const { status, body } = buildErrorResponse(validationErr, true);
  assert.equal(status, 400);
  assert.equal(body.error, "Title and module are required.");
});

test("error-handling: development keeps full detail and stack", () => {
  const err = new Error("SQLITE_ERROR: no such column: users.ssn");
  err.status = 500;
  const { status, body } = buildErrorResponse(err, /* isProduction */ false);
  assert.equal(status, 500);
  assert.match(body.error, /SQLITE_ERROR/);
  assert.ok("stack" in body, "development responses should retain the stack for debugging");
});
