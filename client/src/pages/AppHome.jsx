import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getPostLoginRoute } from "../routing/postLoginRoute";

/**
 * Bare `/app` index route (Phase 21 integration fix). Every portal now
 * exists (Phase 5-20), so a Phase-2 "foundation" placeholder here was
 * stale: it's reachable both from a direct visit to `/app` and from
 * RoleRoute's role-mismatch redirect (its `redirectTo` defaults to
 * "/app" — see routing/RoleRoute.jsx). Both cases should land the person
 * on their own portal, not a dead-end screen with no navigation forward.
 */
export default function AppHome() {
  const { user } = useAuth();
  return <Navigate to={getPostLoginRoute(user)} replace />;
}
