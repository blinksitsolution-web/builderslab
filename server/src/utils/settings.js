const db = require("../db/db");

function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM site_settings WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch (e) {
    return fallback;
  }
}

function setSetting(key, value) {
  const existing = db.prepare("SELECT key FROM site_settings WHERE key = ?").get(key);
  if (existing) {
    db.prepare("UPDATE site_settings SET value = ? WHERE key = ?").run(JSON.stringify(value), key);
  } else {
    db.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  }
}

module.exports = { getSetting, setSetting };
