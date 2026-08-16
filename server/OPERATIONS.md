# Operations: logging, health/readiness, deployment resilience

Companion to `BACKUPS.md` (backup/restore) and `SECRET_ROTATION.md`
(rotating `JWT_SECRET`/`AI_CREDENTIALS_KEY`). This covers day-to-day
running of the process: what it logs, how to tell it's actually working,
and how PM2 keeps it up.

## Logging

`src/utils/logger.js` writes one JSON object per line to stdout (`info`/
`warn`) or stderr (`error`) — no logging framework dependency, no log
files written directly by the app. Every request gets a line on
completion:

```json
{"level":"info","time":"2026-07-24T18:40:50.828Z","msg":"request","requestId":"aa46...","method":"GET","path":"/api/health","status":200,"durationMs":9.41}
```

- **`requestId`** is generated per-request and echoed back as the
  `X-Request-Id` response header — if a user reports "it broke", ask for
  that header's value (visible in their browser's network tab) and
  `grep` it straight to the matching log line, including the central
  error handler's line if that request errored.
- **Levels:** `info` (normal requests), `warn` (recoverable/config
  issues, e.g. `client/dist` not built yet), `error` (5xx responses and
  the central error handler — includes the exception's message/stack
  server-side; client responses stay sanitized in production, see
  `src/utils/errorResponse.js`).
- **Repeated-failure detection:** since every error is one JSON line with
  a consistent `msg` field, `grep '"level":"error"' logs/error.log | wc -l`
  (or piping into any log aggregator that understands JSON lines — the
  format is already structured, no parsing/regex needed) is enough to
  spot a spike without adding a monitoring service.

### Bounded log growth

The app itself never rotates logs — it just writes to stdout/stderr, the
12-factor way. PM2 captures those streams to `server/logs/out.log` /
`server/logs/error.log` (see `ecosystem.config.js`), but **PM2 does not
rotate its own log files by default** — left alone, they grow forever.
Fix this once per server with the official PM2 module:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

This is a one-time operator step (not something `npm install` can do for
you), which is why it's documented here rather than automated.

## Health vs. readiness

Two separate endpoints, both unauthenticated and safe to expose to a load
balancer / uptime monitor — neither returns secrets, env values, or
filesystem paths:

- **`GET /api/health`** — liveness. Always `200 {"status":"ok"}` if the
  HTTP server is up at all. Use this for "is the process alive" checks
  (e.g. a host's auto-restart-on-failed-healthcheck feature).
- **`GET /api/ready`** — readiness. Runs a real `SELECT 1` against the
  live SQLite connection and confirms the config the app actually depends
  on at request time (`JWT_SECRET`, `AI_CREDENTIALS_KEY`, and — in
  production — `APP_URL`) is present. Returns `200 {"status":"ready"}` or
  `503 {"status":"not_ready","problems":[...]}` — `problems` names *which*
  check failed (e.g. `"database unavailable"`, `"missing required config:
  JWT_SECRET"`), never the config's value. A process can be "alive" (health
  passes) while still unable to correctly serve requests (ready fails) —
  e.g. the DB file got deleted out from under it, or it's mid-restore.
  Because this does a real DB round trip, point deploy-time/orchestrator
  readiness gates at it rather than polling it every second.

Neither endpoint requires `requireAuth`/`requireRole` — that's checked by
`test/server-wiring.test.js` and `test/integration-boundary.test.js`.

## External uptime monitoring

`/api/health` and `/api/ready` are already suitable to point any
external uptime monitor at directly — no provider-specific integration,
webhook handler, or extra endpoint is needed on this app's side. Which
one to use depends on what you're trying to detect:

| Monitor this for... | Endpoint | Expect | A failing check means |
|---|---|---|---|
| "Is the process up at all" (basic uptime/downtime alerting) | `GET /api/health` | `200` with body `{"status":"ok"}` | The process crashed, isn't listening, host is down, or a proxy/DNS issue — the most urgent, page-worthy failure. |
| "Is the app actually able to serve requests correctly" | `GET /api/ready` | `200` with body `{"status":"ready"}` | A `503` with body `{"status":"not_ready","problems":[...]}` — the process is up but the database is unreachable or required config is missing (e.g. mid-restore, or a `.env` value got lost on redeploy). Treat a sustained `503` here as urgent even though `/api/health` is still green — the app looks alive but can't correctly do its job. |

