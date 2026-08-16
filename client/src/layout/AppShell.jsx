import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../context/PermissionContext";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import MobileNavDrawer from "./MobileNavDrawer";
import PageContainer from "./PageContainer";
import { getNavItems } from "./navConfig";
import ErrorBoundary from "../components/ui/ErrorBoundary";
import styles from "./AppShell.module.css";

/**
 * Application shell — desktop sidebar + top bar, collapsing to a top bar
 * with a mobile nav Drawer below the lg breakpoint. This is the reusable
 * chrome every migrated portal mounts inside (via <Outlet/>) — it does
 * not implement any portal's content itself, only the pattern (see
 * layout/navConfig.js). Nav items are built from both `role`/`is_adult`
 * and backend-provided permission data (PermissionContext) so items like
 * Admin's "Super Administrator" link only appear when actually granted
 * (Phase 8) — this is a UX convenience only, never the security boundary;
 * every route is still independently guarded by RoleRoute/the backend.
 */
export default function AppShell() {
  const { user, logout } = useAuth();
  const { isSuperAdmin, hasAnyPermission } = usePermissions();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const items = getNavItems(user?.role, user?.is_adult, { isSuperAdmin, hasAnyPermission, isCoordinator: !!user?.sponsor_id });

  return (
    <div className={styles.shell}>
      <Sidebar items={items} />
      <div className={styles.main}>
        <Topbar onOpenNav={() => setNavOpen(true)} user={user} onLogout={logout} />
        <PageContainer>
          {/* Root safety net (Part 3/5/6 of the blank-page remediation):
             previously an uncaught render exception anywhere in a page —
             e.g. the Children.only crash fixed in SettingsCampusesTab —
             unmounted this entire shell (Sidebar/Topbar included), because
             nothing above <Outlet/> ever caught anything. Now the nav
             chrome always survives and the admin can navigate away instead
             of facing a fully blank tab. `key={location.pathname}` resets
             the boundary automatically on navigation, so leaving the
             broken page and coming back (once fixed) doesn't require a
             full reload. This does not replace fixing bugs at their root
             cause — see ErrorBoundary.jsx and README-CHANGES.md. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </PageContainer>
      </div>
      <MobileNavDrawer open={navOpen} onClose={() => setNavOpen(false)} items={items} />
    </div>
  );
}
