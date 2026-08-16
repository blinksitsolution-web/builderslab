import { createContext, useContext, useMemo } from "react";
import { useAuth } from "./AuthContext";

/**
 * PermissionContext — structural foundation only (Phase 2).
 *
 * Every field here is read verbatim from GET /api/auth/me — never
 * re-derived. Per Phase 1 analysis (server/src/utils/userView.js,
 * server/src/utils/rbac.js):
 *   - `permissions`, `isSuperAdmin`, `roleTemplateId`, `roleTemplateName`,
 *     `usesCustomPermissions` are only ever populated for role:"admin".
 *   - `accessRestricted` / `accessRestrictedReason` are computed for every
 *     role and reflect the payment/status gate enforced server-side by
 *     requireActiveAccess*.
 *
 * hasPermission()/hasAnyPermission() below are the same convenience check
 * dashboard.html's ADMIN_NAV_PERMISSIONS filtering does — a UX nicety for
 * hiding nav/UI the user can't use. They are NOT a security boundary: the
 * server's requirePermission()/requireSuperAdmin() middleware is the only
 * real gate, and every API call can still 403 regardless of what this
 * context says.
 */
const PermissionContext = createContext(null);

export function PermissionProvider({ children }) {
  const { user } = useAuth();

  const value = useMemo(() => {
    const permissions = new Set((user && user.permissions) || []);
    return {
      role: user ? user.role : null,
      isAdult: !!(user && user.is_adult),
      isSuperAdmin: !!(user && user.isSuperAdmin),
      roleTemplateId: user ? user.roleTemplateId || null : null,
      roleTemplateName: user ? user.roleTemplateName || null : null,
      usesCustomPermissions: !!(user && user.usesCustomPermissions),
      permissions,
      accessRestricted: !!(user && user.accessRestricted),
      accessRestrictedReason: user ? user.accessRestrictedReason || null : null,
      hasPermission: (key) => permissions.has(key),
      hasAnyPermission: (keys = []) => keys.some((key) => permissions.has(key)),
    };
  }, [user]);

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export function usePermissions() {
  const ctx = useContext(PermissionContext);
  if (!ctx) throw new Error("usePermissions must be used within a PermissionProvider");
  return ctx;
}
