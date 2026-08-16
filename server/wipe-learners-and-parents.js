// Deletes every learner and parent account (and everything that hangs off
// them) so a fresh set can be re-registered. Admin/instructor accounts,
// Programmes/Classes/Learning Instances, and site settings are untouched.
//
// SAFETY:
//   - Refuses to run without --confirm (prints a dry-run count otherwise).
//   - Wrapped in a single transaction: either everything below commits, or
//     nothing does.
//   - Runs PRAGMA foreign_key_check after committing to prove no dangling
//     references were left behind.
//
// USAGE:
//   node wipe-learners-and-parents.js                # dry run (counts only)
//   node wipe-learners-and-parents.js --confirm       # actually deletes
//
// Run `npm run backup:db` before using --confirm. This does not create a
// backup itself.

const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "builderslab.db");
const CONFIRMED = process.argv.includes("--confirm");

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

function run() {
  const targets = db.prepare("SELECT id, role, name FROM users WHERE role IN ('learner','parent')").all();
  const ids = targets.map((u) => u.id);

  console.log(`Found ${ids.length} account(s) to remove (${targets.filter(u=>u.role==='learner').length} learner(s), ${targets.filter(u=>u.role==='parent').length} parent(s)).`);

  if (!ids.length) {
    console.log("Nothing to do.");
    return;
  }

  if (!CONFIRMED) {
    console.log("Dry run only — pass --confirm to actually delete. No changes made.");
    return;
  }

  const placeholders = ids.map(() => "?").join(",");

  const doDelete = db.transaction(() => {
    // Ordered to satisfy every NO ACTION foreign key referencing users(id)
    // or users(id)-owned rows before the users themselves are removed —
    // everything else (payments' own user_id, enrollments, progress,
    // unlocks, grades, projects, messages, attendance, password_resets,
    // assignment_submissions, examination_attempts, ca_attempts,
    // promotion_log.learner_id, retake_attempts,
    // promotion_recommendations.learner_id, discount/scholarship/
    // financial_aid_grants.user_id) is ON DELETE CASCADE and is handled
    // automatically by step 6 below.

    // 1. Refunds reference both a payment and a programme_enrollment with
    //    NO ACTION — must go first, before either of those.
    const refundsDeleted = db.prepare(
      `DELETE FROM refunds WHERE programme_enrollment_id IN (
         SELECT id FROM programme_enrollments WHERE user_id IN (${placeholders})
       ) OR payment_id IN (
         SELECT id FROM payments WHERE user_id IN (${placeholders})
       )`
    ).run(...ids, ...ids).changes;

    // 2. Payments reference programme_enrollments with NO ACTION (via
    //    programme_enrollment_id) — clear payments before enrollments.
    //    (payments.user_id itself is CASCADE, but that only fires once we
    //    delete the user row in step 6 — deleting explicitly here first
    //    is what lets step 4's programme_enrollments delete succeed.)
    const paymentsDeleted = db.prepare(`DELETE FROM payments WHERE user_id IN (${placeholders})`).run(...ids).changes;

    // 3. Certificates reference learner_id with NO ACTION and NOT NULL —
    //    must be deleted outright (can't be nulled).
    const certsDeleted = db.prepare(`DELETE FROM issued_certificates WHERE learner_id IN (${placeholders})`).run(...ids).changes;

    // 4. programme_enrollments.user_id is NO ACTION — clear explicitly.
    const enrolDeleted = db.prepare(`DELETE FROM programme_enrollments WHERE user_id IN (${placeholders})`).run(...ids).changes;

    // 5. audit_log.actor_id is NO ACTION but nullable, and actor_name/
    //    actor_role are snapshotted at write time specifically so the log
    //    entry survives the actor's account being deleted (see schema
    //    comment) — null the reference rather than deleting the log row.
    const auditCleared = db.prepare(`UPDATE audit_log SET actor_id = NULL WHERE actor_id IN (${placeholders})`).run(...ids).changes;

    // 6. Delete the accounts themselves. Learners first: users.parent_id
    //    (on a learner row) references a parent's users.id with NO
    //    ACTION, so a parent can't be removed while a learner still
    //    points at them. Doing all learners then all parents in two
    //    statements (rather than one combined IN-list delete) guarantees
    //    that ordering regardless of row-processing order within a single
    //    statement.
    const learnersDeleted = db.prepare(`DELETE FROM users WHERE role = 'learner'`).run().changes;
    const parentsDeleted = db.prepare(`DELETE FROM users WHERE role = 'parent'`).run().changes;

    return { refundsDeleted, paymentsDeleted, certsDeleted, enrolDeleted, auditCleared, learnersDeleted, parentsDeleted };
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
