/**
 * Maps the backend's user object to the appropriate existing React route.
 * Reads only `role` and `is_adult` as returned by GET /api/auth/me /
 * POST /api/auth/login — no new role is introduced and no RBAC/permission
 * logic is re-derived here (Super Administrator vs other admins is not
 * distinguished for routing purposes; that distinction belongs to
 * RoleRoute's `requireSuperAdmin` guard on the specific admin/super route,
 * not to where a login lands).
 *
 * Learner and Adult Learner share the same destination (/app/learner) —
 * see Phase 5: is_adult only ever changes minor UI within that one route,
 * never which route is reached.
 */
export function getPostLoginRoute(user) {
  if (!user) return "/app";
  switch (user.role) {
    case "learner":
      return "/app/learner";
    case "parent":
      return "/app/parent";
    case "instructor":
      return "/app/instructor";
    case "admin":
      return "/app/admin";
    default:
      return "/app";
  }
}
