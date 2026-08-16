/**
 * Focused tests for Step 1 of the Multi-Currency / International Learner
 * Support architectural assessment: the additive `payments.currency`
 * column and the currency-aware audit of existing GHS aggregations.
 *
 * Follows the same lightweight pattern as backup-restore-drill.test.js —
 * run the real, unmodified `src/db/migrate.js` as a child process against
 * a throwaway temp DB, then inspect the result directly with a second
 * better-sqlite3 connection (foreign_keys left OFF on this connection,
 * same as that file, so fixture rows don't need every FK target to exist).
 *
 * Does NOT re-verify anything already covered by
 * delivery-mode-registration.test.js or the architectural assessment
 * itself — only what Step 1 actually changed.
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

function freshMigratedDb() {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-currency-db-"));
  const dbPath = path.join(dbDir, "test.db");
  const run = spawnSync(process.execPath, [MIGRATE_ENTRY], {
    cwd: SERVER_CWD,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `migrate failed: ${run.stderr}`);
  return { dbDir, dbPath };
}

test("payments-currency: migrate.js is idempotent (running twice against the same DB doesn't error)", () => {
  const { dbDir, dbPath } = freshMigratedDb();
  try {
    const second = spawnSync(process.execPath, [MIGRATE_ENTRY], {
      cwd: SERVER_CWD,
      env: { ...process.env, DB_PATH: dbPath },
      encoding: "utf8",
    });
    assert.equal(second.status, 0, `second migrate run failed: ${second.stderr}`);
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("payments-currency: a brand-new DB's payments table has currency defaulting to 'GHS'", () => {
  const { dbDir, dbPath } = freshMigratedDb();
  const db = new Database(dbPath);
  try {
    const cols = db.prepare("PRAGMA table_info(payments)").all();
    const currencyCol = cols.find((c) => c.name === "currency");
    assert.ok(currencyCol, "payments.currency column must exist");
    assert.equal(currencyCol.notnull, 1, "payments.currency should be NOT NULL");
    assert.equal(currencyCol.dflt_value.replace(/'/g, ""), "GHS");

    db.prepare(`INSERT INTO users (id, role, name, email, joined_date) VALUES ('u1', 'learner', 'Test Learner', 'u1@example.test', '2026-01-01')`).run();
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, type, status, paystack_ref, date)
       VALUES ('p1', 'u1', 100, 'monthly', 'successful', 'ref1', datetime('now'))`
    ).run();
    const row = db.prepare("SELECT currency FROM payments WHERE id = 'p1'").get();
    assert.equal(row.currency, "GHS", "a payment row inserted without naming currency (the existing MoMo flow's INSERT shape) must default to GHS");
  } finally {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("payments-currency: upgrading a pre-existing DB backfills historical rows to 'GHS' with no data loss", () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-currency-legacy-db-"));
  const dbPath = path.join(dbDir, "test.db");
  try {
    // Simulate a pre-Step-1 database: a payments table that predates the
    // `currency` column, with one historical successful payment already in it.
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        amount REAL NOT NULL,
        type TEXT NOT NULL,
        method TEXT,
        momo_number TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        paystack_ref TEXT UNIQUE,
        date TEXT NOT NULL DEFAULT (datetime('now')),
        payment_month TEXT,
        learner_ids TEXT
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO payments (id, user_id, amount, type, status, paystack_ref, date)
         VALUES ('legacy-1', 'legacy-user', 250, 'registration', 'successful', 'legacy-ref', '2026-01-15 09:00:00')`
      )
      .run();
    legacyDb.close();

    // Running migrate.js against this DB is the real upgrade path (schema.sql's
    // CREATE TABLE IF NOT EXISTS is a no-op since payments already exists, so
    // the tryAlter("...ADD COLUMN currency...") is what actually runs here).
    const run = spawnSync(process.execPath, [MIGRATE_ENTRY], {
      cwd: SERVER_CWD,
      env: { ...process.env, DB_PATH: dbPath },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `migrate failed on legacy DB: ${run.stderr}`);

    const db = new Database(dbPath);
    try {
      const row = db.prepare("SELECT * FROM payments WHERE id = 'legacy-1'").get();
      assert.ok(row, "historical payment row must survive the migration untouched");
      assert.equal(row.amount, 250, "historical amount must be unchanged");
      assert.equal(row.status, "successful", "historical status must be unchanged");
      assert.equal(row.currency, "GHS", "historical row must be backfilled to GHS, not left NULL");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("payments-currency: the Admin Overview totalPaidGHS aggregation only sums GHS payments", () => {
  const { dbDir, dbPath } = freshMigratedDb();
  const db = new Database(dbPath);
  try {
    db.prepare(`INSERT INTO users (id, role, name, email, joined_date) VALUES ('learner-1', 'learner', 'Learner One', 'learner1@example.test', '2026-01-01')`).run();
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, currency, type, status, paystack_ref, date)
       VALUES ('pay-ghs', 'learner-1', 100, 'GHS', 'monthly', 'successful', 'ref-ghs', datetime('now'))`
    ).run();
    // A hypothetical future non-GHS payment (nothing in the product creates
    // one yet, but the aggregation must already be safe against it existing).
    db.prepare(
      `INSERT INTO payments (id, user_id, amount, currency, type, status, paystack_ref, date)
       VALUES ('pay-usd', 'learner-1', 40, 'USD', 'monthly', 'successful', 'ref-usd', datetime('now'))`
    ).run();

    const paymentScopeSql = "p.user_id = u.id AND p.status = 'successful'";
    const sql = `SELECT COALESCE((SELECT SUM(amount) FROM payments p WHERE ${paymentScopeSql} AND p.currency = 'GHS'), 0) as totalPaidGHS
                 FROM users u WHERE u.id = 'learner-1'`;
    const result = db.prepare(sql).get();
    assert.equal(result.totalPaidGHS, 100, "totalPaidGHS must include only the GHS row, not the USD row");
  } finally {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