Both endpoints are safe to poll from outside the network (they never
return secrets, env values, stack traces, or filesystem paths — see
`server-wiring.test.js`'s health-handler assertions), so no auth/API key
needs to be configured on the monitor's side either.

**Generic setup (works the same with any uptime-monitor product —
UptimeRobot, Better Uptime, Pingdom, Healthchecks.io, a self-hosted
Uptime Kuma instance, or a simple cron+curl script):**

1. Add an HTTP(S) check for `GET https://your-domain/api/health` — method
   `GET`, expect HTTP status `200`, check interval whatever the product
   supports (1–5 minutes is typical). This is your primary "is it up"
   alert.
2. Add a second HTTP(S) check for `GET https://your-domain/api/ready` —
   same method/interval, also expecting `200`. Configure the monitor to
   alert separately from the health check (don't collapse the two into
   one alert) so you can tell "fully down" apart from "up but not ready"
   at a glance.
3. Point both at your real `APP_URL`, not `localhost` — that also
   incidentally verifies your reverse proxy/TLS termination (see
   README.md §4) is working, not just the Node process.
4. No provider-specific payload/webhook parsing is required on this
   app's side — any monitor that can do "GET a URL, alert if status code
   isn't 200" is sufficient. If your monitor supports response-body
   assertions, optionally also assert the body contains `"status":"ok"`
   / `"status":"ready"` respectively, to catch the (currently
   theoretical) case of a `200` with an unexpected body.

A minimal self-hosted/cron alternative with no external product at all:

```bash
# crontab -e — alerts (via cron's default mail) if either check fails
* * * * * curl -sf https://your-domain/api/health > /dev/null || echo "health check failed at $(date)"
* * * * * curl -sf https://your-domain/api/ready  > /dev/null || echo "readiness check failed at $(date)"
```

(`curl -f` makes curl itself exit non-zero on a non-2xx response, which
is what triggers cron's mail-on-output-or-failure behavior.)

## PM2 / deployment resilience

`ecosystem.config.js` (see `README.md` §4 for the full deploy steps):

- **`autorestart: true`** — restarts on crash.
- **`min_uptime: "10s"` + `max_restarts: 10`** — restart-loop guard: if
  the process keeps crashing within 10s of starting, PM2 gives up after
  10 tries instead of restart-looping forever, which would otherwise hide
  a real startup failure (bad migration, missing required env var,
  corrupt DB) behind a process that just looks "busy restarting" in
  `pm2 status`.
- **`kill_timeout: 5000`** — `src/server.js` listens for `SIGTERM`/
  `SIGINT` and calls `server.close()` (stop accepting new connections,
  let in-flight requests finish, then close the DB handle and exit 0)
  instead of dying mid-response on every redeploy. PM2 sends `SIGTERM` on
  restart/reload/stop; this gives that graceful shutdown up to 5s to
  finish before PM2 force-kills with `SIGKILL`.
- **`max_memory_restart: "300M"`** (pre-existing) — restarts the process
  if it leaks past this, rather than letting the host swap/OOM.
- **`out_file` / `error_file` / `merge_logs` / `time`** — explicit,
  ordered log file paths for the structured JSON logs above.

### What to check after a deploy

```bash
pm2 status                 # process up, not restart-looping
curl -s https://your-domain/api/health   # {"status":"ok"}
curl -s https://your-domain/api/ready    # {"status":"ready"}
pm2 logs builderslab-api --lines 50      # no unexpected error lines
```

## Integration test coverage

`server/test/integration-boundary.test.js` boots the real server (real
Express, real multer, a real temp SQLite DB migrated fresh) and, over
real HTTP, exercises exactly the boundaries above: startup, the
static-file allowlist, `/api/health` + `/api/ready`, production error
sanitization on an actual 500-path, the `X-Request-Id` header, CORS
startup refusal when `APP_URL` is missing, graceful shutdown timing, and
one upload (good + malicious) through the real `createUploadPipeline()`
mounted on a throwaway unauthenticated route. It runs automatically as
part of `npm test` alongside the existing pure-logic suite — see that
file's header comment for what's deliberately out of scope (auth/RBAC has
its own coverage elsewhere and isn't re-exercised here).

`server/test/backup-restore-drill.test.js` covers the backup/restore path
specifically — see `BACKUPS.md`'s "Automated restore verification"
section.
