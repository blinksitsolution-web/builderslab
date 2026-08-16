// server/scripts/fix-audit-log-orphans.js
//
// One-off repair for the state wipe-test-data.js can leave behind:
// audit_log.actor_id (nullable, ON DELETE NO ACTION) can point to a
// parent/learner user that wipe-test-data.js just deleted. This doesn't
// corrupt anything — audit_log is just a historical log — but it fails
// PRAGMA foreign_key_check. This nulls out actor_id on exactly those rows
// (keeping the rest of the log entry: action, entity_type, actor_name,
// actor_role, timestamp, etc.) so the database is fully FK-clean again.
//
// Usage: node scripts/fix-audit-log-orphans.js

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../data/builderslab.db");
const db = new Database(DB_PATH);

db.pragma("foreign_keys = OFF");
const result = db
  .prepare("UPDATE audit_log SET actor_id = NULL WHERE actor_id IS NOT NULL AND actor_id NOT IN (SELECT id FROM users)")
  .run();
db.pragma("foreign_keys = ON");

const problems = db.pragma("foreign_key_check");
console.log(`Nulled out ${result.changes} orphaned audit_log.actor_id reference(s).`);
console.log(problems.length ? `Still ${problems.length} problem(s): ${JSON.stringify(problems)}` : "Database is now fully FK-clean.");
db.close();
