require("dotenv").config();
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const db = require("./db");

/**
 * Creates one demo account per role so you can click through every
 * dashboard locally without registering for real. NOT meant for production —
 * run this against your local/dev database only (never in production, since
 * the passwords below are public in this file).
 *
 * Usage:  npm run seed:demo
 *         npm run seed:demo -- --force-reset-passwords
 *
 * IMPORTANT: by default, if an account with one of these emails already
 * exists (e.g. you ran this before, or later changed the password from the
 * app), this script leaves it completely alone — it will NOT overwrite an
 * existing password. Pass --force-reset-passwords to force every one of
 * these four accounts back to the password shown below, even if it already
 * existed with a different one.
 */
const FORCE_RESET = process.argv.includes("--force-reset-passwords");

const DEMO = {
  admin: { email: "admin@dalijaytechhub.online", password: "admin123", name: "Lawson Dalikey-Dotsey", phone: "0560640517" },
  instructor: { email: "instructor@dalijaytechhub.online", password: "teach123", name: "Coach Nhyira Sackitey", phone: "0542947685", specialty: "IOT-02, PRG-01" },
  parent: { email: "parent@demo.com", password: "demo123", name: "Mrs. Abena Dalike", phone: "0501112222" },
  learner: { email: "learner@demo.com", password: "demo123", name: "Elikem Dalike", phone: "0501112222", campus: "Woodbridge International School" },
};

// Tracks which DEMO accounts were actually (re)created with the password
// printed in the final table below, vs already existed with some other
// (unknown-to-this-script) password — see the FORCE_RESET note above the
// summary table. Without this, an admin/instructor/parent/learner account
// created earlier with a different password would silently be left alone
// here, but the closing console.table would still claim "admin123" etc.
// as if that were guaranteed to be the live password — which is exactly
// the bug that caused login failures after this script was re-run on an
// already-seeded database.
const seedResults = [];

function upsertUser({ id, role, name, email, password, phone, phoneNetwork, campus, parentId, specialty, status, paymentStatus }) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    if (FORCE_RESET) {
      const hash = bcrypt.hashSync(password, 12);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, existing.id);
      console.log(`  ↻ ${role} ${email} already existed — password RESET to '${password}' (--force-reset-passwords).`);
      seedResults.push({ role, email, password, note: "reset" });
    } else {
      console.log(`  – ${role} ${email} already exists — left untouched (its real password may differ from the one below; re-run with --force-reset-passwords to reset it).`);
      seedResults.push({ role, email, password: "(unchanged — see note above)", note: "skipped" });
    }
    return existing.id;
  }
  // RBAC integrity fix: an admin account has NO permissions at all
  // (utils/rbac.js effectivePermissions) until it carries a
  // role_template_id pointing at an active template — seedAdmin.js already
  // documents and handles this for the production bootstrap admin, but this
  // demo seeder was inserting its demo admin with role_template_id left
  // NULL, so every requirePermission()-gated Admin Portal screen (Learning
  // Instances, Pricing, Promotion, Access & Permissions, Site Settings,
  // etc.) 403'd for it. Only the admin role has a template concept — other
  // roles' permissioning is unaffected and untouched here.
  const roleTemplateId =
    role === "admin"
      ? (db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator' AND is_system = 1").get() || {}).id || null
      : null;
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(
    `INSERT INTO users (id, role, name, email, password_hash, phone, phone_network, campus, parent_id, specialty, status, payment_status, joined_date, role_template_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'), ?)`
  ).run(id, role, name, email, hash, phone || null, phoneNetwork || null, campus || null, parentId || null, specialty || null, status || "active", paymentStatus || "current", roleTemplateId);
  console.log(`  ✓ created ${role}: ${email} / ${password}`);
  seedResults.push({ role, email, password, note: "created" });
  return id;
}

console.log("Seeding demo accounts…");

const adminId = upsertUser({ id: uuid(), role: "admin", ...DEMO.admin });
const instructorId = upsertUser({ id: uuid(), role: "instructor", ...DEMO.instructor });
const parentId = upsertUser({ id: uuid(), role: "parent", ...DEMO.parent });
const learnerId = upsertUser({
  id: uuid(),
  role: "learner",
  ...DEMO.learner,
  parentId,
  status: "active",
  paymentStatus: "current",
});

