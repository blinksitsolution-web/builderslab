const jwt = require("jsonwebtoken");
const db = require("../db/db");
const { hasPermission, hasAnyPermission, isSuperAdmin, isTargetInAdminScope } = require("../utils/rbac");
const { accessRestriction, RESTRICTION_MESSAGE } = require("../utils/accessControl");

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.dtl_token;
  if (!token) return res.status(401).json({ error: "Not signed in." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub);
    if (!user) return res.status(401).json({ error: "Account no longer exists." });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Session expired — please sign in again." });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    next();
  };
}

// Allows: the user themself, a parent of that learner, an instructor, or an admin.
function requireSelfParentOrStaff(paramName = "userId") {
  return (req, res, next) => {
    const targetId = req.params[paramName];
    const u = req.user;
    if (u.id === targetId || u.role === "instructor" || u.role === "admin") return next();
    if (u.role === "parent") {
      const child = db.prepare("SELECT id FROM users WHERE id = ? AND parent_id = ?").get(targetId, u.id);
      if (child) return next();
    }
    return res.status(403).json({ error: "You don't have permission to view this account." });
  };
}

// Centralized RBAC Engine gate — every Admin Portal page, API endpoint, menu
// item and action should authorize through this (or requireSuperAdmin below)
// rather than a hardcoded role/name check. Accepts one or more permission
// keys; the user needs at least one (useful for "view OR edit" style reads).
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not signed in." });
    if (!hasAnyPermission(req.user, permissions)) {
      return res.status(403).json({ error: "You don't have permission to do that." });
    }
    next();
  };
}

// For the handful of actions the spec reserves for Super Administrators only
// (Role Templates, Access & Permissions, AI Providers, API Keys, Site
// Settings edits, and managing other Super Administrators) — hasPermission()
// already hard-gates the matching permission keys behind isSuperAdmin(), but
// some actions (e.g. deleting an admin account) have no single permission
// key of their own and need the Super Administrator check directly.
function requireSuperAdmin(req, res, next) {
  if (!req.user || !isSuperAdmin(req.user)) {
    return res.status(403).json({ error: "Only a Super Administrator can do that." });
  }
  next();
}

// Enforces per-record admin scope (Campus Administrator -> own campus,
// Corporate Coordinator -> own Corporate Client) on any route that acts on
// a specific target account. Loads the target row once and exposes it as
// req.targetUser so the route handler doesn't need a second query.
//
// Some of these routes are reachable by non-admins too (e.g. gated by
// requireSelfParentOrStaff, which also allows the learner themself, a
// parent, or an instructor) — this middleware only ever applies the
// scope RESTRICTION when the caller is an admin; every other already-
// authorized role passes through unaffected, since campus scoping is an
// admin-only concept (utils/rbac.js campusScopeFor).
//
// Out-of-scope targets get a 404, not a 403 — a Campus Administrator should
// not be able to distinguish "doesn't exist" from "exists at another
// campus" by watching the status code.
function requireInAdminScope(paramName = "userId") {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not signed in." });
    const targetId = req.params[paramName];
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId);
    if (!target) return res.status(404).json({ error: "Account not found." });
    if (req.user.role === "admin" && !isTargetInAdminScope(req.user, target)) {
      return res.status(404).json({ error: "Account not found." });
    }
    req.targetUser = target;
    next();
  };
}

function sendAccessRestricted(res) {
  return res.status(403).json({ error: RESTRICTION_MESSAGE, code: "ACCESS_RESTRICTED" });
}

// Gates learner academic content that is scoped to an explicit learner id in
// the URL (e.g. /:userId/monthly, /mine/:userId, /learner/:userId). Must run
// AFTER requireAuth (and, where the route already has one, after
// requireSelfParentOrStaff — this middleware doesn't re-check who may view
// the record, only whether the record's own payment/account status allows
// it). Instructors and admins always bypass — this only ever restricts a
// learner's own view (or their parent's view) of the learner's content, and
// must never change staff permissions.
function requireActiveAccess(paramName = "userId") {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not signed in." });
    if (req.user.role === "instructor" || req.user.role === "admin") return next();
    const targetId = req.params[paramName];
    const target = targetId === req.user.id ? req.user : db.prepare("SELECT * FROM users WHERE id = ?").get(targetId);
    if (accessRestriction(target).restricted) return sendAccessRestricted(res);
    next();
  };
}

// Gates content-listing routes that have no explicit learner id in the URL
// (a learner browsing their own Notes/Assignments/Examinations/Continuous
// Assessments/Video lessons). Instructors/admins always bypass. A learner is
// gated on their own record. Parent accounts are never payment-gated
// themselves (they don't carry payment_status), so a parent is blocked here
// if ANY of their linked learners is currently restricted — these routes
// have no way to scope to a single ward, so this errs on the side of not
// exposing a restricted ward's content through them.
function requireActiveAccessSelf(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not signed in." });
  if (req.user.role === "instructor" || req.user.role === "admin") return next();
  if (req.user.role === "parent") {
    const children = db.prepare("SELECT * FROM users WHERE parent_id = ?").all(req.user.id);
    if (children.some((c) => accessRestriction(c).restricted)) return sendAccessRestricted(res);
    return next();
  }
  if (accessRestriction(req.user).restricted) return sendAccessRestricted(res);
  next();
}

// Narrower variant for routes (Messages) that are a general communication
// channel shared by every role, not exclusively learner academic content —
// only gates a restricted learner's own access to their messages; parents,
// instructors and admins are never affected, so a parent can still reach
// out about a ward's outstanding balance.
function requireActiveAccessLearnerOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not signed in." });
  if (req.user.role !== "learner") return next();
  if (accessRestriction(req.user).restricted) return sendAccessRestricted(res);
  next();
}

module.exports = {
  requireAuth,
  requireRole,
  requireSelfParentOrStaff,
  requirePermission,
  requireSuperAdmin,
  requireInAdminScope,
  requireActiveAccess,
  requireActiveAccessSelf,
  requireActiveAccessLearnerOnly,
};
