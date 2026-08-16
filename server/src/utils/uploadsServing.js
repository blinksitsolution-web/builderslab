/**
 * Pure header-decision logic for serving /uploads safely, extracted from
 * server.js so it's unit-testable without booting Express. Behavior is
 * unchanged from what previously lived inline: nosniff is always set,
 * known-safe types render inline with the correct Content-Type, and
 * anything else is forced to download as an attachment instead of
 * rendering in the browser.
 */
const path = require("path");

const SAFE_INLINE_CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

function getUploadsResponseHeaders(requestPath) {
  const headers = { "X-Content-Type-Options": "nosniff" };
  const ext = path.extname(requestPath).toLowerCase();
  const safeType = SAFE_INLINE_CONTENT_TYPES[ext];
  if (safeType) {
    headers["Content-Type"] = safeType;
  } else {
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Disposition"] = "attachment";
  }
  return headers;
}

module.exports = { SAFE_INLINE_CONTENT_TYPES, getUploadsResponseHeaders };
