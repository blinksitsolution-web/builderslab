const { getSetting } = require("./settings");
const { decryptSecret } = require("./crypto");
const GroqProvider = require("./aiProviders/groqProvider");
const AnthropicProvider = require("./aiProviders/anthropicProvider");
const OllamaProvider = require("./aiProviders/ollamaProvider");

const DEFAULT_MODELS = {
  groq: "llama-3.1-8b-instant",
  anthropic: "claude-3-5-haiku-latest",
  ollama: "llama3",
};

// Single place that knows about concrete provider classes. Adding a new
// provider = one new class in aiProviders/ + one entry here — no other LMS
// module needs to change.
const FACTORIES = {
  groq: (cfg) => new GroqProvider({ apiKey: decryptSecret(cfg.apiKeyEnc), model: cfg.model || DEFAULT_MODELS.groq }),
  anthropic: (cfg) => new AnthropicProvider({ apiKey: decryptSecret(cfg.apiKeyEnc), model: cfg.model || DEFAULT_MODELS.anthropic }),
  ollama: (cfg) => new OllamaProvider({ baseUrl: cfg.baseUrl, model: cfg.model || DEFAULT_MODELS.ollama }),
};

function getAiSettings() {
  return getSetting("apiKeys", {});
}

function getActiveProviderId() {
  return getAiSettings().activeAiProvider || "groq";
}

// The ONLY entry point the rest of the LMS should use to reach an AI
// provider. Returns a fully configured instance of whichever provider is
// currently active in Site Settings — switching providers there takes
// effect immediately, with no code change or restart.
function getActiveProvider() {
  return getProvider(getActiveProviderId());
}

function getProvider(providerId) {
  const factory = FACTORIES[providerId] || FACTORIES.groq;
  const cfg = getAiSettings()[providerId] || {};
  return factory(cfg);
}

module.exports = { getActiveProvider, getActiveProviderId, getProvider, DEFAULT_MODELS };
