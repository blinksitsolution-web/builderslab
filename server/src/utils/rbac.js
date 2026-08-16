const { v4: uuid } = require("uuid");
const db = require("../db/db");
const {
  ALL_PERMISSIONS,
  ALL_PERMISSIONS_SET,
  SUPER_ADMIN_ONLY_PERMISSIONS,
  DEFAULT_TEMPLATE_PERMISSIONS,
} = require("./permissions");

const SUPER_ADMIN_ONLY_SET = new Set(SUPER_ADMIN_ONLY_PERMISSIONS);

/* ---------------------------------------------------------------------
   Role Templates — read helpers
   --------------------------------------------------------------------- */
function rowToTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    isSystem: !!row.is_system,
    isActive: !!row.is_active,
    permissions: JSON.parse(row.permissions || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listRoleTemplates() {
  return db.prepare("SELECT * FROM role_templates ORDER BY is_system DESC, name ASC").all().map(rowToTemplate);
}

function getRoleTemplate(id) {
  if (!id) return null;
  return rowToTemplate(db.prepare("SELECT * FROM role_templates WHERE id = ?").get(id));
}

function getRoleTemplateByName(name) {
  return rowToTemplate(db.prepare("SELECT * FROM role_templates WHERE name = ?").get(name));
}

/* ---------------------------------------------------------------------
   Effective permissions for a user
   --------------------------------------------------------------------- */
// Non-admin roles (learner/parent/instructor) are handled entirely by the
// app's existing role-scoped routes — the RBAC Engine governs the Admin
// Portal, i.e. every account whose users.role = 'admin'.
function effectivePermissions(user) {
  if (!user || user.role !== "admin") return new Set();

  // Option 2 (Custom Permission Set) fully overrides the template for this
  // administrator only, per spec — it does not merge with the template.
  if (user.custom_permissions != null) {
    try {
      const custom = JSON.parse(user.custom_permissions);
      if (Array.isArray(custom)) return new Set(custom.filter((p) => ALL_PERMISSIONS_SET.has(p)));
    } catch (e) {
      /* fall through to template */
    }
  }

  const template = getRoleTemplate(user.role_template_id);
  if (!template || !template.isActive) return new Set();
  return new Set(template.permissions.filter((p) => ALL_PERMISSIONS_SET.has(p)));
}

// A user is the Super Administrator role for protection purposes if their
// assigned template is the built-in "Super Administrator" system template —
// this is intentionally independent of custom_permissions, since Option 2
// (custom sets) is how a Super Administrator is *demoted* in practice, and
// demotion must go through the guarded routes, not silent permission edits.
function isSuperAdmin(user) {
  if (!user || user.role !== "admin") return false;
  if (user.custom_permissions != null) return false; // custom set = no longer full Super Admin
  const template = getRoleTemplate(user.role_template_id);
  return !!template && template.name === "Super Administrator" && template.isActive;
}

function hasPermission(user, permission) {
  if (!user) return false;
  // Hard gate: these permissions are only ever real for a Super Administrator,
  // no matter what a template or custom set claims to grant.
  if (SUPER_ADMIN_ONLY_SET.has(permission)) return isSuperAdmin(user);
  return effectivePermissions(user).has(permission);
}

function hasAnyPermission(user, permissions) {
  return permissions.some((p) => hasPermission(user, p));
}

/* ---------------------------------------------------------------------
   Super Administrator protection
   --------------------------------------------------------------------- */
function countActiveSuperAdmins(excludeUserId) {
  const admins = db.prepare("SELECT * FROM users WHERE role = 'admin' AND status != 'suspended'").all();
  return admins.filter((u) => u.id !== excludeUserId && isSuperAdmin(u)).length;
}

// Call before any action that would delete/disable/demote/strip-permissions-
// from a Super Administrator. Throws a { status, message } object the route
// should catch and respond with (kept as a plain throw so callers can't
// forget to check a boolean return value).
function assertSuperAdminActionAllowed(targetUser) {
  if (!isSuperAdmin(targetUser)) return; // not a Super Admin — no special protection needed
  if (countActiveSuperAdmins(targetUser.id) === 0) {
    const err = new Error("This is the last active Super Administrator — the system must always have at least one.");
    err.status = 409;
    throw err;
  }
}

/* ---------------------------------------------------------------------
   Scope restrictions (who an admin's queries are limited to)
   --------------------------------------------------------------------- */
// Campus Administrators: only their assigned campus. Returns null if the
// user isn't scope-restricted (e.g. Super Administrator sees everything).
function campusScopeFor(user) {
  if (!user || user.role !== "admin") return null;
  const template = getRoleTemplate(user.role_template_id);
  if (template && template.name === "Campus Administrator") return user.campus || null;
  return null;
}

// Corporate Coordinators: only their assigned Corporate Client.
function corporateClientScopeFor(user) {
  if (!user || user.role !== "admin") return null;
  const template = getRoleTemplate(user.role_template_id);
  if (template && template.name === "Corporate Coordinator") return user.corporate_client_id || null;
  return null;
}

// Single source of truth for "may this admin act on / view this target
// account" — used by every per-record route (GET/PATCH /:userId/*, /promote,
// /lookup, /instructors-for) so scoping is enforced identically everywhere,
// per the Single Ownership Principle (Section 2.1): one function decides
// scope membership, not a scattered per-route WHERE clause each with its own
// (potentially inconsistent) idea of what "in scope" means.
//
// targetUser may be a full user row or just { campus, corporate_client_id }.
// Returns true when the acting admin has no scope restriction (e.g. Super
// Administrator, or any non-Campus/Corporate template), and false only when
// the admin IS scope-restricted and the target falls outside that scope.
function isTargetInAdminScope(actingUser, targetUser) {
  if (!actingUser || actingUser.role !== "admin") return false;
  if (!targetUser) return false;

  const campusScope = campusScopeFor(actingUser);
  if (campusScope != null) {
    return !!targetUser.campus && targetUser.campus === campusScope;
  }

  const corporateScope = corporateClientScopeFor(actingUser);
  if (corporateScope != null) {
    return !!targetUser.corporate_client_id && targetUser.corporate_client_id === corporateScope;
  }

  // Not scope-restricted (Super Administrator or any other template without
  // a scoping rule) — full access.
  return true;
}

/* ---------------------------------------------------------------------
   Migration bootstrap — called once from db/migrate.js. Safe to re-run:
   only inserts templates that don't already exist by name (never clobbers
   a Super Administrator's later edits), and only touches admin accounts
   that don't yet have a role_template_id.
   --------------------------------------------------------------------- */
function ensureDefaultRoleTemplatesAndSuperAdmin() {
  const insert = db.prepare(
    `INSERT INTO role_templates (id, name, description, is_system, is_active, permissions, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1, ?, datetime('now'), datetime('now'))`
  );
  const descriptions = {
    "Super Administrator": "Full, unrestricted access to every module — the only role that can manage Role Templates, Access & Permissions, AI Providers, API Keys and global Site Settings.",
    Administrator: "Broad operational access across the LMS, excluding the Super-Administrator-only areas (Role Templates, Access & Permissions, AI Providers, API Keys, Site Settings edit).",
    "Academic Administrator": "Manages Learning Offerings, curriculum, assessments, examinations and the academic calendar.",
    "Finance Administrator": "Manages payments, fee records and financial reporting.",
    "Certificate Administrator": "Manages certificate issuance, certificate templates and transcripts.",
    "Campus Administrator": "Manages learners, parents, instructors, attendance and payments — scoped to their one assigned campus.",
    "Corporate Coordinator": "Read-only visibility into their one Corporate Client's participants, attendance, results, certificates, transcripts and payment status.",
  };
  Object.entries(DEFAULT_TEMPLATE_PERMISSIONS).forEach(([name, perms]) => {
    const existing = getRoleTemplateByName(name);
    if (!existing) insert.run(uuid(), name, descriptions[name] || "", JSON.stringify(perms));
  });

  // The Super Administrator template must always have every permission
  // that currently exists in the codebase — routes/roleTemplates.js
  // deliberately refuses to let anyone (even a Super Administrator) edit
  // this template's permissions away, so it can only ever grow through
  // this self-heal step. Without it, a brand-new permission group added
  // here later (e.g. this change's `learningInstances.*`) would silently
  // 403 for every *existing* installation's Super Administrator — a
  // fresh install picks it up automatically via the insert above, but an
  // already-migrated database's row never gets touched otherwise, since
  // JSON columns don't grow new keys on their own. Safe/idempotent: only
  // ever adds permissions that are missing, never removes any, and is a
  // no-op once the template is already fully in sync.
  const superAdminForSync = getRoleTemplateByName("Super Administrator");
  if (superAdminForSync) {
    const missing = ALL_PERMISSIONS.filter((p) => !superAdminForSync.permissions.includes(p));
    if (missing.length) {
      db.prepare("UPDATE role_templates SET permissions = ?, updated_at = datetime('now') WHERE id = ?").run(
        JSON.stringify(ALL_PERMISSIONS),
        superAdminForSync.id
      );
      console.log(`✅ RBAC Engine: synced ${missing.length} new permission(s) onto the Super Administrator template (${missing.join(", ")}).`);
    }
  }

  // One-time correction for an already-provisioned "Campus Administrator"
  // template: earlier versions of DEFAULT_TEMPLATE_PERMISSIONS shipped
  // instructors.create/instructors.edit on this template by default, which
  // violates the intended least-privilege scope (a Campus Administrator
  // should see instructors, not create/edit them, unless a Super
  // Administrator deliberately grants it via a Custom Permission Set).
  // This only strips those two keys, and ONLY when doing so is safe: the
  // template's permission set — with those two keys removed — must match
  // today's default exactly. If a Super Administrator has since made ANY
  // other deliberate edit to this template (added/removed something else),
  // the sets won't match and this step is skipped entirely, so a real
  // customization is never silently overwritten.
  const campusAdminTemplate = getRoleTemplateByName("Campus Administrator");
  if (campusAdminTemplate) {
    const hadLegacyInstructorGrants =
      campusAdminTemplate.permissions.includes("instructors.create") ||
      campusAdminTemplate.permissions.includes("instructors.edit");
    if (hadLegacyInstructorGrants) {
      const withoutLegacyGrants = campusAdminTemplate.permissions.filter(
        (p) => p !== "instructors.create" && p !== "instructors.edit"
      );
      const currentDefault = (DEFAULT_TEMPLATE_PERMISSIONS["Campus Administrator"] || []).slice().sort();
      const candidate = withoutLegacyGrants.slice().sort();
      const untouchedSinceInstall =
        candidate.length === currentDefault.length && candidate.every((p, i) => p === currentDefault[i]);
      if (untouchedSinceInstall) {
        db.prepare("UPDATE role_templates SET permissions = ?, updated_at = datetime('now') WHERE id = ?").run(
          JSON.stringify(withoutLegacyGrants),
          campusAdminTemplate.id
        );
        console.log("✅ RBAC Engine: removed instructors.create/instructors.edit from the default Campus Administrator template (least-privilege correction).");
      }
    }
  }

  // Migrate the pre-RBAC demo administrator(s) — any admin account created
  // before this engine existed has role_template_id = NULL. Per spec, the
  // account(s) already relying on implicit full admin access become Super
  // Administrators so the migration can never lock anyone out; every admin
  // created *after* this point must be explicitly assigned a template or a
  // Custom Permission Set (enforced in routes/users.js), so this is a
  // one-time backward-compatibility step, not an ongoing default.
  const superAdminTemplate = getRoleTemplateByName("Super Administrator");
  if (!superAdminTemplate) return;
  const unmigrated = db.prepare("SELECT id FROM users WHERE role = 'admin' AND role_template_id IS NULL").all();
  if (unmigrated.length) {
    const update = db.prepare("UPDATE users SET role_template_id = ?, custom_permissions = NULL WHERE id = ?");
    unmigrated.forEach((u) => update.run(superAdminTemplate.id, u.id));
    console.log(`✅ RBAC Engine: migrated ${unmigrated.length} pre-existing admin account(s) to Super Administrator.`);
  }
}

module.exports = {
  listRoleTemplates,
  getRoleTemplate,
  getRoleTemplateByName,
  effectivePermissions,
  isSuperAdmin,
  hasPermission,
  hasAnyPermission,
  countActiveSuperAdmins,
  assertSuperAdminActionAllowed,
  campusScopeFor,
  corporateClientScopeFor,
  isTargetInAdminScope,
  ensureDefaultRoleTemplatesAndSuperAdmin,
  ALL_PERMISSIONS,
};
