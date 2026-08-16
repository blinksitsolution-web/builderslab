// Shared server-side validation, mirroring the client-side DTL.validators in
// api.js. Client checks can always be bypassed (curl, disabled JS, a stale
// cached bundle), so every public endpoint that accepts a password/email
// re-checks it here rather than trusting the client — this is the
// server-side half of that defense-in-depth pair, now in one place instead
// of duplicated (and drifting) across auth.js/users.js.

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

// ISO 3166-1 alpha-2 country code (e.g. 'GH', 'US', 'GB') — exactly two
// letters, case-insensitive on input. Doesn't check against a real
// country list (no such list exists in this codebase yet); that's an
// acceptable gap for a v1 foundation column, same tradeoff Option A of
// the currency architectural assessment made for payments.currency.
function isValidCountryCode(code) {
  return /^[A-Za-z]{2}$/.test(String(code || "").trim());
}

// Baseline production password policy: 8+ characters, at least one letter
// and one digit. Deliberately does not require symbols/mixed-case — that
// tends to just push people toward predictable substitutions ("Password1!")
// without meaningfully raising real-world strength, per NIST SP 800-63B's
// guidance to favor length over composition rules.
function isStrongPassword(password) {
  const v = String(password || "");
  return v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v);
}

function passwordMessage(password) {
  const v = String(password || "");
  if (v.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return "Password must contain at least one letter and one number.";
  return "";
}

module.exports = { isValidEmail, isStrongPassword, passwordMessage, isValidCountryCode };
