const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireSuperAdmin } = require("../middleware/auth");
const { PERMISSION_GROUPS, ALL_PERMISSIONS_SET } = require("../utils/permissions");
const { listRoleTemplates, getRoleTemplate, countActiveSuperAdmins, isSuperAdmin } = require("../utils/rbac");
const { recordAuditLog } = require("../utils/auditLog");

const router = express.Router();

// Only a Super Administrator may view/manage Role Templates or the
// permission catalog (spec: "Manage Role Templates" is Super-Admin-only).
router.use(requireAuth, requireSuperAdmin);

router.get("/permission-catalog", (req, res) => {
  res.json({ groups: PERMISSION_GROUPS });
});

router.get("/", (req, res) => {
  res.json({ templates: listRoleTemplates() });
});

router.get("/:id", (req, res) => {
  const template = getRoleTemplate(req.params.id);
  if (!template) return res.status(404).json({ error: "Role Template not found." });
  res.json({ template });
});

function sanitizePermissions(input) {
  if (!Array.isArray(input)) return [];
  return input.filter((p) => ALL_PERMISSIONS_SET.has(p));
}

router.post("/", (req, res) => {
  const { name, description, permissions } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required." });
  if (db.prepare("SELECT id FROM role_templates WHERE name = ?").get(name)) {
    return res.status(409).json({ error: "A Role Template with this name already exists." });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO role_templates (id, name, description, is_system, is_active, permissions, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, datetime('now'), datetime('now'))`
  ).run(id, String(name).trim(), description || "", JSON.stringify(sanitizePermissions(permissions)));
  recordAuditLog({ req, action: "create", entityType: "role_templates", entityId: id, entityLabel: String(name).trim() });
  res.json({ ok: true, template: getRoleTemplate(id) });
});

router.post("/:id/duplicate", (req, res) => {
  const source = getRoleTemplate(req.params.id);
  if (!source) return res.status(404).json({ error: "Role Template not found." });
  const baseName = `${source.name} (Copy)`;
  let name = baseName;
  let n = 2;
  while (db.prepare("SELECT id FROM role_templates WHERE name = ?").get(name)) {
    name = `${baseName} ${n++}`;
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO role_templates (id, name, description, is_system, is_active, permissions, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, datetime('now'), datetime('now'))`
  ).run(id, name, source.description, JSON.stringify(source.permissions));
  recordAuditLog({ req, action: "create", entityType: "role_templates", entityId: id, entityLabel: name, details: { duplicatedFrom: source.name } });
  res.json({ ok: true, template: getRoleTemplate(id) });
});

router.patch("/:id", (req, res) => {
  const existing = getRoleTemplate(req.params.id);
  if (!existing) return res.status(404).json({ error: "Role Template not found." });
  const { description, permissions, isActive } = req.body;

  // The Super Administrator template must always retain full access —
  // guards the spec's "must never ... have all permissions removed" rule
  // even when a Super Administrator is the one editing it.
  const nextPermissions =
    existing.name === "Super Administrator"
      ? existing.permissions
      : permissions !== undefined
      ? sanitizePermissions(permissions)
      : existing.permissions;

  let nextActive = isActive !== undefined ? !!isActive : existing.isActive;
  if (existing.name === "Super Administrator" && !nextActive) {
    return res.status(409).json({ error: "The Super Administrator template can't be disabled." });
  }

  db.prepare("UPDATE role_templates SET description = ?, permissions = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?").run(
    description !== undefined ? description : existing.description,
    JSON.stringify(nextPermissions),
    nextActive ? 1 : 0,
    req.params.id
  );
  recordAuditLog({
    req,
    action: "update",
    entityType: "role_templates",
    entityId: req.params.id,
    entityLabel: existing.name,
    before: { description: existing.description, permissions: existing.permissions, isActive: existing.isActive },
    after: { description: description !== undefined ? description : existing.description, permissions: nextPermissions, isActive: nextActive },
  });
  res.json({ ok: true, template: getRoleTemplate(req.params.id) });
});

router.patch("/:id/disable", (req, res) => {
  const existing = getRoleTemplate(req.params.id);
  if (!existing) return res.status(404).json({ error: "Role Template not found." });
  if (existing.name === "Super Administrator") {
    return res.status(409).json({ error: "The Super Administrator template can't be disabled." });
  }
  db.prepare("UPDATE role_templates SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  recordAuditLog({ req, action: "status_change", entityType: "role_templates", entityId: req.params.id, entityLabel: existing.name, before: { isActive: true }, after: { isActive: false } });
  res.json({ ok: true });
});

router.patch("/:id/enable", (req, res) => {
  const existing = getRoleTemplate(req.params.id);
  if (!existing) return res.status(404).json({ error: "Role Template not found." });
  db.prepare("UPDATE role_templates SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  recordAuditLog({ req, action: "status_change", entityType: "role_templates", entityId: req.params.id, entityLabel: existing.name, before: { isActive: false }, after: { isActive: true } });
  res.json({ ok: true });
});

router.delete("/:id", (req, res) => {
  const existing = getRoleTemplate(req.params.id);
  if (!existing) return res.status(404).json({ error: "Role Template not found." });
  if (existing.isSystem) return res.status(409).json({ error: "Built-in Role Templates can't be deleted." });

  const inUse = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role_template_id = ?").get(req.params.id).n;
  if (inUse > 0) return res.status(409).json({ error: `${inUse} administrator(s) are still assigned this template — reassign them first.` });

  db.prepare("DELETE FROM role_templates WHERE id = ?").run(req.params.id);
  recordAuditLog({ req, action: "delete", entityType: "role_templates", entityId: req.params.id, entityLabel: existing.name });
  res.json({ ok: true });
});

module.exports = router;
