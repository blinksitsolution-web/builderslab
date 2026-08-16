// PM2 process file — keeps the server running and restarts it on crash/reboot.
// Usage: pm2 start ecosystem.config.js && pm2 save && pm2 startup
// For bounded, rotated logs (PM2 does not rotate its own log files by
// default), also run once: pm2 install pm2-logrotate — see OPERATIONS.md.
module.exports = {
  apps: [
    {
      name: "builderslab-api",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
      // Restart-loop guard: if the app crashes within 10s of starting, up
      // to 10 times, PM2 stops trying instead of restart-looping forever
      // (which would otherwise mask a real startup failure — e.g. a bad
      // migration — behind an endlessly "restarting" process).
      min_uptime: "10s",
      max_restarts: 10,
      // src/server.js listens for SIGTERM and closes in-flight requests
      // before exiting (see the shutdown handler there). Give it a few
      // seconds to do that on redeploy/restart before PM2 force-kills it.
      kill_timeout: 5000,
      // Explicit, separate stdout/stderr log files (server.js logs
      // structured JSON to both streams) so they're easy to locate and to
      // point pm2-logrotate at, rather than relying on PM2's default path.
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
