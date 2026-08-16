/* ==========================================================================
   Shared client-side validation, mirroring server/src/utils/validators.js
   (and, before it, legacy api.js's DTL.validators) exactly — same regexes,
   same password policy, same message wording — so a bypassed/absent
   client check is still enforced identically server-side, and the two
   never drift. Used by RegisterPage (Group 1 migration); LoginPage keeps
   its own minimal inline email check since it doesn't need the rest.
   ========================================================================== */

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

// Ghana mobile numbers: 10 digits, leading 0 (e.g. 0501234567).
export function isValidGhPhone(value) {
  return /^0\d{9}$/.test(String(value || "").trim());
}

// International contact numbers: deliberately loose (no libphonenumber —
// this codebase has no phone-number library and one isn't warranted for a
// v1 foundation). Accepts an optional leading "+" and 7-15 digits once
// common punctuation (spaces, dashes, dots, parentheses) is stripped —
// enough to reject empty/garbage input without asserting any one
// country's specific format, which is the whole point: this path exists
// precisely because a single fixed shape (Ghana's) doesn't fit everyone.
export function isValidIntlPhone(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  const digits = trimmed.replace(/[\s\-().]/g, "");
  return /^\+?\d{7,15}$/.test(digits);
}

// Single entry point RegisterPage uses for the contact-phone field: Ghana
// keeps its existing exact-shape rule unchanged; every other country uses
// the loose international check above instead of being forced through a
// Ghana-shaped regex it was never going to match.
export function isValidContactPhone(value, countryCode) {
  return countryCode === "GH" ? isValidGhPhone(value) : isValidIntlPhone(value);
}

// Baseline production password policy: 8+ characters, at least one
// letter and one digit.
export function isStrongPassword(value) {
  const v = String(value || "");
  return v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v);
}

export function passwordMessage(value) {
  const v = String(value || "");
  if (v.length < 8) return "Password needs to be at least 8 characters.";
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return "Password needs at least one letter and one number.";
  return "";
}
