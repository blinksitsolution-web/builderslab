// Campus name resolution — closes the free-text/foreign-key drift the
// constitution (Section 3) flags as a data-integrity defect: "a recurring
// implementation smell ... a table or route that references a Campus ...
// by free-text name rather than by foreign key."
//
// users.campus remains a free-text column (see db/migrate.js v6 comment —
// changing its type is a separate, larger migration), so until that
// migration happens this module is the SINGLE place that decides what
// counts as "the same campus" as a canonical campuses.name value. Every
// write path that sets users.campus from user-supplied text (registration,
// sponsor bulk-registration, any future one) must go through
// resolveCampusByName() rather than trusting the raw input, per the Single
// Ownership Principle (Section 2.1): one function owns "what is a valid
// campus name," not a scattered `.trim()` at each call site.
const db = require("../db/db");

function normalizeForComparison(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Resolves free-text campus input against the canonical campuses table,
// case/whitespace-insensitive. Returns the canonical row ({ id, name,
// active }) on a match, or null if the input doesn't correspond to any
// known campus. Never creates a campus — creating campuses is the Super
// Administrator's job via the campuses admin UI (routes/modules.js), not
// something a registration form or a spreadsheet upload should be able to
// do implicitly.
function resolveCampusByName(rawName) {
  if (!rawName || !String(rawName).trim()) return null;
  const target = normalizeForComparison(rawName);
  const rows = db.prepare("SELECT id, name, active FROM campuses").all();
  const match = rows.find((r) => normalizeForComparison(r.name) === target);
  return match || null;
}

// One-time, idempotent repair for users.campus values that already drifted
// from campuses.name before this validation existed (e.g. seeded/imported
// data with casing or whitespace differences). Rewrites each mismatched
// users.campus to the canonical spelling wherever an unambiguous
// case/whitespace-insensitive match exists; leaves values with no match
// untouched (those need a human to pick the right campus — silently
// guessing would be its own data-integrity risk) and logs them so the
// mismatch is visible instead of silently swallowed.
function backfillCampusNameConsistency() {
  const campuses = db.prepare("SELECT id, name, active FROM campuses").all();
  if (!campuses.length) return { fixed: 0, unresolved: [] };

  const byNormalized = new Map(campuses.map((c) => [normalizeForComparison(c.name), c.name]));

  const users = db
    .prepare("SELECT id, campus FROM users WHERE campus IS NOT NULL AND TRIM(campus) != ''")
    .all();

  const update = db.prepare("UPDATE users SET campus = ? WHERE id = ?");
  let fixed = 0;
  const unresolved = new Set();

  const applyFixes = db.transaction((rows) => {
    for (const u of rows) {
      const normalized = normalizeForComparison(u.campus);
      const canonical = byNormalized.get(normalized);
      if (canonical == null) {
        unresolved.add(u.campus);
        continue;
      }
      if (canonical !== u.campus) {
        update.run(canonical, u.id);
        fixed += 1;
      }
    }
  });
  applyFixes(users);

  if (fixed > 0) {
    console.log(`✅ Campus resolution: normalized ${fixed} users.campus value(s) to match the canonical campuses table.`);
  }
  if (unresolved.size > 0) {
    console.warn(
      `⚠️  Campus resolution: ${unresolved.size} distinct users.campus value(s) do not match any campus and were left as-is: ${[...unresolved].join(", ")}`
    );
  }
  return { fixed, unresolved: [...unresolved] };
}

module.exports = {
  normalizeForComparison,
  resolveCampusByName,
  backfillCampusNameConsistency,
};
