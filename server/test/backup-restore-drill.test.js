/**
 * Restore-drill test for src/db/backup.js.
 *
 * This does not just check that a backup *file* gets created (that's
 * already implicitly covered by manual verification in BACKUPS.md) — it
 * actually restores the backup and proves the data is really there and
 * the file is structurally sound, which is the only way to catch a
 * backup that "succeeds" but is silently unusable.
 *
 * Runs the real, unmodified `src/db/backup.js` as a child process (same
 * pattern as test/integration-boundary.test.js) against a throwaway
 * temporary database and temporary backup directory — DB_PATH and
 * BACKUP_DIR are read from `process.env` once at module load time inside
 * backup.js, so a subprocess per scenario (rather than requiring the
 * module in-process with different env vars) is what actually exercises
 * different configurations correctly, and keeps this test from ever
 * touching the real server/data/builderslab.db or server/uploads.
 *
 * "Restore" here follows BACKUPS.md's documented procedure exactly:
 * copy the backup file to the target path and open it — there is no
 * separate "restore command" to test because the backup format IS a
 * directly-openable SQLite file by design.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const SERVER_CWD = path.join(__dirname, "..");
const MIGRATE_ENTRY = path.join(__dirname, "../src/db/migrate.js");
const BACKUP_ENTRY = path.join(__dirname, "../src/db/backup.js");

const SEED_USER = {
  id: "restore-drill-user-1",
  role: "learner",
  name: "Restore Drill Learner",
  email: "restore-drill@example.test",
  joined_date: "2026-01-01T00:00:00.000Z",
};

/** Fresh temp DB, migrated with the real schema, seeded with one representative row. */
function setupSeededTempDb() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-restore-drill-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const migrate = spawnSync(process.execPath, [MIGRATE_ENTRY], {
    cwd: SERVER_CWD,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: "utf8",
  });
  assert.equal(migrate.status, 0, `migrate failed: ${migrate.stderr}`);

  const db = new Database(dbPath);
  try {
    db.prepare(`INSERT INTO users (id, role, name, email, joined_date) VALUES (@id, @role, @name, @email, @joined_date)`).run(SEED_USER);
  } finally {
    db.close();
  }
  return { dbDir, dbPath };
}

test("backup-restore-drill: a real backup round-trips through restore with data + integrity intact", () => {
  const { dbDir, dbPath } = setupSeededTempDb();
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-restore-drill-backups-"));
  const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-restore-drill-restore-"));
  try {
    const run = spawnSync(process.execPath, [BACKUP_ENTRY], {
      cwd: SERVER_CWD,
      env: { ...process.env, DB_PATH: dbPath, BACKUP_DIR: backupDir },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `backup script failed: ${run.stderr}`);

    const backupFiles = fs.readdirSync(backupDir).filter((f) => /^builderslab-.*\.db$/.test(f));
    assert.equal(backupFiles.length, 1, "expected exactly one backup file");
    // No leftover -tmp/-wal/-shm byproducts either — see backup.js's cleanup step.
    assert.deepEqual(fs.readdirSync(backupDir), backupFiles, "backup dir must contain only the finished backup file");

    // Restore = the exact procedure documented in BACKUPS.md: copy the
    // backup file to the target path, no separate restore tool.
    const restoredPath = path.join(restoreDir, "restored.db");
    fs.copyFileSync(path.join(backupDir, backupFiles[0]), restoredPath);

    const restoredDb = new Database(restoredPath, { readonly: true });
    try {
      const integrity = restoredDb.pragma("integrity_check");
      assert.equal(integrity[0].integrity_check, "ok", "restored backup must pass SQLite's own integrity check");

      const row = restoredDb.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(SEED_USER.id);
      assert.ok(row, "seeded row must survive the backup + restore round trip");
      assert.equal(row.name, SEED_USER.name);
      assert.equal(row.email, SEED_USER.email);
      assert.equal(row.role, SEED_USER.role);
    } finally {
      restoredDb.close();
    }
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.rmSync(restoreDir, { recursive: true, force: true });
  }
});

test("backup-restore-drill: a missing source database fails loudly and leaves no partial backup", () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-restore-drill-fail-"));
  const missingDbPath = path.join(os.tmpdir(), `bl-restore-drill-missing-${Date.now()}.db`);
  try {
    const run = spawnSync(process.execPath, [BACKUP_ENTRY], {
      cwd: SERVER_CWD,
      env: { ...process.env, DB_PATH: missingDbPath, BACKUP_DIR: backupDir },
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0, "backup script must exit non-zero when the source DB is missing");
    assert.match(run.stderr, /database backup failed/);
    assert.deepEqual(fs.readdirSync(backupDir), [], "no partial/fake backup file must be left behind on failure");
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});

test("backup-restore-drill: retention still applies after a real backup run (no unbounded growth)", () => {
  const { dbDir, dbPath } = setupSeededTempDb();
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-restore-drill-retention-"));
  try {
    // Pre-seed backupDir with fake older backups above the retention count,
    // then run one real backup and confirm the total settles back at the
    // configured retention count rather than growing unbounded.
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(backupDir, `builderslab-fake-${i}.db`), "x");
    }
    const run = spawnSync(process.execPath, [BACKUP_ENTRY], {
      cwd: SERVER_CWD,
      env: { ...process.env, DB_PATH: dbPath, BACKUP_DIR: backupDir, BACKUP_RETENTION_COUNT: "3" },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `backup script failed: ${run.stderr}`);
    const remaining = fs.readdirSync(backupDir).filter((f) => /^builderslab-.*\.db$/.test(f));
    assert.equal(remaining.length, 3, "retention must trim total backups down to BACKUP_RETENTION_COUNT");
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});
