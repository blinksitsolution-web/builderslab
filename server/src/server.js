require("dotenv").config();

// Node 18+ ships a built-in global fetch(); Node 16 doesn't. This keeps
// src/utils/paystack.js and src/utils/ai.js working either way without
// caring which Node version is running them.
if (typeof fetch === "undefined") {
  global.fetch = require("node-fetch");
}

const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { isProductionCorsMisconfigured } = require("./utils/corsSafety");
const { buildErrorResponse } = require("./utils/errorResponse");
const { getUploadsResponseHeaders } = require("./utils/uploadsServing");
const { logger } = require("./utils/logger");
const db = require("./db/db");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const moduleRoutes = require("./routes/modules");
const courseGroupRoutes = require("./routes/courses");
const progressRoutes = require("./routes/progress");
const projectRoutes = require("./routes/projects");
const noteRoutes = require("./routes/notes");
const messageRoutes = require("./routes/messages");
const gradeRoutes = require("./routes/grades");
const paymentRoutes = require("./routes/payments");
const pricingRoutes = require("./routes/pricing");
const paymentsWebhook = require("./routes/paymentsWebhook");
const attendanceRoutes = require("./routes/attendance");
const topicRoutes = require("./routes/topics");
const settingsRoutes = require("./routes/settings");
const classRoutes = require("./routes/classes");
const certificateRoutes = require("./routes/certificates");
const certificateTemplateRoutes = require("./routes/certificateTemplates");
const campusBrandingRoutes = require("./routes/campusBranding");
const assignmentRoutes = require("./routes/assignments");
const examRoutes = require("./routes/exams");
const continuousAssessmentRoutes = require("./routes/continuousAssessments");
const academicCalendarRoutes = require("./routes/academicCalendar");
const promotionRoutes = require("./routes/promotion");
const learningOfferingRoutes = require("./routes/learningOfferings");
const roleTemplateRoutes = require("./routes/roleTemplates");
const enrolmentRoutes = require("./routes/enrolments");
const learningInstanceRoutes = require("./routes/learningInstances");
const sponsorRoutes = require("./routes/sponsors");
const sponsorBulkRegistrationRoutes = require("./routes/sponsorBulkRegistration");
const auditLogRoutes = require("./routes/auditLog");
const { auditTrail } = require("./middleware/auditTrail");

const app = express();
app.set("trust proxy", 1); // required for secure cookies behind Nginx/Render/Railway etc.

app.use(helmet({ contentSecurityPolicy: false })); // CSP off by default since we inline <script> in the static pages; tighten this once you move scripts to external files with nonces.

// Structured request logging: one JSON line per response, with a
// per-request ID (also echoed back in the X-Request-Id response header so
// a client-reported issue can be matched to the exact server log line),
// method, path, status, and duration. This is the minimal "who hit what,
// what happened, how long did it take" signal needed to debug production
// issues and spot repeated failures, without pulling in a logging
// framework — see OPERATIONS.md.
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const log = res.statusCode >= 500 ? logger.error : logger.info;
    log("request", {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });
  next();
});

// CORS startup safety: this CORS config sends credentials (cookies), so an
// empty/missing origin would make `cors` reflect no origin at all (fine)
// but risks silently misconfiguring auth for every client in production if
// APP_URL was simply never set. Fail loudly at boot instead of silently
// serving a broken/unsafe config.
if (isProductionCorsMisconfigured(process.env)) {
  logger.error("APP_URL must be set in production (used for CORS + password-reset links). Refusing to start.");
  process.exit(1);
}
app.use(
  cors({
    origin: process.env.APP_URL,
    credentials: true,
  })
);

// IMPORTANT: the Paystack webhook needs the raw request body for signature
// verification, so it must be mounted BEFORE express.json() below.
app.use("/api/payments/webhook", paymentsWebhook);

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// Basic brute-force protection on auth endpoints.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
// Same protection for password recovery — previously unprotected, so it
// could be hammered to spam an inbox with reset links or repeatedly probe
// which emails are registered via response timing.
const forgotPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use("/api/users/forgot-password", forgotPasswordLimiter);

// General-purpose flood/abuse protection for the rest of the API. Mounted
// after the stricter limiters above, which are matched first (by route)
// and remain the effective limit for login/register/forgot-password —
// this one only adds a basic ceiling everywhere else under /api.
const globalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
app.use("/api", globalApiLimiter);

