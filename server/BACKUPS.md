# Backups & disaster recovery

This app's durable state is two things: the SQLite database
(`server/data/builderslab.db`) and the uploads directory
(`server/uploads/`). Both need backing up — a database backup alone loses
every avatar, project photo, certificate signature, and note attachment.

## What's implemented

| | Database | Uploads |
|---|---|---|
| Script | `npm run backup:db` (`src/db/backup.js`) | `npm run backup:uploads` (`src/db/backupUploads.js`) |
| Method | SQLite's online backup API via `better-sqlite3`'s `db.backup()` | Recursive file copy (`fs.cpSync`) |
| Output | `server/data/backups/builderslab-<timestamp>.db` | `server/data/backups/uploads/uploads-<timestamp>/` |
| Safety check | SQLite `PRAGMA integrity_check` on the copy before it's kept | File-count comparison (source vs. copy) before it's kept |
| Retention | Keeps the newest 14 backups (`BACKUP_RETENTION_COUNT` env var to change), deletes older ones | Same |
| On failure | Exits with a non-zero code, logs to stderr, **keeps no partial/corrupt backup and touches no existing backup** | Same |

Run both together with `npm run backup`.

### Why not just `cp data/builderslab.db backup.db`?

The database runs in WAL mode (see `src/db/db.js`), so recent writes can
be sitting in `builderslab.db-wal` rather than the main file at any given
moment. A plain file copy of just `.db` can capture an inconsistent
snapshot mid-write. SQLite's own online backup API (what `db.backup()`
uses) is transaction-safe and produces one self-contained, immediately
restorable file regardless of WAL state or concurrent writes — that's
also why the integrity check runs against the *copy*, not the live file.

## Scheduling

Add both to cron (adjust the path and Node binary path for your server):

```bash
# crontab -e
0 3 *  * * cd /path/to/builderslab/server && /usr/bin/node src/db/backup.js >> /var/log/builderslab-backup.log 2>&1
30 3 * * * cd /path/to/builderslab/server && /usr/bin/node src/db/backupUploads.js >> /var/log/builderslab-backup.log 2>&1
```

Cron mails stderr output to the crontab owner by default on most Linux
distros, which is enough to notice a failure without adding a paid
monitoring service — see "Making failures observable" below if you want
something more immediate (e.g. a Slack/webhook ping), and see
`OPERATIONS.md`'s "External uptime monitoring" section for wiring
`/api/health` / `/api/ready` into an uptime monitor for the *running app*
(a separate concern from these backup jobs, but often set up at the same
time).

**Off-site copy:** the above only protects against SQLite-level
corruption or an accidental `DELETE`/`DROP`, not the whole disk failing —
backups still living on the same disk as the live data don't survive a
lost/destroyed server. This app doesn't bundle a cloud-provider SDK for
this (see README's "Known limitations" — adding one is a deliberate
choice to make later, tied to whichever host you actually deploy to), but
the mechanism to hook one up is already in place and configurable:

- **The backup destination is a plain local directory**, controlled by
  the `BACKUP_DIR` (database) and `UPLOADS_BACKUP_DIR` (uploads) env
  vars — see `.env.example`. Point either at any local path (e.g. a
  separate mounted volume) if you want the *first* copy off the primary
  disk, at zero extra tooling cost.
- **Syncing that directory off-site is then a standard file-sync
  problem**, not something specific to this app. Two provider-neutral
  options, neither requiring a new npm dependency:

  ```bash
  # Option A — rsync over SSH to any other host you control (no cloud
  # account needed; openssh + rsync are on virtually every Linux box):
  rsync -az --delete /path/to/builderslab/server/data/backups/ \
    user@offsite-host:/path/to/offsite/builderslab-backups/

  # Option B — rclone, if you want to target S3/B2/GCS/etc: rclone is a
  # single self-contained binary you install yourself (not an npm
  # dependency of this project) and configure once per remote with
  # `rclone config`. Once configured for a remote named e.g. "offsite":
  rclone sync /path/to/builderslab/server/data/backups/ offsite:builderslab-backups/
  ```

  Either command is safe to run repeatedly (idempotent — only changed/new
  files transfer) and works unchanged regardless of which provider
  `offsite:` ends up pointing at, so switching providers later doesn't
  touch this app or its scripts.