// Enrol the demo learner in two modules (only if not already enrolled)
["IOT-02", "PRG-01"].forEach((mid) => {
  const already = db.prepare("SELECT 1 FROM enrollments WHERE user_id=? AND course_id=?").get(learnerId, mid);
  if (!already) db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)").run(learnerId, mid);
});

// Sample progress: finished IOT-02 Lesson 1 with a perfect quiz score, unlocking Lesson 2
if (!db.prepare("SELECT 1 FROM progress WHERE user_id=? AND course_id='IOT-02' AND lesson_id='L1'").get(learnerId)) {
  db.prepare(
    `INSERT INTO progress (user_id, course_id, lesson_id, watched_seconds, quiz_score) VALUES (?, 'IOT-02', 'L1', 300, 100)`
  ).run(learnerId);
  db.prepare(
    `INSERT INTO unlocks (user_id, course_id, unlocked_lesson_id) VALUES (?, 'IOT-02', 'L2')`
  ).run(learnerId);
}

// Sample midterm grade
if (!db.prepare("SELECT 1 FROM grades WHERE user_id=? AND course_id='IOT-02'").get(learnerId)) {
  db.prepare(`INSERT INTO grades (user_id, course_id, midterm) VALUES (?, 'IOT-02', 78)`).run(learnerId);
}

// Sample graded project
if (!db.prepare("SELECT 1 FROM projects WHERE user_id=? AND title='Automated Plant Watering Alarm'").get(learnerId)) {
  db.prepare(
    `INSERT INTO projects (id, user_id, course_id, title, description, media_type, grade, feedback, date)
     VALUES (?, ?, 'IOT-02', 'Automated Plant Watering Alarm', 'A moisture sensor that lights an LED alarm when soil gets too dry.', 'image', 'A', 'Excellent wiring! Add a bigger LED next time so the alert is visible from further away.', datetime('now'))`
  ).run(uuid(), learnerId);
}

// Sample payment history
["registration", "monthly"].forEach((type) => {
  const amount = type === "registration" ? Number(process.env.REGISTRATION_FEE_GHS) || 350 : Number(process.env.MONTHLY_FEE_GHS) || 180;
  const ref = `DEMO-${type}-${learnerId.slice(0, 8)}`;
  if (!db.prepare("SELECT 1 FROM payments WHERE paystack_ref=?").get(ref)) {
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, method, momo_number, status, paystack_ref, date)
       VALUES (?, ?, ?, ?, 'MTN MoMo', '0501112222', 'successful', ?, datetime('now'))`
    ).run(uuid(), learnerId, amount, type, ref);
  }
});

// Sample messages between admin/instructor and the parent
function seedMessage(fromId, fromName, toId, subject, body) {
  const exists = db.prepare("SELECT 1 FROM messages WHERE from_id=? AND to_id=? AND subject=?").get(fromId, toId, subject);
  if (!exists) {
    db.prepare(
      `INSERT INTO messages (id, from_id, from_name, to_id, subject, body, date) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(uuid(), fromId, fromName, toId, subject, body);
  }
}
seedMessage(adminId, DEMO.admin.name, parentId, "Reminder: fees due", "Hi Mrs. Dalike, a friendly reminder that Elikem's monthly fee is due on the 5th. Pay anytime from your Payments tab.");
seedMessage(instructorId, DEMO.instructor.name, parentId, "Great progress this week", "Elikem finished the Arduino sensor lesson with a perfect quiz score. Encourage him to keep it up before Lesson 2!");

// Sample instructor note/assignment
if (!db.prepare("SELECT 1 FROM notes WHERE title='Assignment: Sketch your sensor idea'").get()) {
  db.prepare(
    `INSERT INTO notes (id, course_id, title, body, posted_by, target, date)
     VALUES (?, 'IOT-02', 'Assignment: Sketch your sensor idea', 'Before next class, sketch one everyday object you could improve with a sensor (drawing or photo is fine).', ?, 'all', datetime('now'))`
  ).run(uuid(), DEMO.instructor.name);
}

console.log("\n✅ Demo accounts:\n");
console.table(seedResults);
if (seedResults.some((r) => r.note === "skipped")) {
  console.log(
    "⚠️  One or more accounts above already existed and were left untouched — the password shown is NOT guaranteed to be their real one.\n" +
    "   Re-run as `npm run seed:demo -- --force-reset-passwords` to force them back to the passwords above.\n"
  );
}
console.log("Sign in at http://localhost:4000/login.html\n");
