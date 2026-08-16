// Common interface every AI provider must implement. The rest of the LMS
// (lessons, quizzes, remarks, certificates) talks ONLY to this interface via
// aiProviderRegistry.getActiveProvider() — never to a provider's raw API.
// Adding a new provider means adding one class here that implements these
// methods + one line in aiProviderRegistry.js — no other LMS file changes.

const STATUS_LABELS = {
  connected: "Connected",
  invalid_api_key: "Invalid API Key",
  invalid_endpoint: "Invalid Endpoint",
  model_not_found: "Model Not Found",
  rate_limited: "Rate Limited",
  service_unavailable: "Service Unavailable",
  offline: "Offline",
};

// Maps a raw HTTP status code to one of the standardized health-check
// statuses above.
function classifyStatus(httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return "invalid_api_key";
  if (httpStatus === 404) return "model_not_found";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus >= 500) return "service_unavailable";
  return "invalid_endpoint";
}

// Carries a standardized status (see STATUS_LABELS) plus a user-facing
// message and the raw underlying provider error, so callers can display the
// real error and store the raw detail for troubleshooting.
class AIProviderError extends Error {
  constructor(status, friendlyMessage, detail) {
    super(friendlyMessage);
    this.status = status;
    this.detail = detail || friendlyMessage;
  }
}

class AIProvider {
  // Short display name, e.g. "Groq", "Anthropic", "Ollama".
  get name() {
    throw new Error("AIProvider.name must be implemented");
  }

  // { title, content } -> array of { q, options, answer }. Throws AIProviderError.
  async generateQuiz(/* { title, content } */) {
    throw new Error("generateQuiz() not implemented");
  }

  // { title, blurb, grade } -> short certificate/remarks sentence (string).
  async generateRemarks(/* { title, blurb, grade } */) {
    throw new Error("generateRemarks() not implemented");
  }

  // transcript (string) -> condensed summary (string).
  async summarizeTranscript(/* transcript */) {
    throw new Error("summarizeTranscript() not implemented");
  }

  // Convenience wrapper for the video-lesson pipeline: given a transcript
  // and/or a Lesson Summary, returns { quiz }. Providers may override for
  // custom orchestration; default just delegates to generateQuiz().
  async processLesson({ title, transcript, summary }) {
    const content = transcript && transcript.trim() ? transcript : summary;
    const quiz = await this.generateQuiz({ title, content });
    return { quiz };
  }

  // -> { status: one of STATUS_LABELS keys, message: string }. Must never
  // generate quizzes or modify lesson/quiz data.
  async healthCheck() {
    throw new Error("healthCheck() not implemented");
  }
}

module.exports = { AIProvider, AIProviderError, classifyStatus, STATUS_LABELS };
