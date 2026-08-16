/**
 * Shared upload-hardening helpers.
 *
 * Every route that accepts a file upload (avatars, branding images,
 * certificate signatures, project media, note attachments, ...) used to
 * rely solely on multer's `fileFilter`, which only ever sees the
 * client-supplied `file.mimetype` / `file.originalname` — both fully
 * attacker-controlled and trivially spoofed (e.g. renaming `shell.php` to
 * `photo.png` with a forged `Content-Type: image/png` part).
 *
 * This module adds a second, content-based layer that runs AFTER multer has
 * written the file to disk (diskStorage is unchanged everywhere — no
 * architecture change): it sniffs the real file-format signature ("magic
 * bytes") from the bytes actually on disk and rejects anything that doesn't
 * match what the route expects, deleting the file if it fails. It also
 * takes over filename generation so the on-disk extension is always chosen
 * from a server-side allowlist rather than the client-supplied name.
 */

const fs = require("fs");
const path = require("path");
const { v4: uuid } = require("uuid");

// Extensions that must NEVER be accepted from any upload route, regardless
// of declared mimetype — these are script/executable-capable in a browser
// or on common servers. SVG is included: it's an XML document that can
// carry inline <script>, making it script-capable in a browser/img context.
const DANGEROUS_EXTENSIONS = new Set([
  "html", "htm", "xhtml", "shtml",
  "js", "mjs", "cjs",
  "php", "php3", "php4", "php5", "phtml", "phar",
  "asp", "aspx", "jsp", "jspx",
  "exe", "dll", "com", "bat", "cmd", "sh", "bash", "ps1",
  "svg", "svgz",
  "htaccess", "config",
]);

