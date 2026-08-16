require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("./db");

/**
 * EMERGENCY ACCESS RECOVERY — resets the password for the well-known
 * seeded accounts (the ones from README.md / LOCAL_SETUP.md) to fixed
 * values below, REGARDLESS of what their current password is. Only
 * touches an account if it already exists (never creates one).
 *
 * Use this once, right now, to get back into the app after "Incorrect
 * email or password" on accounts you believe were seeded. After logging
 * in, change the password from the profile menu (or Admin → Manage
 * Accounts) to something private, then delete/stop using this script.
 *
 * Usage:
 *   node src/db/resetKnownPasswords.js
 *
 * From the server/ folder, with the server stopped or running (either is
 * fine — better-sqlite3 writes are immediate).
 */

const RESETS = [
  { email: "admin@dalijaytechhub.online", password: "admin123", role: "admin" },
  { email: "instructor@dalijaytechhub.online", password: "teach123", role: "instructor" },
  { email: "parent@demo.com", password: "demo123", role: "parent" },
  { email: "learner@demo.com", password: "demo123", role: "learner" },
];

console.log("Resetting known account passwords…\n");

const results = RESETS.map(({ email, password, role }) => {
  const user = db.prepare("SELECT id, role, status FROM users WHERE email = ?").get(email);
  if (!user) {
    console.log(`  ✗ ${email} — no account with this email exists, skipped.`);
    return { email, role, password: "—", note: "not found" };
  }
  const hash = bcrypt.hashSync(password, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
  console.log(`  ✓ ${email} — password reset to '${password}'.`);
  return { email, role: user.role, password, note: "reset" };
});

console.log("\nDone. Sign in with the credentials below, then change your password:\n");
console.table(results.filter((r) => r.note === "reset"));
