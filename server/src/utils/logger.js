/**
 * Minimal structured logger — no external dependency.
 *
 * Deliberately writes single-line JSON to stdout/stderr rather than to a
 * file: this is the 12-factor approach (the process just emits a log
 * stream) and keeps us from having to implement our own file rotation
 * here. In production, PM2 (see ecosystem.config.js) captures stdout/
 * stderr to disk already; pairing that with the `pm2-logrotate` module
 * (an operator-run `pm2 install pm2-logrotate`, documented in
 * OPERATIONS.md) gives bounded, rotated log files without adding a
 * logging framework as an application dependency.
 *
 * Every line is a single JSON object: { level, time, msg, ...meta }.
 * `meta` is any extra structured context (requestId, status, route, err,
 * ...) — never put secrets (JWT_SECRET, AI_CREDENTIALS_KEY, passwords,
 * tokens, Paystack keys, full req.body) into it.
 */

function write(stream, level, msg, meta) {
  const entry = { level, time: new Date().toISOString(), msg };
  if (meta && typeof meta === "object") {
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined) entry[k] = v;
    }
  }
  stream.write(JSON.stringify(entry) + "\n");
}

const logger = {
  info(msg, meta) {
    write(process.stdout, "info", msg, meta);
  },
  warn(msg, meta) {
    write(process.stdout, "warn", msg, meta);
  },
  error(msg, meta) {
    // Errors go to stderr so process managers / `2>` redirection can
    // separate them from routine request logs.
    const out = { ...meta };
    if (meta && meta.err instanceof Error) {
      out.err = { message: meta.err.message, stack: meta.err.stack, status: meta.err.status };
    }
    write(process.stderr, "error", msg, out);
  },
};

module.exports = { logger };
