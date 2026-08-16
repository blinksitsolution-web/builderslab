// Full "start testing over" reset for the seeded demo database.
//
// Wipes, in one transaction:
//   1. Every course video / material (notes of every kind — note,
//      assignment, video_lesson — plus monthly course_topics posts, plus
//      their derived AI quiz cache), and the uploaded files they point to
//      on disk.
//   2. Every parent and learner account (same logic as, and replaces the
//      standalone, wipe-learners-and-parents.js).
//   3. Every Learning Instance (Programme Run), same logic as
//      delete-learning-instance.js but applied to all instances at once
//      instead of a single id.
//
// Left untouched: admin/instructor accounts, Programmes/Courses/Classes,
// examinations (question banks), site settings, and anything else not
// listed above.
//
// SAFETY:
//   - Refuses to run without --confirm (prints a dry-run count otherwise).
//   - Wrapped in a single transaction: either everything below commits, or
//     nothing does.
//   - Runs PRAGMA foreign_key_check after committing to prove no dangling
//     references were left behind.
//   - Uploaded files are only deleted from disk after the transaction
//     commits successfully.
//
// USAGE:
//   node reset-demo-data.js              # dry run (counts only)
//   node reset-demo-data.js --confirm    # actually deletes
//
// Run `npm run backup` before using --confirm. This does not create a
// backup itself.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "builderslab.db");
const UPLOADS_ROOT = path.join(__dirname, "uploads");
const CONFIRMED = process.argv.includes("--confirm");

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