// Recognized file "families" with the real magic-byte signatures for each
// member type. `check(buf)` inspects the first bytes actually read from
// disk; `exts` is the server-controlled allowlist of extensions considered
// part of that family.
const SIGNATURES = {
  png: { exts: ["png"], check: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  jpeg: { exts: ["jpg", "jpeg"], check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { exts: ["webp"], check: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  mp4: { exts: ["mp4", "m4v", "mov"], check: (b) => b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp" },
  webm: { exts: ["webm"], check: (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  pdf: { exts: ["pdf"], check: (b) => b.length >= 5 && b.toString("ascii", 0, 5) === "%PDF-" },
  // .docx/.xlsx/.pptx are all zip containers (PK\x03\x04) — the extension
  // is what tells them apart, the signature only proves "is actually a zip".
  ooxml: { exts: ["docx", "xlsx", "pptx"], check: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  // legacy .doc/.xls/.ppt (OLE2 compound file)
  ole: { exts: ["doc", "xls", "ppt"], check: (b) => b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1 },
};

// Named upload "profiles" used across the app. Each maps to the set of
// signature families it accepts, plus a couple of extensionless text types
// that have no reliable magic bytes but are not script-capable in a
// browser when served with `X-Content-Type-Options: nosniff` + a safe
// content-type + (where relevant) Content-Disposition: attachment.
const PROFILES = {
  // Avatars, branding logos/signatures/backgrounds, certificate signatures,
  // campus/programme/corporate-client images — plain raster images only.
  IMAGE: { families: ["png", "jpeg", "webp"], plainTextExts: [] },
  // Project submissions: images or short video clips.
  PROJECT_MEDIA: { families: ["png", "jpeg", "webp", "mp4", "webm"], plainTextExts: [] },
  // Note/assignment attachments: images or common office/document formats.
  DOCUMENT: { families: ["png", "jpeg", "webp", "pdf", "ooxml", "ole"], plainTextExts: ["txt", "csv"] },
};

function allowedExtsForProfile(profileName) {
  const profile = PROFILES[profileName];
  const exts = new Set(profile.plainTextExts);
  for (const fam of profile.families) for (const e of SIGNATURES[fam].exts) exts.add(e);
  return exts;
}

function safeExt(originalname) {
  const ext = path.extname(String(originalname || "")).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext;
}

/**
 * multer `fileFilter` factory — first, cheap line of defense. Runs before
 * anything is written to disk; rejects obviously-wrong extensions and
 * declared mimetypes up front. This alone is NOT sufficient (mimetype and
 * filename are both client-controlled), so it's paired with
 * verifyUploadedFile() below which checks real file content once the file
 * is on disk.
 */
function fileFilterForProfile(profileName) {
  const allowed = allowedExtsForProfile(profileName);
  return (req, file, cb) => {
    const ext = safeExt(file.originalname);
    if (!ext || DANGEROUS_EXTENSIONS.has(ext) || !allowed.has(ext)) {
      return cb(new Error("This file type is not allowed."), false);
    }
    // Loose mimetype sanity check — real verification happens on-disk after
    // upload via verifyUploadedFile(). Still reject blatant mismatches
    // (e.g. an html file whose extension we already blocked above, or a
    // client that mislabels an obviously non-image/video/document part).
    const mt = String(file.mimetype || "").toLowerCase();
    if (/^(text\/html|application\/javascript|application\/x-php|image\/svg)/.test(mt)) {
      return cb(new Error("This file type is not allowed."), false);
    }
    cb(null, true);
  };
}

/**
 * multer diskStorage factory — filenames are always server-generated
 * (uuid + a server-validated extension), never derived from the raw
 * client-supplied original filename, which prevents path traversal /
 * filename-manipulation tricks (e.g. `../../evil`, null bytes, doubled
 * extensions) regardless of what the client sends.
 */
function storageForDir(uploadDir) {
  return require("multer").diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = safeExt(file.originalname);
      cb(null, `${uuid()}${ext ? "." + ext : ""}`);
    },
  });
}

/**
 * Post-upload content verification middleware. Mount this AFTER
 * `upload.single(...)` so `req.file` is populated and the bytes are
 * already on disk. Reads the first bytes of the actual file, matches them
 * against the profile's allowed signatures, and deletes + rejects the
 * upload if the real content doesn't match any of them (this is what
 * catches a spoofed mimetype or a script file renamed with an image
 * extension — those pass the cheap fileFilter check above but fail here).
 */
function verifyUploadedFile(profileName) {
  const profile = PROFILES[profileName];
  return (req, res, next) => {
    if (!req.file) return next();
    const filePath = req.file.path;
    const ext = safeExt(req.file.originalname);

    const cleanupAndReject = (message) => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Already gone, or otherwise unremovable — either way there's
        // nothing further we can do here; proceed to reject the upload.
      }
      return res.status(400).json({ error: message });
    };

    if (!ext || DANGEROUS_EXTENSIONS.has(ext)) {
      return cleanupAndReject("This file type is not allowed.");
    }

    // Plain-text formats have no magic bytes to check. They can't execute
    // as scripts in a browser as long as they're served with a safe
    // content-type + nosniff (enforced in server.js), so we only confirm
    // the extension is on the allowlist and that the content looks like
    // plain text (no embedded markup/script tags, no NUL bytes — catches a
    // disguised HTML/JS/binary payload saved with a .txt/.csv name).
    if (profile.plainTextExts.includes(ext)) {
      let buf;
      try {
        buf = fs.readFileSync(filePath);
      } catch {
        return cleanupAndReject("Could not read the uploaded file.");
      }
      const head = buf.slice(0, 4096).toString("utf8").toLowerCase();
      if (buf.includes(0) || /<\s*(script|html|iframe|object|embed)\b/i.test(head) || head.includes("<?php")) {
        return cleanupAndReject("This file's content doesn't match a plain text/CSV file.");
      }
      return next();
    }

    let head;
    try {
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(16);
      const bytesRead = fs.readSync(fd, buf, 0, 16, 0);
      fs.closeSync(fd);
      head = buf.slice(0, bytesRead);
    } catch {
      return cleanupAndReject("Could not read the uploaded file.");
    }

    // Find which signature family (if any) the actual bytes match, and
    // confirm that family is both part of this profile AND consistent with
    // the file's extension (catches e.g. a .png that's really a renamed
    // .pdf, and vice versa).
    let matchedFamily = null;
    for (const fam of profile.families) {
      if (SIGNATURES[fam].check(head)) {
        matchedFamily = fam;
        break;
      }
    }
    if (!matchedFamily || !SIGNATURES[matchedFamily].exts.includes(ext)) {
      return cleanupAndReject("The file's content doesn't match its extension, or this file type isn't supported.");
    }

    next();
  };
}

/**
 * Convenience one-call setup: creates the uploads subfolder, returns a
 * configured multer instance (server-generated filenames, size limit,
 * cheap upfront fileFilter) plus the post-write content-verification
 * middleware to mount right after `upload.single(fieldName)`.
 *
 *   const { upload, verify } = createUploadPipeline("PROJECT_MEDIA", "projects", maxSizeMB);
 *   router.post("/:id", ..., upload.single("media"), verify, handler);
 */
function createUploadPipeline(profileName, subfolder, maxSizeMB) {
  const multer = require("multer");
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads", subfolder);
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: storageForDir(uploadDir),
    limits: { fileSize: (Number(maxSizeMB) || 8) * 1024 * 1024 },
    fileFilter: fileFilterForProfile(profileName),
  });
  return { upload, verify: verifyUploadedFile(profileName), uploadDir };
}

module.exports = {
  PROFILES,
  DANGEROUS_EXTENSIONS,
  createUploadPipeline,
  fileFilterForProfile,
  verifyUploadedFile,
  storageForDir,
  safeExt,
};
