import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * Auth guard (Phase 2 scaffold, completed in Phase 4).
 *
 * Now that the React login route exists (/app/login), an unauthenticated
 * visitor is kept inside the React app — no more full navigation out to
 * the legacy login.html. The attempted location is passed along via
 * `state.from` so LoginPage can return the person to where they were
 * headed after a successful sign-in.
 */
export default function ProtectedRoute() {
  const { isLoading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (isLoading) return null; // avoid a flash-redirect while /api/auth/me is in flight

  if (!isAuthenticated) {
    return <Navigate to="/app/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
