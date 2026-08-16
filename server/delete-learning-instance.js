// Deletes ONE Learning Instance (Programme Run) entirely, including every
// row across the app that references it — safe to use because
// foreign_keys=ON means an unhandled reference would abort the whole
// transaction rather than leave anything half-deleted.
//
// USAGE:
//   node delete-learning-instance.js <instanceId>              # dry run (counts only)
//   node delete-learning-instance.js <instanceId> --confirm     # actually deletes
//
// Run `npm run backup:db` before using --confirm.

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "builderslab.db");
const INSTANCE_ID = process.argv[2];
const CONFIRMED = process.argv.includes("--confirm");

if (!INSTANCE_ID) {
  console.error("Usage: node delete-learning-instance.js <instanceId> [--confirm]");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

// Every table with a NO ACTION foreign key to learning_instances(id) (or,
// for a few, target_learning_instance_id) — everything else references it
// with ON DELETE CASCADE (learning_instance_targets, academic periods,
// participation structures, activated courses, operational_groups,
// installment_configurations, payment_plans, instructor_assignments) and
// is handled automatically once the instance row itself is deleted.
const NO_ACTION_TABLES = [
  ["progress", "learning_instance_id"],
  ["grades", "learning_instance_id"],
  ["projects", "learning_instance_id"],
  ["payments", "learning_instance_id"],
  ["notes", "learning_instance_id"],
  ["attendance", "learning_instance_id"],
  ["course_topics", "learning_instance_id"],
  ["assignment_submissions", "learning_instance_id"],
  ["examinations", "learning_instance_id"],
  ["examination_attempts", "learning_instance_id"],
  ["continuous_assessments", "learning_instance_id"],
  ["ca_attempts", "learning_instance_id"],
  ["issued_certificates", "learning_instance_id"],
  ["programme_enrollments", "learning_instance_id"],
  ["promotional_campaigns", "target_learning_instance_id"],
  ["discount_policies", "target_learning_instance_id"],
  ["scholarship_grants", "learning_instance_id"],
  ["financial_aid_grants", "learning_instance_id"],
  ["corporate_pricing", "learning_instance_id"],
  ["refund_policies", "target_learning_instance_id"],
  ["sponsor_bulk_batches", "learning_instance_id"],
];

function run() {
  const instance = db.prepare("SELECT id, name, status FROM learning_instances WHERE id = ?").get(INSTANCE_ID);
  if (!instance) {
    console.log(`No Learning Instance found with id ${INSTANCE_ID}.`);
    return;
  }
  console.log(`Found: "${instance.name}" (status: ${instance.status})`);

  const counts = {};
  for (const [table, col] of NO_ACTION_TABLES) {
    counts[table] = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`).get(INSTANCE_ID).n;
  }
  const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);
  console.log("Rows that reference this instance elsewhere:", nonEmpty.length ? Object.fromEntries(nonEmpty) : "(none)");

  if (!CONFIRMED) {
    console.log("Dry run only — pass --confirm to actually delete. No changes made.");
    return;
  }

  const doDelete = db.transaction(() => {
    const deleted = {};
    for (const [table, col] of NO_ACTION_TABLES) {
      deleted[table] = db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(INSTANCE_ID).changes;
    }
    // Everything else (targets, academic periods, participation
    // structures, activated courses, operational groups, installment
    // configs, payment plans, instructor assignments) cascades
    // automatically from this single delete.
    deleted.learning_instances = db.prepare("DELETE FROM learning_instances WHERE id = ?").run(INSTANCE_ID).changes;
    return deleted;
  });

  const result = doDelete();
  console.log("Deleted:", result);

  const violations = db.pragma("foreign_key_check");
  if (violations.length) {
    console.error("FOREIGN KEY VIOLATIONS REMAIN — this should not happen:", violations);
    process.exitCode = 1;
  } else {
    console.log("✅ foreign_key_check clean — no dangling references left.");
  }
}

run();
db.close();
