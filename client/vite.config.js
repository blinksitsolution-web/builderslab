import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The existing backend (server/src/server.js) serves the legacy frontend
// same-origin and issues an httpOnly, SameSite=Lax JWT cookie on
// /api/auth/login. To keep that cookie-based auth working unmodified during
// local development (no CORS/SameSite changes, no backend changes), the Vite
// dev server proxies /api and /uploads to the real backend so the browser
// only ever talks to one origin — exactly like production, where server.js
// serves both the static frontend and the API from the same origin.
//
// Backend origin is configurable via VITE_BACKEND_ORIGIN (see .env.development)
// so this doesn't hardcode a port that may differ from the developer's
// server/.env PORT.
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendOrigin = env.VITE_BACKEND_ORIGIN || "http://localhost:4000";

  return {
    plugins: [react()],
    // Production builds are only ever served by server.js under the /app
    // prefix (app.use("/app", express.static(REACT_APP_DIST)) — see
    // server.js) — even when this same index.html is served for the root
    // "/" route (Phase 23 cutover), the JS/CSS it references still have to
    // resolve at /app/assets/..., since that's the only place they
    // actually live on disk. Without this, Vite's default base "/" bakes
    // in absolute src="/assets/..." tags that 404 everywhere (browser
    // resolves them against the origin, not the current page), leaving a
    // blank page with no visible error except a 404 in devtools' Network
    // tab. The dev server (`npm run dev`) is unaffected — it isn't routed
    // through server.js's /app mount at all, so it keeps base "/".
    base: command === "build" ? "/app/" : "/",
    server: {
      port: 5173,
      proxy: {
        "/api": { target: backendOrigin, changeOrigin: false },
        "/uploads": { target: backendOrigin, changeOrigin: false },
        "/images": { target: backendOrigin, changeOrigin: false },
      },
    },
    build: {
      // Kept separate from the legacy frontend's own root-level files
      // (dashboard.html, login.html, etc.) — see server.js FRONTEND_DIR
      // comment in Phase 1 notes; wiring this output into server.js's
      // static serving is a later-phase decision, not part of this
      // foundation.
      outDir: "dist",
    },
  };
});
