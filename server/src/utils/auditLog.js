// ============================================================
// Audit Trail — write helpers (see db/schema.sql's audit_log table for the
// full picture of how rows get here). Anything route-level that already
// knows the before/after state of what it just changed should call
// recordAuditLog() directly, right after the write, so the trail carries a
// real diff instead of falling back to middleware/auditTrail.js's generic
// method/path-only row.
// ============================================================
const { v4: uuid } = require("uuid");
const db = require("../db/db");

// Never diff or store these, even if a caller passes them in `before`/
// `after` — a password hash or raw credential has no business sitting in
// an audit row a Super Administrator might screenshot or export.
const SENSITIVE_FIELDS = new Set([
  "password", "password_hash", "passwordHash",
  "token", "secret", "api_key", "apiKey", "credentials",
  "custom_permissions", // shown separately/deliberately, not diffed generically
]);

// Shallow field-by-field diff between two plain objects (typically two
// snapshots of the same DB row, before and after an UPDATE). Returns null
// when there's nothing to show (identical, or both empty) rather than {}.
function diffObjects(before, after) {
  if (!before && !after) return null;
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = {};
  for (const key of keys) {
    if (SENSITIVE_FIELDS.has(key)) continue;
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      changes[key] = { from: a ?? null, to: b ?? null };
    }
  }
  return Object.keys(changes).length ? changes : null;
}

// req is optional (falls back to actor/ip-less rows for scripts/seed jobs),
// but every route call site has one and should pass it — it's how the
// actor, method, path, IP and user-agent get attached, and it's what sets
// req._auditLogged so middleware/auditTrail.js's catch-all skips this
// request instead of writing a second, cruder row for the same action.
function recordAuditLog({ req, actor, action, entityType, entityId, entityLabel, before, after, details }) {
  try {
    const user = actor || (req && req.user) || null;
    const changes = details !== undefined ? details : diffObjects(before, after);
    // An update with literally nothing changed (e.g. a PATCH that supplied
    // no different values) still gets a row — the action itself (someone
    // hit this endpoint) can matter even with an empty diff — but skip
    // silently would hide that, so this is a deliberate "log it anyway".
    db.prepare(
      `INSERT INTO audit_log
         (id, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_label,
          changes, method, path, status_code, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      uuid(),
      user ? user.id : null,
      user ? user.name : null,
      user ? user.role : null,
      action,
      entityType,
      entityId != null ? String(entityId) : null,
      entityLabel || null,
      changes != null ? JSON.stringify(changes) : null,
      req ? req.method : null,
      req ? req.originalUrl : null,
      null, // status_code: unknown at call time (call sites run before res.json) — the catch-all fills this in for its own rows
      req ? req.ip : null,
      req ? req.headers["user-agent"] || null : null
    );
    if (req) req._auditLogged = true;
  } catch (e) {
    // Audit logging must never break the actual request it's observing.
    // eslint-disable-next-line no-console
    console.error("audit log write failed:", e.message);
  }
}

module.exports = { recordAuditLog, diffObjects };
