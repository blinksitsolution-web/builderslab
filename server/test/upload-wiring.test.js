/**
 * Static/wiring regression tests: confirm each upload-consuming route file
 * actually uses the shared hardened pipeline (server/src/middleware/upload.js)
 * with the expected profile, and that the post-upload verify middleware is
 * mounted after every upload.single(...) call.
 *
 * These are intentionally source-level (regex) checks rather than live HTTP
 * tests — this environment has no installed dependencies (no express/multer)
 * to boot the real server with. They're written loosely enough to tolerate
 * reformatting/whitespace changes: they look for the presence of specific
 * tokens, not exact lines.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROUTES_DIR = path.join(__dirname, "../src/routes");

function readRoute(file) {
  return fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
}

// Finds every `<identifier>.single(...)` call and checks the very next
// meaningful token afterwards is `verify` (allowing for an aliased verify
// name like `verify`, `verifyAvatar`, `verifyLogo`, etc. — any identifier
// starting with "verify").
function uploadSingleCallsHaveVerifyNext(source) {
  const callSites = [...source.matchAll(/\b\w+\.single\(\s*["'][\w-]+["']\s*\)/g)];
  assert.ok(callSites.length > 0, "expected at least one upload.single(...) call site");
  for (const match of callSites) {
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 200);
    // Next call-chain argument after the .single(...) call, ignoring commas/whitespace/comments.
    const nextArgMatch = after.match(/^\s*,\s*(\/\/[^\n]*\n\s*)*([A-Za-z_$][\w$]*)/);
    assert.ok(nextArgMatch, `no next middleware found after ${match[0]}`);
    assert.match(nextArgMatch[2], /^verify/i, `expected a verify* middleware right after ${match[0]}, found "${nextArgMatch[2]}"`);
  }
  return callSites.length;
}

test("upload-wiring: assignments.js uses the shared pipeline with the DOCUMENT profile", () => {
  const src = readRoute("assignments.js");
  assert.match(src, /require\(["']\.\.\/middleware\/upload["']\)/, "must require the shared upload middleware");
  assert.match(src, /createUploadPipeline\(\s*["']DOCUMENT["']/, "assignments must use the DOCUMENT profile");
  assert.doesNotMatch(src, /\bmulter\s*=\s*require\(["']multer["']\)/, "no direct multer require should remain");
  const count = uploadSingleCallsHaveVerifyNext(src);
  assert.equal(count, 1, "expected exactly one upload.single(...) call site in assignments.js");
});

test("upload-wiring: settings.js uses the shared pipeline with the IMAGE profile", () => {
  const src = readRoute("settings.js");
  assert.match(src, /require\(["']\.\.\/middleware\/upload["']\)/);
  assert.match(src, /createUploadPipeline\(\s*["']IMAGE["']/, "settings must use the IMAGE profile");
  assert.doesNotMatch(src, /\bmulter\s*=\s*require\(["']multer["']\)/);
  const count = uploadSingleCallsHaveVerifyNext(src);
  assert.ok(count >= 10, `expected settings.js to have many upload.single(...) call sites, found ${count}`);
});

test("upload-wiring: modules.js uses the shared pipeline with the IMAGE profile", () => {
  const src = readRoute("modules.js");
  assert.match(src, /require\(["']\.\.\/middleware\/upload["']\)/);
  assert.match(src, /createUploadPipeline\(\s*["']IMAGE["']/, "modules must use the IMAGE profile");
  assert.doesNotMatch(src, /\bmulter\s*=\s*require\(["']multer["']\)/);
  const count = uploadSingleCallsHaveVerifyNext(src);
  assert.ok(count >= 1, "expected at least one upload.single(...) call site in modules.js");
});

test("upload-wiring: learningOfferings.js uses the shared pipeline with the IMAGE profile", () => {
  const src = readRoute("learningOfferings.js");
  assert.match(src, /require\(["']\.\.\/middleware\/upload["']\)/);
  assert.match(src, /createUploadPipeline\(\s*["']IMAGE["']/, "learningOfferings must use the IMAGE profile");
  assert.doesNotMatch(src, /\bmulter\s*=\s*require\(["']multer["']\)/);
  const count = uploadSingleCallsHaveVerifyNext(src);
  assert.ok(count >= 2, "expected corporate-client logo + programme image upload.single(...) call sites");
});

test("upload-wiring: no legacy standalone multer upload config remains in any migrated route file", () => {
  for (const file of ["projects.js", "notes.js", "campusBranding.js", "users.js", "certificateTemplates.js", "assignments.js", "settings.js", "modules.js", "learningOfferings.js"]) {
    const src = readRoute(file);
    assert.doesNotMatch(src, /multer\.diskStorage/, `${file} must not define its own multer.diskStorage`);
    assert.doesNotMatch(
      src,
      /fileFilter:\s*\(req,\s*file,\s*cb\)\s*=>\s*cb\(\s*\/\^image\\\//,
      `${file} must not define its own ad-hoc mimetype-only fileFilter`
    );
  }
});
