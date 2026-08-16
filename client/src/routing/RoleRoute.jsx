import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../context/PermissionContext";

/**
 * Placeholder role-based route boundary (Phase 2 scope: structure only).
 *
 * Renders its child routes only if the signed-in user's role is in
 * `allow`. This is UX routing, not a security boundary — every API call
 * behind it is still independently enforced server-side (requireRole /
 * requirePermission / requireSuperAdmin, per Phase 1 analysis).
 *
 * Usage (wired up in AppRoutes.jsx):
 *   <Route element={<RoleRoute allow={["admin"]} />}>
 *     <Route path="admin/*" element={<AdminPlaceholder />} />
 *   </Route>
 *
 * `requireSuperAdmin` additionally checks isSuperAdmin from
 * PermissionContext, for the future Super Administrator-only routes
 * (Role Templates, Access & Permissions, AI Providers, API Keys — see
 * Phase 1, section 7).
 */
export default function RoleRoute({ allow = [], requireSuperAdmin = false, redirectTo = "/app" }) {
  const { user } = useAuth();
  const { isSuperAdmin } = usePermissions();

  if (!user) return null; // ProtectedRoute (rendered above this in the tree) handles the unauthenticated case

  const roleAllowed = allow.length === 0 || allow.includes(user.role);
  const superAdminAllowed = !requireSuperAdmin || isSuperAdmin;

  if (!roleAllowed || !superAdminAllowed) {
    return <Navigate to={redirectTo} replace />;
  }

  return <Outlet />;
}
