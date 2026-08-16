const { AIProvider, AIProviderError, classifyStatus } = require("../aiProvider");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MIN_QUIZ_QUESTIONS = 10;

function quizPrompt(title, content) {
  const context = content && content.trim() ? content : `Title: "${title}". No transcript is available, so write general comprehension questions appropriate for a beginner STEM/robotics learner studying this topic.`;
  return `You write comprehension quizzes for a kids'/teens' STEM & robotics course.
Based on the content below, write exactly ${MIN_QUIZ_QUESTIONS} multiple-choice questions.
Return ONLY valid JSON (no prose, no markdown fences) in this exact shape:
[{"q":"...","options":["...","...","...","..."],"answer":0}]
"answer" is the zero-based index of the correct option.

Lesson content:
"""${context}"""`;
}

function remarksPrompt(title, blurb, grade) {
  return `Write ONE short, warm sentence (max 30 words) for a certificate of completion, describing the practical skills a learner has acquired after finishing a STEM/robotics module called "${title}" (module description: "${blurb || "n/a"}"). Their overall grade was ${grade != null ? grade + "%" : "not yet graded"}. Return ONLY the sentence, no quotes, no markdown.`;
}

function parseQuizJson(providerLabel, text) {
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
  } catch (e) {
    throw new AIProviderError("service_unavailable", `${providerLabel} returned an invalid quiz.`, `JSON parse error: ${e.message}. Raw: ${text.slice(0, 500)}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new AIProviderError("service_unavailable", `${providerLabel} returned an invalid quiz.`, `Unexpected response shape. Raw: ${text.slice(0, 500)}`);
  }
  return parsed;
}

class AnthropicProvider extends AIProvider {
  constructor({ apiKey, model } = {}) {
    super();
    this.apiKey = apiKey;
    this.model = model || "claude-3-5-haiku-latest";
  }

  get name() {
    return "Anthropic";
  }

  async _message(prompt, maxTokens) {
    if (!this.apiKey) throw new AIProviderError("invalid_api_key", "No Anthropic API key is configured.", "Missing Anthropic API key.");
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({ model: this.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      });
    } catch (e) {
      throw new AIProviderError("service_unavailable", "Unable to reach Anthropic.", e.message);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const status = classifyStatus(res.status);
      const msg =
        status === "invalid_api_key" ? "Invalid Anthropic API key." :
        status === "rate_limited" ? "Anthropic quota exceeded. Please retry later or check your Anthropic console usage/limits." :
        status === "model_not_found" ? `Anthropic model "${this.model}" not found.` :
        `Anthropic API error (HTTP ${res.status}).`;
      throw new AIProviderError(status, msg, `HTTP ${res.status}: ${raw}`);
    }
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || "").join("").trim();
    if (!text) throw new AIProviderError("service_unavailable", "Anthropic returned an empty response.", "Empty content[] in response.");
    return text;
  }

  async generateQuiz({ title, content }) {
    const text = await this._message(quizPrompt(title, content), 2000);
    return parseQuizJson("Anthropic", text);
  }

  async generateRemarks({ title, blurb, grade }) {
    return this._message(remarksPrompt(title, blurb, grade), 200);
  }

  async summarizeTranscript(transcript) {
    return this._message(`Summarize the following lesson transcript in 3-5 concise sentences for a course catalog. Return ONLY the summary text.\n\n"""${transcript}"""`, 400);
  }

  async healthCheck() {
    try {
      await this._message('Reply with the single word: OK', 10);
      return { status: "connected", message: "Connected" };
    } catch (e) {
      return { status: e.status || "service_unavailable", message: e.message };
    }
  }
}

module.exports = AnthropicProvider;
