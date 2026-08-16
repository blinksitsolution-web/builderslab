const db = require("../db/db");

// Generates the next unique per-year student ID, e.g. "DTL-2026-0001".
// Parents use this as the reference when paying via Mobile Money, and
// admin can look up a learner/parent by it on the payments side.
function nextStudentCode() {
  const year = new Date().getFullYear();
  const prefix = `DTL-${year}-`;
  const row = db.prepare("SELECT COUNT(*) as n FROM users WHERE student_code LIKE ?").get(`${prefix}%`);
  let n = row.n + 1;
  let code = `${prefix}${String(n).padStart(4, "0")}`;
  // Extremely defensive: guarantee uniqueness even if counts ever drift.
  while (db.prepare("SELECT id FROM users WHERE student_code = ?").get(code)) {
    n += 1;
    code = `${prefix}${String(n).padStart(4, "0")}`;
  }
  return code;
}

module.exports = { nextStudentCode };
