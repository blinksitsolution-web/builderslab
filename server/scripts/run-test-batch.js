/**
 * Run each test file individually and write incremental results.
 * Avoids one long hung process and PowerShell pipe buffering issues.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const testDir = path.join(__dirname, "..", "test");
const outPath = path.join(__dirname, "..", "test-batch-summary.json");
const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.js")).sort();

const results = { files: [], totals: { pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 } };

for (const file of files) {
  const started = Date.now();
  const proc = spawnSync(process.execPath, ["--test", path.join(testDir, file)], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env },
  });
  const output = (proc.stdout || "") + (proc.stderr || "");
  const pass = Number((output.match(/ℹ pass (\d+)/) || [])[1] || 0);
  const fail = Number((output.match(/ℹ fail (\d+)/) || [])[1] || 0);
  const skipped = Number((output.match(/ℹ skipped (\d+)/) || [])[1] || 0);
  const cancelled = Number((output.match(/ℹ cancelled (\d+)/) || [])[1] || 0);
  const todo = Number((output.match(/ℹ todo (\d+)/) || [])[1] || 0);
  const ok = proc.status === 0 && fail === 0;
  results.files.push({ file, ok, pass, fail, skipped, cancelled, todo, ms: Date.now() - started, exitCode: proc.status });
  results.totals.pass += pass;
  results.totals.fail += fail;
  results.totals.skipped += skipped;
  results.totals.cancelled += cancelled;
  results.totals.todo += todo;
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${file} (${pass}/${fail}/${skipped})\n`);
}

console.log(JSON.stringify(results.totals, null, 2));