// Audit Trail catch-all (see middleware/auditTrail.js): registered before
// every route below so its res.on("finish") listener is attached ahead of
// the request reaching any handler, but it reads req.user at *finish*
// time — by then requireAuth (further down each route's own chain) has
// already populated it on this same req object. Covers every mutating
// route mounted after this line, including ones that gain a route file
// later without anyone remembering to add audit logging by hand.
app.use("/api", auditTrail);

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/sponsors", sponsorRoutes);
app.use("/api/sponsors/:sponsorId/bulk-registration", sponsorBulkRegistrationRoutes);
app.use("/api/modules", moduleRoutes);
app.use("/api/course-groups", courseGroupRoutes);
app.use("/api/progress", progressRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/notes", noteRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/grades", gradeRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/pricing", pricingRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/topics", topicRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/certificates", certificateRoutes);
app.use("/api/certificate-templates", certificateTemplateRoutes);
app.use("/api/campus-branding", campusBrandingRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/exams", examRoutes);
app.use("/api/continuous-assessments", continuousAssessmentRoutes);
app.use("/api/academic-calendar", academicCalendarRoutes);
app.use("/api/promotion", promotionRoutes);
app.use("/api/learning-offerings", learningOfferingRoutes);
app.use("/api/role-templates", roleTemplateRoutes);
app.use("/api/enrolments", enrolmentRoutes);
app.use("/api/learning-instances", learningInstanceRoutes);
app.use("/api/audit-log", auditLogRoutes);

// Minimal liveness check — no secrets, env vars, DB data, or filesystem
// paths in the response. Used by uptime monitors/load balancers.
app.get("/api/health", (req, res) => res.status(200).json({ status: "ok" }));

// Readiness check — distinct from liveness above. A process can be "alive"
// (the HTTP server is up and answering /api/health) while still unable to
// actually serve requests correctly, e.g. the SQLite file is missing/
// locked/corrupt, or a required secret was never set. This runs a trivial
// query against the real DB connection and confirms the secrets the app
// depends on at request-time are present — WITHOUT ever returning their
// values, only which (if any) are missing. Intended for deploy-time /
// orchestrator readiness gates, not high-frequency polling (each call
// does a real DB round trip).
app.get("/api/ready", (req, res) => {
  const problems = [];

  try {
    db.prepare("SELECT 1").get();
  } catch {
    problems.push("database unavailable");
  }

  const requiredEnv = ["JWT_SECRET", "AI_CREDENTIALS_KEY"];
  if (process.env.NODE_ENV === "production") requiredEnv.push("APP_URL");
  for (const name of requiredEnv) {
    if (!process.env[name]) problems.push(`missing required config: ${name}`);
  }

  if (problems.length > 0) {
    return res.status(503).json({ status: "not_ready", problems });
  }
  res.status(200).json({ status: "ready" });
});

// Uploaded project photos/videos.
//
// Hardened serving:
//  - `dotfiles: "deny"` + Express's own normalization already prevent a
//    request path from escaping this directory (`..` segments are resolved
//    before matching a file, and express.static 403s attempts that would
//    walk outside its root), so uploaded paths can't escape /uploads.
//  - `X-Content-Type-Options: nosniff` stops a browser from ignoring the
//    declared Content-Type and guessing (e.g. "sniffing" HTML out of a file
//    served as image/png), which is what would otherwise let a
//    disguised-as-an-image script execute.
//  - Content-Type is looked up from our own extension allowlist rather
//    than express.static's default mime-type table, and anything not on
//    that allowlist is forced to download as an attachment instead of
//    rendering inline — so even a file that somehow made it to disk with
//    an unexpected extension can't execute as a script in the browser.
const UPLOADS_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "../../uploads"));
// Ensure the uploads directory exists at startup (important on Railway
// where the volume mount path may be /app/uploads — created on first boot).
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(
  "/uploads",
  (req, res, next) => {
    const headers = getUploadsResponseHeaders(req.path);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    next();
  },
  express.static(UPLOADS_DIR, {
    dotfiles: "deny",
    setHeaders: (res) => res.removeHeader("X-Powered-By"),
  })
);

// The React app (client/) mounts itself at /app/* (see
// client/src/routing/AppRoutes.jsx) and builds to client/dist. Serving it
// here, same-origin, is what actually makes it reachable in production —
// until now only `npm run dev`'s Vite server exposed it. This does not
// touch "/" (still legacy index.html below) or change auth: the React app
// uses the same httpOnly, SameSite=Lax session cookie already issued by
// /api/auth/login, so no CORS/cookie changes are needed here either.
const REACT_APP_DIST = path.join(__dirname, "../../client/dist");
if (fs.existsSync(REACT_APP_DIST)) {
  app.use("/app", express.static(REACT_APP_DIST));
  // Client-side routes (e.g. /app/admin/accounts) aren't real files on
  // disk — fall back to the SPA's own index.html so React Router (not
  // this server) resolves them. Only non-file, non-API GETs under /app
  // reach this: express.static above already served any real built asset.
  app.get(/^\/app(\/.*)?$/, (req, res) => {
    res.sendFile(path.join(REACT_APP_DIST, "index.html"));
  });
} else {
  // Expected in a fresh checkout before `cd client && npm run build` has
  // been run — falls through to legacy-only serving below rather than
  // erroring, so the rest of the app (and API) still works.
  logger.warn("client/dist not found — /app will 404 until `cd client && npm run build` is run.");
}

