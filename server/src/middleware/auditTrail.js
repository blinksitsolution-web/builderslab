// ============================================================
// Audit Trail — catch-all middleware. Mounted once, globally, ahead of
// every route (see server.js). Its job is to guarantee that *every*
// mutating admin-reachable request ends up with at least one row in
// audit_log, even for the many routes that haven't been given their own
// rich utils/auditLog.js#recordAuditLog() call with a real before/after
// diff — see db/schema.sql's audit_log comment for how the two paths
// divide the work.
//
// Deliberately conservative about what it captures: method, path, actor,
// status code, IP, user-agent — never the request body, so nothing here
// can leak a password/API-key/payment credential into the trail. Routes
// that want a real diff of *what* changed call recordAuditLog() themselves
// with the actual before/after values (already field-filtered there).
// ============================================================
const db = require("../db/db");
const { v4: uuid } = require("uuid");

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Paths intentionally never logged here: not data-modifying in a way a
// Super Administrator reviewing the trail would care about, too
// high-volume to be useful signal, or already covered by their own
// explicit recordAuditLog() call every time they succeed.
const EXCLUDED_PREFIXES = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/refresh",
  "/api/payments/webhook",
  "/api/progress", // per-second video-progress pings — noise, not an admin-relevant change
];

// Best-effort read of an id-shaped path segment (uuid, or any long
// hex/alnum token) to populate entity_id for the generic row — e.g.
// "/api/users/3f2a.../status" -> "3f2a...". Purely cosmetic (helps a
// Super Administrator scan the list); the authoritative id is whatever an
// explicit recordAuditLog() call provided.
function firstIdLikeSegment(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  for (const part of parts.slice(2)) {
    if (/^[0-9a-f-]{8,}$/i.test(part)) return part;
  }
  return null;
}

// "/api/users/:id/status" -> "users" — the resource module a Super
// Administrator would recognize from the nav, not a raw path.
function inferEntityType(pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["api","users",":id",...]
  return parts[1] || "unknown";
}

function inferAction(method) {
  if (method === "DELETE") return "delete";
  if (method === "POST") return "create";
  return "update"; // PUT/PATCH
}

function auditTrail(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  // req.path/req.url get transiently rewritten (mount-prefix stripped) by
  // Express while a request is inside a given app.use() layer, and this
  // middleware's res.on("finish") callback below runs well after that —
  // req.originalUrl is the one property guaranteed to still hold the full,
  // real request path at that point, so every match/parse here uses it.
  const pathname = req.originalUrl.split("?")[0];
  if (EXCLUDED_PREFIXES.some((p) => pathname.startsWith(p))) return next();

  res.on("finish", () => {
    // An explicit recordAuditLog() call already ran for this request (it
    // sets req._auditLogged) — that row is richer than anything this
    // catch-all could produce, so don't write a second one.
    if (req._auditLogged) return;
    // A failed write changed nothing — nothing to record.
    if (res.statusCode >= 400) return;
    try {
      db.prepare(
        `INSERT INTO audit_log
           (id, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_label,
            changes, method, path, status_code, ip_address, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        uuid(),
        req.user ? req.user.id : null,
        req.user ? req.user.name : null,
        req.user ? req.user.role : null,
        inferAction(req.method),
        inferEntityType(pathname),
        firstIdLikeSegment(pathname),
        null,
        req.method,
        req.originalUrl,
        res.statusCode,
        req.ip,
        req.headers["user-agent"] || null
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("audit trail write failed:", e.message);
    }
  });

  next();
}

module.exports = { auditTrail };
