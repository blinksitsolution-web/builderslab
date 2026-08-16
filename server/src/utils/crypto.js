const crypto = require("crypto");

// ---------------------------------------------------------------------
// Encryption for AI provider credentials (Groq/Anthropic keys) at rest.
//
// Historically this derived its AES key directly from JWT_SECRET, which
// meant rotating JWT_SECRET (e.g. after the project was shared and had to
// be treated as compromised) would silently make every stored provider
// key undecryptable. AI_CREDENTIALS_KEY decouples the two: JWT_SECRET can
// now be rotated freely — it only affects session tokens — without
// touching AI provider credentials at all.
//
// Stored value format: "<version>:<ivHex>:<tagHex>:<cipherHex>"
//   v2  — encrypted with AI_CREDENTIALS_KEY (current, used for all new
//         writes once AI_CREDENTIALS_KEY is configured)
//   v1  — encrypted with the legacy JWT_SECRET-derived key. Decrypt-only:
//         nothing is ever written in this format anymore. Existing v1
//         values are migrated to v2 by `npm run rotate:ai-key`
//         (server/src/db/rotateAiCredentialsKey.js) — see SECRET_ROTATION.md.
//   (no prefix) — pre-encryption plaintext, from before this scheme
//         existed at all. Decrypt-only, for backward compatibility.
//
// NEVER log or return the plaintext of anything passing through this
// module — only the masked form (maskSecret) is safe to send to a client
// or write to a log line.
// ---------------------------------------------------------------------

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

// The dedicated key. Returns null if AI_CREDENTIALS_KEY isn't configured
// yet, so callers can fall back to the legacy scheme without crashing.
function dedicatedKey() {
  const secret = process.env.AI_CREDENTIALS_KEY;
  if (!secret) return null;
  return deriveKey(secret);
}

// The old JWT_SECRET-derived key. Kept ONLY so v1 values written before
// this change can still be decrypted (by the app at read time, and by the
// one-time migration script). Never used to encrypt anything new.
function legacyKey() {
  const secret = process.env.JWT_SECRET || "dev-insecure-secret";
  return deriveKey(secret);
}

function encryptWithKey(plaintext, key, version) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decryptWithKey(stored, key) {
  const [, ivHex, tagHex, dataHex] = stored.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

function encryptSecret(plaintext) {
  if (!plaintext) return "";
  const key = dedicatedKey();
  if (key) return encryptWithKey(plaintext, key, "v2");
  // AI_CREDENTIALS_KEY not configured yet — fall back to the legacy
  // JWT_SECRET-derived key so the app keeps working out of the box, but
  // this path is deprecated. Set AI_CREDENTIALS_KEY and run
  // `npm run rotate:ai-key` to move stored credentials onto the
  // dedicated key so they survive future JWT_SECRET rotations.
  return encryptWithKey(plaintext, legacyKey(), "v1");
}

function decryptSecret(stored) {
  if (!stored) return "";
  if (stored.startsWith("v2:")) {
    const key = dedicatedKey();
    if (!key) return ""; // AI_CREDENTIALS_KEY missing — this value can't be read without it
    try {
      return decryptWithKey(stored, key);
    } catch (e) {
      return "";
    }
  }
  if (stored.startsWith("v1:")) {
    try {
      return decryptWithKey(stored, legacyKey());
    } catch (e) {
      return "";
    }
  }
  // Pre-encryption plaintext value — returned as-is for backward compatibility.
  return stored;
}

// Never expose a full key back to the admin UI once saved.
function maskSecret(plaintext) {
  if (!plaintext) return "";
  if (plaintext.length <= 8) return "*".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}${"*".repeat(8)}${plaintext.slice(-4)}`;
}

// Metadata-only — identifies which format a stored value is in WITHOUT
// decrypting it. Safe to use for status/reporting (e.g. "2 keys still on
// the legacy format") without ever touching the plaintext.
function secretFormat(stored) {
  if (!stored) return "empty";
  if (stored.startsWith("v2:")) return "dedicated-key";
  if (stored.startsWith("v1:")) return "legacy-jwt-derived-key";
  return "plaintext";
}

function isDedicatedKeyConfigured() {
  return Boolean(process.env.AI_CREDENTIALS_KEY);
}

module.exports = { encryptSecret, decryptSecret, maskSecret, secretFormat, isDedicatedKeyConfigured };