// Root cutover (Phase 23): "/" now serves the React public landing page
// (client/src/pages/public/PublicLandingPage.jsx) instead of legacy
// index.html. This is an EXACT match on "/" only — every other legacy
// static file (register.html, reset-password.html, dashboard.html,
// login.html, style.css, images/, api.js, ...) is untouched and keeps
// being served by the explicit allowlist below, since Express tries
// routes in declaration order and this only ever matches the bare root
// path. Guarded the same way as /app above: if client/dist hasn't been
// built yet, this route is simply never registered and "/" falls through
// to the legacy index.html route below exactly as it did before this
// phase.
if (fs.existsSync(REACT_APP_DIST)) {
  app.get("/", (req, res) => {
    res.sendFile(path.join(REACT_APP_DIST, "index.html"));
  });
}

// ------------------------------------------------------------------
// SECURITY HOTFIX: this used to be a single
//   app.use(express.static(path.join(__dirname, "../../")))
// which served the ENTIRE project root — including server/data/
// builderslab.db, server/.env, and every file under server/src/**
// (routes, utils, schema) — to any unauthenticated client. Verified
// exploitable: `curl /server/data/builderslab.db` returned the live
// SQLite database with no auth.
//
// Fix: never hand express.static a directory that contains anything
// other than what's meant to be public. The legacy static frontend
// (index.html, dashboard.html, login.html, register.html,
// reset-password.html, cms.html, style.css, api.js, images/) is the
// ONLY thing that belongs at "/", so it's now allow-listed explicitly
// by exact filename instead of the whole tree being exposed. Every
// URL below already existed and was already reachable before this
// fix — nothing here is a new path, this only removes the ones that
// were never supposed to be public (server/**, client/src/**,
// package.json, README/FIX_NOTES docs, etc.).
// ------------------------------------------------------------------
const FRONTEND_DIR = path.join(__dirname, "../../");

// Old bookmarked .html URLs → React routes (see DEPLOY-INTERSERVER.md).
// Registered before the legacy static allowlist so they win even when the
// original files aren't shipped in this export.
const LEGACY_HTML_REDIRECTS = [
  ["/login.html", "/app/login"],
  ["/register.html", "/app/register"],
  ["/dashboard.html", "/app"],
  ["/cms.html", "/app/admin/cms"],
];
for (const [from, to] of LEGACY_HTML_REDIRECTS) {
  app.get(from, (req, res) => res.redirect(301, to));
}
app.get("/reset-password.html", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, `/app/reset-password${qs}`);
});

const LEGACY_PUBLIC_FILES = ["index.html", "dashboard.html", "login.html", "register.html", "reset-password.html", "cms.html", "style.css", "api.js"];
for (const file of LEGACY_PUBLIC_FILES) {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(FRONTEND_DIR, file)));
}
// "/" falls back to the legacy landing page when client/dist hasn't been
// built (the React "/" route above already wins when it has, since it's
// registered first and Express uses the first matching route).
app.get("/", (req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));
// Static media referenced by the legacy pages (images/DTH.jpg etc.) — a
// real directory allowlist, not the project root.
app.use("/images", express.static(path.join(FRONTEND_DIR, "images")));

app.use((err, req, res, next) => {
  // Always log the full error server-side (dev and prod alike) — only the
  // client-facing response differs.
  logger.error("unhandled request error", { requestId: req.requestId, method: req.method, path: req.path, err });
  const { status, body } = buildErrorResponse(err, process.env.NODE_ENV === "production");
  res.status(status).json(body);
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  logger.info(`The Builders' Lab API running on port ${PORT}`, { port: Number(PORT), env: process.env.NODE_ENV || "development" });
});

// Graceful shutdown: stop accepting new connections and let in-flight
// requests finish before exiting, instead of dropping them mid-response.
// PM2 (and most orchestrators/hosts) send SIGTERM on redeploy/restart/
// scale-down, and Ctrl-C sends SIGINT locally — both are handled the same
// way here. `server.close()`'s own timeout (driven by any keep-alive
// connections) is bounded by PM2's `kill_timeout` in ecosystem.config.js,
// which force-kills the process if shutdown takes too long.
function shutdown(signal) {
  logger.info("shutdown signal received, closing server", { signal });
  server.close((err) => {
    if (err) {
      logger.error("error while closing server", { err });
      process.exit(1);
    }
    try {
      db.close();
    } catch {
      // best-effort — process is exiting either way
    }
    logger.info("server closed cleanly");
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
