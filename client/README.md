# Builders' Lab — React/Vite frontend (foundation)

This is the incremental React replacement for the legacy static frontend
(`dashboard.html`, `login.html`, `register.html`, `api.js` at the project
root). It runs **alongside** the legacy frontend — nothing here removes or
disables it.

## Status

Phase 2 only: project scaffold, routing skeleton, API client foundation,
auth/permission context foundation, and one placeholder screen per future
portal (Learner, Adult Learner, Parent, Instructor, Admin, Super
Administrator). No portal functionality is implemented yet — see the
Phase 1 analysis for the intended migration order.

## Commands

```bash
cd client
npm install
npm run dev       # starts Vite on http://localhost:5173, proxies /api and /uploads to the backend
npm run build      # production build -> client/dist
npm run preview    # serve the production build locally
```

## Backend

Start the existing backend as usual:

```bash
cd server
npm run dev        # http://localhost:4000
```

`vite.config.js` proxies `/api` and `/uploads` requests to
`VITE_BACKEND_ORIGIN` (default `http://localhost:4000`, see
`.env.development`) so the browser only ever talks to one origin in dev —
this keeps the existing httpOnly, SameSite=Lax JWT cookie working exactly
as it does in production, with no CORS or cookie changes on the backend.

## Structure

```
src/
├── api/            API client foundation (fetch wrapper + auth endpoints)
├── context/         AuthContext, PermissionContext
├── routing/          AppRoutes, ProtectedRoute, RoleRoute
├── layout/           AppShell (shared chrome for protected routes)
└── pages/            Placeholder screens
```

The app mounts at `/app/*` so it doesn't collide with the legacy frontend's
existing paths during the coexistence period.
