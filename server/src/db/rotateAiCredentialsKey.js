require("dotenv").config();
const { getSetting, setSetting } = require("../utils/settings");
const { encryptSecret, decryptSecret, secretFormat, isDedicatedKeyConfigured } = require("../utils/crypto");

// ---------------------------------------------------------------------
// One-time migration: moves stored AI provider credentials (Groq,
// Anthropic — anything under the "apiKeys" site_settings entry with an
// `apiKeyEnc` field) off the legacy JWT_SECRET-derived encryption key and
// onto the dedicated AI_CREDENTIALS_KEY.
//
// Run this BEFORE rotating JWT_SECRET. Once every credential shows as
// "dedicated-key" below, JWT_SECRET can be rotated freely without
// affecting stored AI provider keys.
//
// Safe to re-run: anything already on the dedicated key ("v2:") is left
// untouched. This script never prints a decrypted key value — only
// per-provider status (which format it was in, and whether the move
// succeeded).
//
// Usage:
//   1. Add AI_CREDENTIALS_KEY to server/.env (see .env.example for the
//      generation command) if it isn't already set.
//   2. npm run rotate:ai-key
// ---------------------------------------------------------------------

const AI_PROVIDER_IDS = ["groq", "anthropic"]; // "ollama" uses baseUrl, not an encrypted key

if (!isDedicatedKeyConfigured()) {
  console.error(
    "❌ AI_CREDENTIALS_KEY is not set in your environment.\n" +
    "   Add it to server/.env first (see server/.env.example for the\n" +
    "   generation command), then re-run this script.\n" +
    "   Nothing was changed."
  );
  process.exit(1);
}

const defaultApiKeys = () => ({
  paystackKey: "",
  activeAiProvider: "groq",
  groq: { apiKeyEnc: "", model: "" },
  anthropic: { apiKeyEnc: "", model: "" },
  ollama: { baseUrl: "http://localhost:11434", model: "" },
});

const current = getSetting("apiKeys", defaultApiKeys());
let migrated = 0;
let alreadyCurrent = 0;
let skippedEmpty = 0;
let failed = 0;

const next = { ...current };

for (const id of AI_PROVIDER_IDS) {
  const cfg = current[id];
  if (!cfg || !cfg.apiKeyEnc) {
    console.log(`- ${id}: no key stored, nothing to do.`);
    skippedEmpty++;
    continue;
  }

  const formatBefore = secretFormat(cfg.apiKeyEnc);
  if (formatBefore === "dedicated-key") {
    console.log(`- ${id}: already on the dedicated key, skipped.`);
    alreadyCurrent++;
    continue;
  }

  // decryptSecret handles both "v1:" (legacy JWT-derived) and plaintext
  // formats; encryptSecret will re-encrypt with AI_CREDENTIALS_KEY since
  // we already confirmed it's configured above.
  const plaintext = decryptSecret(cfg.apiKeyEnc);
  if (!plaintext) {
    console.error(`- ${id}: could NOT be decrypted (was: ${formatBefore}). Left unchanged — you will need to re-enter this key in Admin → Settings.`);
    failed++;
    continue;
  }

  next[id] = { ...cfg, apiKeyEnc: encryptSecret(plaintext) };
  console.log(`- ${id}: migrated from "${formatBefore}" to "dedicated-key".`);
  migrated++;
}

if (migrated > 0) {
  setSetting("apiKeys", next);
}

console.log("");
console.log(`✅ Done. Migrated: ${migrated}, already current: ${alreadyCurrent}, no key stored: ${skippedEmpty}, failed: ${failed}.`);
if (failed > 0) {
  console.log("⚠️  Some keys could not be decrypted and were left as-is — re-enter them in Admin → Settings → API Keys after rotation.");
}
if (migrated > 0 || alreadyCurrent > 0) {
  console.log("It is now safe to rotate JWT_SECRET without affecting AI provider credentials — see SECRET_ROTATION.md.");
}
