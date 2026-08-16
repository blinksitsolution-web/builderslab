/**
 * SQLite database backup, on demand or via cron/PM2-cron.
 *
 * Usage:  npm run backup:db
 * Cron:   0 3 * * * cd /path/to/server && /usr/bin/node src/db/backup.js >> /var/log/builderslab-backup.log 2>&1
 *
 * Why db.backup() instead of `cp data/builderslab.db backup.db`:
 * The live database runs in WAL mode (see db.js), which means recent
 * writes can still be sitting in the -wal file rather than the main .db
 * file at any given moment. A plain filesystem copy of just the .db file
 * can therefore capture an inconsistent/incomplete snapshot if a write is
 * in flight. better-sqlite3's `Database#backup()` uses SQLite's own
 * online backup API against the live connection, which is
 * transaction-safe and produces a single self-contained, immediately
 * restorable file regardless of WAL state or concurrent writes.
 *
 * Retention: keeps the most recent BACKUP_RETENTION_COUNT backups (default
 * 14) in the backup directory and deletes older ones, so backups don't
 * grow unbounded on disk.
 *
 * Failure behavior: exits with a non-zero code and prints to stderr on any
 * failure (missing source DB, disk full, permission error, etc.) so a cron
 * wrapper or process supervisor can surface it (cron mails stderr by
 * default on most systems; see BACKUPS.md for wiring this to an alert).
 * Never silently deletes the live database or existing backups on failure.
 */
const fs = require("fs");
const path = require("path");
const { logger } = require("../utils/logger");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../data/builderslab.db");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "../../data/backups");
const RETENTION_COUNT = Number(process.env.BACKUP_RETENTION_COUNT) || 14;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runBackup() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Source database not found at ${DB_PATH}`);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const destPath = path.join(BACKUP_DIR, `builderslab-${timestamp()}.db`);
  const tmpPath = `${destPath}.tmp`;

  // Open a separate read connection for the backup rather than reusing any
  // already-open app handle (this script always runs as its own process),
  // then use SQLite's online backup API.
  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH, { readonly: true });
  try {
    await db.backup(tmpPath);
  } finally {
    db.close();
  }

  // Guard against a corrupt/incomplete backup ever being left under its
  // final name: verify the temp file with SQLite's own integrity check,
  // then atomically rename it into place. If verification fails, the
  // partial file is removed instead of being kept as a fake "backup".
  const verifyDb = new Database(tmpPath, { readonly: true });
  let integrityOk = false;
  try {
    const result = verifyDb.pragma("integrity_check");
    integrityOk = Array.isArray(result) && result.length === 1 && result[0].integrity_check === "ok";
  } finally {
    verifyDb.close();
    // Opening the temp file (even readonly) can leave -wal/-shm sidecar
    // files next to it; the backup itself is the single self-contained
    // .db file, so these are just verification byproducts — clean them up
    // so they don't accumulate on every run.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${tmpPath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
  }
  if (!integrityOk) {
    fs.unlinkSync(tmpPath);
    throw new Error("Backup failed integrity_check — discarded, no backup file was kept for this run.");
  }
  fs.renameSync(tmpPath, destPath);

  const stat = fs.statSync(destPath);
  logger.info("database backup completed", { destPath, bytes: stat.size });

  applyRetention();
  return destPath;
}

function applyRetention() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^builderslab-.*\.db$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = files.slice(RETENTION_COUNT);
  for (const { f } of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    logger.info("pruned old backup", { file: f });
  }
}

if (require.main === module) {
  runBackup()
    .then((destPath) => {
      console.log(`Backup written to ${destPath}`);
      process.exit(0);
    })
    .catch((err) => {
      logger.error("database backup failed", { err });
      console.error(`Backup FAILED: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { runBackup, applyRetention };
