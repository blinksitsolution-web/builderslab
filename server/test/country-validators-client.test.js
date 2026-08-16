/**
 * Focused tests for client/src/utils/validators.js's country-aware phone
 * validation and client/src/utils/countries.js's default. These are pure
 * ESM utility modules with no JSX/React/CSS imports, so Node's test
 * runner can exercise them directly via dynamic import() — no bundler,
 * no new dependency, no client test runner needed.
 *
 * Does not touch RegisterPage.jsx itself (that's a React component with
 * no existing client test harness to render it in — out of scope for a
 * focused addition; server/test/country-registration.test.js covers the
 * same behaviour end-to-end through the real registration endpoint).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

async function loadClientModule(relPath) {
  const url = pathToFileURL(path.join(__dirname, "..", "..", "client", "src", "utils", relPath)).href;
  return import(url);
}

test("country-validators: DEFAULT_COUNTRY is Ghana, and it's the first entry in COUNTRIES", async () => {
  const { DEFAULT_COUNTRY, COUNTRIES } = await loadClientModule("countries.js");
  assert.equal(DEFAULT_COUNTRY, "GH");
  assert.equal(COUNTRIES[0].code, "GH");
});

test("country-validators: isValidGhPhone behaviour is unchanged (10 digits, leading 0)", async () => {
  const { isValidGhPhone } = await loadClientModule("validators.js");
  assert.equal(isValidGhPhone("0501234567"), true);
  assert.equal(isValidGhPhone("501234567"), false, "missing leading 0 must still fail");
  assert.equal(isValidGhPhone("+233501234567"), false, "international-format number must still fail the Ghana-specific rule");
  assert.equal(isValidGhPhone(""), false);
});

test("country-validators: isValidContactPhone(_, 'GH') delegates to isValidGhPhone exactly (Ghana path unweakened)", async () => {
  const { isValidContactPhone, isValidGhPhone } = await loadClientModule("validators.js");
  const cases = ["0501234567", "0501234", "+233501234567", "", "05012345678"];
  for (const value of cases) {
    assert.equal(isValidContactPhone(value, "GH"), isValidGhPhone(value), `mismatch for ${JSON.stringify(value)}`);
  }
});

test("country-validators: non-Ghana country accepts a plausible international contact number", async () => {
  const { isValidContactPhone } = await loadClientModule("validators.js");
  assert.equal(isValidContactPhone("+14155550123", "US"), true);
  assert.equal(isValidContactPhone("+44 7911 123456", "GB"), true, "spaces must be tolerated");
  assert.equal(isValidContactPhone("020 7946 0958", "GB"), true, "no leading + is still acceptable");
  // Crucially: a number that fails the Ghana-specific rule (no leading 0)
  // must NOT be rejected once the country isn't Ghana.
  assert.equal(isValidContactPhone("+14155550123", "US"), true);
});

test("country-validators: empty or garbage international numbers are rejected", async () => {
  const { isValidContactPhone } = await loadClientModule("validators.js");
  assert.equal(isValidContactPhone("", "US"), false);
  assert.equal(isValidContactPhone("   ", "US"), false);
  assert.equal(isValidContactPhone("call me maybe", "US"), false);
  assert.equal(isValidContactPhone("123", "US"), false, "too short to be a real number");
});