- **Verifying the off-site copy actually landed:** both `rsync` and
  `rclone` exit non-zero on failure — chain the copy after a successful
  local backup and fail loudly if either step fails:

  ```bash
  node src/db/backup.js && \
    rsync -az --delete data/backups/ user@offsite-host:/path/to/offsite/builderslab-backups/ || \
    echo "OFFSITE COPY FAILED for $(date)" >&2
  ```

  For periodic confidence beyond "the command exited 0", compare file
  counts (`rsync --dry-run --itemize-changes` shows what *would* still
  transfer — an empty list means the two sides already match) or run
  `rclone check` (compares checksums between local and remote) on a
  schedule separate from the sync itself.

## Restore procedure

1. **Stop the app** (`pm2 stop builderslab-api`) — restoring into a live
   database can be caught mid-write and corrupt the process's connection.
2. **Database:** copy the desired backup file over the live one:
   ```bash
   cp server/data/backups/builderslab-<timestamp>.db server/data/builderslab.db
   rm -f server/data/builderslab.db-wal server/data/builderslab.db-shm
   ```
   (removing any stale `-wal`/`-shm` from the *previous* live file — the
   restored `.db` file is self-contained and doesn't need them.)
3. **Uploads:** restore the matching (or best-available) snapshot:
   ```bash
   rm -rf server/uploads
   cp -r server/data/backups/uploads/uploads-<timestamp> server/uploads
   ```
4. **Restart the app** (`pm2 restart builderslab-api`) and confirm
   `GET /api/ready` returns `{"status":"ready"}`.
5. Spot-check: log in, open a learner profile with an avatar, open a
   project with a photo — confirms both the DB and uploads restore lined
   up correctly.

Pick a database backup and an uploads backup from **close to the same
timestamp** — restoring a database from Tuesday with uploads from Monday
means some rows will reference files that no longer exist (harmless —
they'll just 404 — but worth knowing).

## Making backup failures observable

Both scripts already do the minimum needed for this: non-zero exit code
and a stderr message on any failure, and a structured JSON log line
(`{"level":"error", "msg":"database backup failed", ...}`) either way.
From there, plug into whatever you already have:

- **Cron mail** (zero extra setup, see above) — good enough for a solo
  operator.
- **PM2 users:** run the backup scripts as PM2 cron jobs instead of OS
  cron (`pm2 start src/db/backup.js --cron "0 3 * * *" --no-autorestart`)
  and they show up in `pm2 status`/`pm2 logs` alongside the API process.
- **A webhook/Slack ping on failure** — append `|| curl -X POST
  <your-webhook-url> -d "backup failed"` to the cron line if/when you
  want that; not added by default since it requires a URL specific to
  your setup.

## Automated restore verification

`server/test/backup-restore-drill.test.js` runs the real `backup.js`
script (unmodified) against a temporary, migrated, seeded SQLite database
— never the real `server/data/builderslab.db` — then actually restores
the resulting backup file (via the same copy-and-open procedure
documented above) and confirms both `PRAGMA integrity_check` passes and
the seeded row survived the round trip. It also confirms the missing-
source failure path leaves no partial backup file, and that retention
still trims correctly after a real run. This runs automatically as part
of `npm test` alongside the rest of the suite, so a change that silently
breaks backup/restore fails CI rather than being discovered during an
actual incident.

## What's intentionally not here

- **Point-in-time recovery** (restoring to an arbitrary moment between
  backups) — out of scope at this scale; daily backups with a 14-day
  retention window is the practical baseline for a project of this size.
  If you need finer granularity later, look at SQLite's WAL-based
  continuous backup tools, or move to Postgres with `pg_basebackup` +
  WAL archiving (see README's "Known limitations" on the Postgres path).
- **Automatic restore** — deliberately manual (see procedure above).
  An automatic restore that runs unattended risks overwriting good data
  with a bad backup; a human should confirm which backup is being
  restored and why.
