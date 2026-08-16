/**
 * Uploads-directory backup, on demand or via cron/PM2-cron.
 *
 * Usage:  npm run backup:uploads
 * Cron:   30 3 * * * cd /path/to/server && /usr/bin/node src/db/backupUploads.js >> /var/log/builderslab-backup.log 2>&1
 *
 * Uploaded files (avatars, branding images, certificate signatures,
 * project media, note/assignment attachments) are the other piece of
 * durable state alongside the SQLite database (see backup.js) and are not
 * captured by a database backup. This makes a timestamped copy of the
 * uploads directory, verifies the copy's file count matches the source,
 * and applies the same retention/rotation policy as the database backup.
 *
 * This is a straightforward `fs`-level copy (no third-party archiving
 * tool required) appropriate for the current local-disk uploads
 * architecture. If uploads move to S3/Cloudinary (see README.md "Known
 * limitations"), this script becomes unnecessary — the object store's own
 * versioning/backup features take over and this file can be retired.
 *
 * Failure behavior: exits non-zero and prints to stderr on any failure,
 * and never deletes the live uploads directory or prior backups on
 * failure. See BACKUPS.md for the restore procedure and alerting notes.
 */
const fs = require("fs");
const path = require("path");
const { logger } = require("../utils/logger");

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "../../uploads"));
const BACKUP_DIR = process.env.UPLOADS_BACKUP_DIR || path.join(__dirname, "../../data/backups/uploads");
const RETENTION_COUNT = Number(process.env.BACKUP_RETENTION_COUNT) || 14;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else count += 1;
  }
  return count;
}

function runBackup() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    throw new Error(`Uploads directory not found at ${UPLOAD_DIR}`);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const destDir = path.join(BACKUP_DIR, `uploads-${timestamp()}`);
  const tmpDir = `${destDir}.tmp`;

  fs.cpSync(UPLOAD_DIR, tmpDir, { recursive: true });

  const sourceCount = countFiles(UPLOAD_DIR);
  const copiedCount = countFiles(tmpDir);
  if (copiedCount !== sourceCount) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`Backup file count mismatch (source ${sourceCount}, copy ${copiedCount}) — discarded, no backup was kept for this run.`);
  }

  fs.renameSync(tmpDir, destDir);
  logger.info("uploads backup completed", { destDir, files: copiedCount });

  applyRetention();
  return destDir;
}

function applyRetention() {
  const entries = fs
    .readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^uploads-/.test(e.name))
    .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(BACKUP_DIR, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = entries.slice(RETENTION_COUNT);
  for (const { name } of toDelete) {
    fs.rmSync(path.join(BACKUP_DIR, name), { recursive: true, force: true });
    logger.info("pruned old uploads backup", { dir: name });
  }
}

if (require.main === module) {
  try {
    const destDir = runBackup();
    console.log(`Uploads backup written to ${destDir}`);
    process.exit(0);
  } catch (err) {
    logger.error("uploads backup failed", { err });
    console.error(`Uploads backup FAILED: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { runBackup, applyRetention };
