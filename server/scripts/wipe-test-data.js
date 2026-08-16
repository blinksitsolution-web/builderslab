// server/scripts/wipe-test-data.js
//
// Wipes every parent/learner account and every Learning Instance, plus all
// rows in every table that references them, so you can restart testing on
// a clean slate. Leaves the catalog intact: programmes, classes, courses,
// offering types, campuses, site settings, and all admin/staff/instructor
// accounts are NOT touched.
//
// Several of these foreign keys are declared ON DELETE NO ACTION (not
// CASCADE) — see e.g. programme_enrollments.user_id, payments.learning_instance_id,
// refunds.payment_id — so a plain `DELETE FROM users ...` will fail with a
// FOREIGN KEY constraint error unless the dependent tables are cleared
// first. This script clears them in one transaction with foreign_keys
// temporarily OFF (which also means ON DELETE CASCADE won't fire on its
// own, so every dependent table below is cleared explicitly rather than
// relied on to cascade).
//
// Usage:
//   node scripts/wipe-test-data.js            # dry run — prints row counts only
//   node scripts/wipe-test-data.js --yes       # actually wipes
//
// Always stop the server first (WAL-mode SQLite + a live process writing
// to the same file is asking for trouble mid-wipe).

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../data/builderslab.db");
const CONFIRM = process.argv.includes("--yes");

// Tables that reference users(learner/parent) and/or learning_instances,
// directly or transitively (e.g. refunds -> payments -> users). Order
// doesn't matter since foreign_keys is OFF for the whole transaction, but
// they're listed roughly leaf-to-root for readability.
const TABLES_TO_CLEAR = [
  "refunds",
  "learning_instance_period_targets",
  "assignment_submissions",
  "attendance",
  "ca_attempts",
  "continuous_assessments",
  "corporate_pricing",
  "course_topics",
  "discount_grants",
  "discount_policies",
  "enrollments",
  "examination_attempts",
  "examinations",
  "financial_aid_grants",
  "grades",
  "installment_configurations",
  "instructor_assignments",
  "issued_certificates",
  "learning_instance_academic_periods",
  "learning_instance_courses",
  "learning_instance_participation_structures",
  "learning_instance_targets",
  "messages",
  "notes",
  "operational_groups",
  "password_resets",
  "payment_plans",
  "programme_enrollment_courses",
  "payments",
  "programme_enrollments",
  "progress",
  "projects",
  "promotion_log",
  "promotion_recommendations",
  "promotional_campaigns",
  "refund_policies",
  "retake_attempts",
  "scholarship_grants",
  "sponsor_bulk_batches",
  "unlocks",
];

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);

function countRow(sql) {
  return db.prepare(sql).get().n;
}

console.log(`Database: ${DB_PATH}`);
console.log("--- Current counts ---");
console.log("parent/learner users:", countRow("SELECT COUNT(*) n FROM users WHERE role IN ('parent','learner')"));
console.log("learning_instances:  ", countRow("SELECT COUNT(*) n FROM learning_instances"));
for (const t of TABLES_TO_CLEAR) {
  console.log(`${t}:`.padEnd(22), countRow(`SELECT COUNT(*) n FROM ${t}`));
}

if (!CONFIRM) {
  console.log("\nDry run only — nothing was changed. Re-run with --yes to actually wipe.");
  db.close();
  process.exit(0);
}

// Backup first, always.
const backupPath = `${DB_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(DB_PATH, backupPath);
console.log(`\nBackup written to ${backupPath}`);

// PRAGMA foreign_keys is a no-op while a transaction is open (SQLite only
// honors it outside of BEGIN/SAVEPOINT), and better-sqlite3's db.transaction()
// wrapper already opens one before running the callback — so this MUST be
// set before entering the transaction below, not inside it.
db.pragma("foreign_keys = OFF");

const wipe = db.transaction(() => {
  for (const t of TABLES_TO_CLEAR) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM learning_instances").run();
  db.prepare("DELETE FROM users WHERE role IN ('parent','learner')").run();
  // audit_log.actor_id is nullable and ON DELETE NO ACTION — it's just a
  // historical log, not something to clear, but a row logging something a
  // parent/learner did will now point at a deleted user. Null out only the
  // actor_id on those specific rows so foreign_key_check comes back clean
  // without losing the rest of the log entry (action, entity, timestamp).
  db.prepare("UPDATE audit_log SET actor_id = NULL WHERE actor_id IS NOT NULL AND actor_id NOT IN (SELECT id FROM users)").run();
});

wipe();

// Re-enable and verify — also only valid outside a transaction, which we're
// back to now that wipe() has committed.
db.pragma("foreign_keys = ON");
const problems = db.pragma("foreign_key_check");
if (problems.length) {
  console.error(`foreign_key_check found ${problems.length} problem(s) — restore from the backup above and report this:`);
  console.error(problems.slice(0, 10));
  db.close();
  process.exit(1);
}

db.pragma("wal_checkpoint(TRUNCATE)");
console.log("\nDone. All parent/learner accounts and learning instances (and every table that referenced them) are now empty.");
db.close();
