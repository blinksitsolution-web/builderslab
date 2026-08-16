import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { PermissionProvider } from "./context/PermissionContext";
import { ToastProvider } from "./context/ToastContext";
import ToastViewport from "./components/ui/ToastViewport";
import AppRoutes from "./routing/AppRoutes";
import PublicLandingPage from "./pages/public/PublicLandingPage";
import NotFound from "./pages/NotFound";

/**
 * Root cutover (Phase 23), fixed.
 *
 * server.js serves this same build's index.html for both "/" and "/app/*"
 * (see server.js comments), and the React app itself now owns routing
 * between those two areas with a single, reactive router.
 *
 * Previously this mounted two *separate* <BrowserRouter> trees, chosen
 * once via a raw `window.location.pathname === "/"` check made only at
 * initial render: a basename-less router for "/" (just PublicLandingPage,
 * no <Routes> at all) and a `basename="/app"` router for everything else.
 * That split caused two concrete regressions:
 *
 *   1. Clicking the "Sign in" link on the landing page (a react-router
 *      <Link to="/app/login">, see PublicHeader.jsx) only ever updated the
 *      URL — the outer router had no <Routes> to react to it, and nothing
 *      re-evaluates App's one-time pathname check, so the landing page
 *      stayed on screen until the person manually refreshed.
 *   2. Every already-existing absolute navigation target in the app
 *      (getPostLoginRoute(), ProtectedRoute's redirect to "/app/login",
 *      navConfig.js's nav item hrefs, breadcrumbs, etc.) is written as
 *      "/app/..." — correct for a basename-less router, but under
 *      `basename="/app"` react-router prepends the basename to those
 *      already-absolute targets, producing "/app/app/...".
 *
 * Using one router with no basename and nesting <AppRoutes/> under a
 * "/app/*" <Route> fixes both at the source: navigation between "/" and
 * "/app/*" is now a normal, reactive client-side transition, and every
 * existing "/app/..." target resolves exactly once, with no doubling —
 * without having to touch the (many) call sites that already write
 * "/app/..." paths.
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PublicLandingPage />} />
        <Route
          path="/app/*"
          element={
            <AuthProvider>
              <PermissionProvider>
                <ToastProvider>
                  <AppRoutes />
                  <ToastViewport />
                </ToastProvider>
              </PermissionProvider>
            </AuthProvider>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
