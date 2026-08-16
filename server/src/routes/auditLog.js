// ============================================================
// Audit Trail — read API. Super-Administrator-only (auditLog.view is
// hard-gated behind isSuperAdmin() via SUPER_ADMIN_ONLY_PERMISSIONS, see
// utils/permissions.js), mirroring roleTemplates.js's own
// requireSuperAdmin-only surface. See db/schema.sql's audit_log table and
// utils/auditLog.js / middleware/auditTrail.js for how rows get written —
// this file only ever reads.
// ============================================================
const express = require("express");
const db = require("../db/db");
const { requireAuth, requireSuperAdmin } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth, requireSuperAdmin);

function rowToEntry(row) {
  let changes = null;
  if (row.changes) {
    try {
      changes = JSON.parse(row.changes);
    } catch (e) {
      changes = null;
    }
  }
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name || "System",
    actorRole: row.actor_role,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityLabel: row.entity_label,
    changes,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  };
}

// GET /api/audit-log?actorId=&entityType=&action=&search=&from=&to=&page=&pageSize=
// Filters are all optional/AND-combined, same param-building convention as
// GET /api/users. `search` matches actor name, entity type/id/label, or
// path — a Super Administrator scanning the trail rarely knows in advance
// which of those the thing they're looking for will show up in.
router.get("/", (req, res) => {
  const { actorId, entityType, action, search, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));

  let where = " WHERE 1=1";
  const params = [];
  if (actorId) { where += " AND actor_id = ?"; params.push(actorId); }
  if (entityType) { where += " AND entity_type = ?"; params.push(entityType); }
  if (action) { where += " AND action = ?"; params.push(action); }
  if (from) { where += " AND created_at >= ?"; params.push(from); }
  if (to) { where += " AND created_at <= ?"; params.push(to); }
  if (search) {
    where += " AND (actor_name LIKE ? OR entity_type LIKE ? OR entity_id LIKE ? OR entity_label LIKE ? OR path LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log${where}`).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM audit_log${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);

  res.json({
    entries: rows.map(rowToEntry),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

// GET /api/audit-log/filters — distinct entity types and actions currently
// in the trail, so the frontend's filter dropdowns only ever offer values
// that will actually return something (rather than a hardcoded list that
// drifts from what routes actually log).
router.get("/filters", (req, res) => {
  const entityTypes = db.prepare("SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type").all().map((r) => r.entity_type);
  const actions = db.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all().map((r) => r.action);
  res.json({ entityTypes, actions });
});

module.exports = router;
