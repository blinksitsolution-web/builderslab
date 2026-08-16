/**
 * Pure-logic regression tests for the /uploads serving hardening.
 * Exercises the real extracted function used by server.js
 * (src/utils/uploadsServing.js) — no Express/express.static instance
 * required.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { getUploadsResponseHeaders } = require("../src/utils/uploadsServing");

test("uploads-serving: nosniff is always set, regardless of file type", () => {
  for (const p of ["/projects/x.png", "/notes/x.docx", "/notes/x.html", "/avatars/x"]) {
    assert.equal(getUploadsResponseHeaders(p)["X-Content-Type-Options"], "nosniff");
  }
});

test("uploads-serving: known-safe image/video/pdf types render inline with the correct type", () => {
  assert.deepEqual(getUploadsResponseHeaders("/avatars/x.png")["Content-Type"], "image/png");
  assert.equal(getUploadsResponseHeaders("/avatars/x.png")["Content-Disposition"], undefined);
  assert.equal(getUploadsResponseHeaders("/projects/x.mp4")["Content-Type"], "video/mp4");
  assert.equal(getUploadsResponseHeaders("/notes/x.pdf")["Content-Type"], "application/pdf");
});

test("uploads-serving: anything outside the safe-inline allowlist is forced to download", () => {
  const headers = getUploadsResponseHeaders("/notes/x.docx");
  assert.equal(headers["Content-Type"], "application/octet-stream");
  assert.equal(headers["Content-Disposition"], "attachment");
});

test("uploads-serving: an unexpected/dangerous extension on disk is still forced to download, never rendered inline", () => {
  const headers = getUploadsResponseHeaders("/notes/x.html");
  assert.equal(headers["Content-Disposition"], "attachment");
  assert.notEqual(headers["Content-Type"], "text/html");
});

test("uploads-serving: extensionless paths are forced to download", () => {
  const headers = getUploadsResponseHeaders("/notes/noext");
  assert.equal(headers["Content-Disposition"], "attachment");
});
