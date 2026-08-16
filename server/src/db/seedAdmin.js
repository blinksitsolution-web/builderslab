require("dotenv").config();
const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const db = require("./db");

const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_PHONE } = process.env;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD in .env before running this script.");
  process.exit(1);
}

const FORCE_RESET = process.argv.includes("--force-reset-password");

const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
if (existing) {
  if (!FORCE_RESET) {
    console.log(
      `An account with ${ADMIN_EMAIL} already exists — nothing to do.\n` +
      "Its password was NOT changed (this script never overwrites an existing account).\n" +
      "If you don't know its current password, re-run as:\n" +
      "  npm run seed:admin -- --force-reset-password\n" +
      "to reset it to the ADMIN_PASSWORD currently in your .env."
    );
    process.exit(0);
  }
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, existing.id);
  console.log(`✅ Password for ${ADMIN_EMAIL} was reset to the ADMIN_PASSWORD in your .env.`);
  process.exit(0);
}

const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
// RBAC Engine (utils/rbac.js effectivePermissions/isSuperAdmin) grants an
// admin account NO permissions at all until it has a role_template_id
// pointing at an active template — without this, the bootstrap admin would
// be created with zero permissions, including no permission to grant
// itself any (Access & Permissions is itself gated by
// accessPermissions.managePermissions), permanently locking a fresh
// install out of its own Admin Portal. The bootstrap admin must always be
// the built-in Super Administrator template.
const superAdminTemplate = db.prepare("SELECT id FROM role_templates WHERE name = 'Super Administrator' AND is_system = 1").get();
if (!superAdminTemplate) {
  console.error("The built-in 'Super Administrator' role template was not found — run `npm run migrate` first.");
  process.exit(1);
}
db.prepare(
  `INSERT INTO users (id, role, name, email, password_hash, phone, status, payment_status, joined_date, role_template_id)
   VALUES (?, 'admin', ?, ?, ?, ?, 'active', 'current', date('now'), ?)`
).run(uuid(), ADMIN_NAME || "Admin", ADMIN_EMAIL, hash, ADMIN_PHONE || "", superAdminTemplate.id);

console.log("✅ Admin account created:", ADMIN_EMAIL);
console.log("   Log in, then change this password and create instructor accounts from Manage Accounts.");