// Every table with a NO ACTION foreign key to learning_instances(id) (or,
// for a few, target_learning_instance_id) — everything else references it
// with ON DELETE CASCADE (learning_instance_targets, academic periods,
// participation structures, learning_instance_courses, operational_groups,
// installment_configurations, payment_plans, instructor_assignments) and
// is handled automatically once the instance rows themselves are deleted.
// (notes/course_topics also carry a learning_instance_id column, but those
// tables are wiped in full below regardless of which instance they point
// at, so they don't need to be listed here too.)
const LEARNING_INSTANCE_NO_ACTION_TABLES = [
  ["progress", "learning_instance_id"],
  ["grades", "learning_instance_id"],
  ["projects", "learning_instance_id"],
  ["payments", "learning_instance_id"],
  ["attendance", "learning_instance_id"],
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

function toUploadFsPath(filePath) {
  // Stored as e.g. "/uploads/notes/xyz.txt" — map onto the server's own
  // uploads/ dir and refuse to touch anything outside it.
  if (!filePath) return null;
  const rel = filePath.replace(/^\/?uploads\//, "");
  const resolved = path.resolve(UPLOADS_ROOT, rel);
  if (!resolved.startsWith(UPLOADS_ROOT + path.sep)) return null;
  return resolved;
}

function run() {
  const noteRows = db.prepare("SELECT id, kind, file_path FROM notes").all();
  const topicRows = db.prepare("SELECT id, file_path FROM course_topics").all();
  const filesToDelete = [...noteRows, ...topicRows]
    .map((r) => toUploadFsPath(r.file_path))
    .filter(Boolean);

  const parentsAndLearners = db.prepare("SELECT id, role FROM users WHERE role IN ('learner','parent')").all();
  const userIds = parentsAndLearners.map((u) => u.id);

  const instances = db.prepare("SELECT id, name, status FROM learning_instances").all();
  const instanceIds = instances.map((i) => i.id);

  console.log(`Course materials/videos: ${noteRows.length} note(s), ${topicRows.length} course topic post(s), ${filesToDelete.length} uploaded file(s) on disk.`);
  console.log(`Accounts: ${userIds.length} to remove (${parentsAndLearners.filter(u=>u.role==='learner').length} learner(s), ${parentsAndLearners.filter(u=>u.role==='parent').length} parent(s)).`);
  console.log(`Learning Instances: ${instanceIds.length} to remove.`);

  if (!CONFIRMED) {
    console.log("Dry run only — pass --confirm to actually delete. No changes made.");
    return;
  }

  const doDelete = db.transaction(() => {
    const deleted = {};

    // --- 1. Course videos & materials -------------------------------
    // note_id references (assignment_submissions, continuous_assessments,
    // and, transitively, ca_questions/ca_attempts) are ON DELETE CASCADE,
    // so deleting notes takes them with it.
    deleted.notes = db.prepare("DELETE FROM notes").run().changes;
    deleted.course_topics = db.prepare("DELETE FROM course_topics").run().changes;
    deleted.ai_quiz_cache = db.prepare("DELETE FROM ai_quiz_cache").run().changes;

    // --- 2. Parent & learner accounts -------------------------------
    if (userIds.length) {
      const placeholders = userIds.map(() => "?").join(",");

      // Refunds reference both a payment and a programme_enrollment with
      // NO ACTION — must go first, before either of those.
      deleted.refunds = db.prepare(
        `DELETE FROM refunds WHERE programme_enrollment_id IN (
           SELECT id FROM programme_enrollments WHERE user_id IN (${placeholders})
         ) OR payment_id IN (
           SELECT id FROM payments WHERE user_id IN (${placeholders})
         )`
      ).run(...userIds, ...userIds).changes;

      // Payments reference programme_enrollments with NO ACTION — clear
      // payments before enrollments (payments.user_id itself is CASCADE,
      // but that only fires once the user row is deleted below).
      deleted.payments = db.prepare(`DELETE FROM payments WHERE user_id IN (${placeholders})`).run(...userIds).changes;

      // Certificates reference learner_id with NO ACTION and NOT NULL.
      deleted.issued_certificates = db.prepare(`DELETE FROM issued_certificates WHERE learner_id IN (${placeholders})`).run(...userIds).changes;

      // programme_enrollments.user_id is NO ACTION — clear explicitly.
      deleted.programme_enrollments = db.prepare(`DELETE FROM programme_enrollments WHERE user_id IN (${placeholders})`).run(...userIds).changes;

      // audit_log.actor_id is NO ACTION but nullable, and actor_name/
      // actor_role are snapshotted at write time specifically so the log
      // entry survives the actor's account being deleted — null the
      // reference rather than deleting the log row.
      deleted.audit_log_cleared = db.prepare(`UPDATE audit_log SET actor_id = NULL WHERE actor_id IN (${placeholders})`).run(...userIds).changes;

      // Learners first: users.parent_id (on a learner row) references a
      // parent's users.id with NO ACTION, so a parent can't be removed
      // while a learner still points at them.
      deleted.learners = db.prepare(`DELETE FROM users WHERE role = 'learner'`).run().changes;
      deleted.parents = db.prepare(`DELETE FROM users WHERE role = 'parent'`).run().changes;
    }

    // --- 3. Learning Instances ---------------------------------------
    if (instanceIds.length) {
      for (const [table, col] of LEARNING_INSTANCE_NO_ACTION_TABLES) {
        const n = db.prepare(`DELETE FROM ${table} WHERE ${col} IS NOT NULL`).run().changes;
        if (n) deleted[table] = (deleted[table] || 0) + n;
      }
      deleted.learning_instances = db.prepare("DELETE FROM learning_instances").run().changes;
    }

    return deleted;
  });

  const result = doDelete();
  console.log("Deleted:", result);

  const violations = db.pragma("foreign_key_check");
  if (violations.length) {
    console.error("FOREIGN KEY VIOLATIONS REMAIN — this should not happen:", violations);
    process.exitCode = 1;
    return;
  }
  console.log("✅ foreign_key_check clean — no dangling references left.");

  // Only touch disk once the DB transaction is safely committed.
  let filesDeleted = 0;
  for (const f of filesToDelete) {
    try {
      fs.unlinkSync(f);
      filesDeleted++;
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`Could not delete ${f}:`, err.message);
    }
  }
  console.log(`Removed ${filesDeleted}/${filesToDelete.length} uploaded material file(s) from disk.`);
}

run();
db.close();
