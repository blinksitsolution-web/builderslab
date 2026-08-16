# The Builders' Lab — complete project (updated)

This is your **complete codebase**, not a diff — every file, with all
fixes and features from our work together already applied. See
`README-CHANGES.md` for the detailed changelog of what changed and why,
including how each fix was verified.

## What's deliberately NOT included, and why

- **`server/node_modules/`, `client/node_modules/`** — regenerated with
  `npm install`. Including them would make this zip enormous and they're
  not your code.
- **`server/.env`** — your real secrets (JWT signing key, Paystack key,
  etc.). Never bundled. Copy your existing one back in, or start from
  `server/.env.example`.
- **`server/data/builderslab.db`** (and its `-shm`/`-wal` files) — your
  real, live production data. This delivery never touched it and doesn't
  include a copy of it; put your existing database file back in
  `server/data/` before starting the server.
- **`server/data/backups/`** — your existing backups; not touched or
  copied.
- **Actual uploaded files** under `server/uploads/` (avatars, project
  submissions, etc.) — these are your users' real content. The folder
  structure is preserved (with `.gitkeep` placeholders) so the app's
  expected paths still exist; the files themselves are your own to keep
  in place.

## Setup

1. Copy your real `server/.env` and `server/data/builderslab.db` (plus
   your real `server/uploads/*` files, if you want them back) into this
   project, in the same relative locations they were in before.
2. Install dependencies:
   ```
   cd server && npm install
   cd ../client && npm install
   ```
3. Run the database migration (safe to run against your live database —
   every change is additive and off/empty by default):
   ```
   cd server && npm run migrate
   ```
4. Build the frontend (already built once and included in
   `client/dist/`, but rebuild if you change anything):
   ```
   cd client && npm run build
   ```
5. Start the server:
   ```
   cd server && npm start
   ```
   (or however you normally run/deploy it — nothing about how the server
   starts or is hosted has changed.)

## Deploy to InterServer (cPanel)

For **builderslab.dalijaytechhub.com** on InterServer with DNS at Hostinger,
follow the step-by-step guide:

**[DEPLOY-INTERSERVER.md](./DEPLOY-INTERSERVER.md)**

Production env template: `server/.env.production.example`  
Pre-flight check (on server): `cd server && npm run verify:deploy`

## What changed

See `README-CHANGES.md` for the full changelog: every bug found and
fixed, every feature built, and exactly how each was verified against
your real data before being included here.
