#!/usr/bin/env node
/**
 * Pre-flight checks before starting (or after uploading) on cPanel/InterServer.
 * Run from the server directory: npm run verify:deploy
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const SERVER_ROOT = path.join(__dirname, "..");
const CLIENT_DIST = path.join(SERVER_ROOT, "..", "client", "dist");
const DATA_DIR = path.join(SERVER_ROOT, "data");
const UPLOADS_DIR = path.join(SERVER_ROOT, "uploads");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "builderslab.db");

const errors = [];
const warnings = [];

function ok(msg) {
  console.log(`  OK  ${msg}`);
}

function warn(msg) {
  warnings.push(msg);
  console.log(`  WARN ${msg}`);
}

function fail(msg) {
  errors.push(msg);
  console.log(`  FAIL ${msg}`);
}

console.log("Builders' Lab — deployment verification\n");

// Node version
const major = Number(process.version.slice(1).split(".")[0]);
if (major >= 20) ok(`Node.js ${process.version}`);
else if (major >= 18) warn(`Node.js ${process.version} — >= 20 recommended. Set NODE_VERSION=20 in your hosting environment.`);
else fail(`Node.js ${process.version} — need >= 20.`);

// Frontend build
if (fs.existsSync(path.join(CLIENT_DIST, "index.html"))) ok(`React build found at client/dist/`);
else fail(`client/dist/index.html missing — upload client/dist/ or run "cd client && npm run build" locally first.`);

// Writable directories
for (const dir of [DATA_DIR, UPLOADS_DIR, path.join(DATA_DIR, "backups")]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    ok(`Writable: ${path.relative(SERVER_ROOT, dir)}/`);
  } catch {
    fail(`Not writable: ${path.relative(SERVER_ROOT, dir)}/ — fix permissions in cPanel File Manager (755 or 775).`);
  }
}

// Database
if (fs.existsSync(DB_PATH)) ok(`Database file exists: ${path.relative(SERVER_ROOT, DB_PATH)}`);
else warn(`No database yet at ${path.relative(SERVER_ROOT, DB_PATH)} — run "npm run migrate" (and seed:admin if fresh install).`);

// Environment
if (process.env.NODE_ENV === "production") ok("NODE_ENV=production");
else warn(`NODE_ENV=${process.env.NODE_ENV || "(unset)"} — set to production on the live server.`);

const appUrl = process.env.APP_URL || "";
if (!appUrl) fail("APP_URL is not set — required in production.");
else if (!/^https:\/\/.+[^/]$/.test(appUrl)) warn(`APP_URL=${appUrl} — should be https://your-domain with no trailing slash.`);
else ok(`APP_URL=${appUrl}`);

for (const key of ["JWT_SECRET", "AI_CREDENTIALS_KEY"]) {
  const val = process.env[key] || "";
  if (!val || val.includes("replace_with")) fail(`${key} is missing or still a placeholder.`);
  else ok(`${key} is set`);
}

if (process.env.COOKIE_SECURE === "false") warn("COOKIE_SECURE=false — set to true in production (requires HTTPS).");
else if (process.env.COOKIE_SECURE !== "false") ok("COOKIE_SECURE enabled (or default secure in production)");

// Native module
try {
  require("better-sqlite3");
  ok("better-sqlite3 loaded");
} catch (e) {
  fail(`better-sqlite3 failed to load — run "npm install" in server/ on the server. ${e.message}`);
}

console.log("");
if (errors.length) {
  console.log(`${errors.length} error(s), ${warnings.length} warning(s) — fix errors before going live.`);
  process.exit(1);
}
if (warnings.length) {
  console.log(`${warnings.length} warning(s) — review before going live.`);
  process.exit(0);
}
console.log("All checks passed.");
