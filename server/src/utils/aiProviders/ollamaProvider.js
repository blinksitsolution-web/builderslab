const { AIProvider, AIProviderError, classifyStatus } = require("../aiProvider");

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

function parseQuizJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
  } catch (e) {
    throw new AIProviderError("service_unavailable", "Ollama returned an invalid quiz.", `JSON parse error: ${e.message}. Raw: ${text.slice(0, 500)}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new AIProviderError("service_unavailable", "Ollama returned an invalid quiz.", `Unexpected response shape. Raw: ${text.slice(0, 500)}`);
  }
  return parsed;
}

class OllamaProvider extends AIProvider {
  constructor({ baseUrl, model } = {}) {
    super();
    this.baseUrl = (baseUrl || "http://localhost:11434").replace(/\/$/, "");
    this.model = model || "llama3";
  }

  get name() {
    return "Ollama";
  }

  async _chat(prompt) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: prompt }], stream: false }),
      });
    } catch (e) {
      throw new AIProviderError("offline", "Unable to reach Ollama. Is it running?", e.message);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const status = res.status === 404 ? "model_not_found" : classifyStatus(res.status);
      const msg =
        status === "model_not_found" ? `Ollama model "${this.model}" not found. Pull it with "ollama pull ${this.model}".` :
        `Ollama API error (HTTP ${res.status}).`;
      throw new AIProviderError(status, msg, `HTTP ${res.status}: ${raw}`);
    }
    const data = await res.json();
    const text = data.message?.content?.trim();
    if (!text) throw new AIProviderError("service_unavailable", "Ollama returned an empty response.", "Empty message.content.");
    return text;
  }

  async generateQuiz({ title, content }) {
    const text = await this._chat(quizPrompt(title, content));
    return parseQuizJson(text);
  }

  async generateRemarks({ title, blurb, grade }) {
    return this._chat(remarksPrompt(title, blurb, grade));
  }

  async summarizeTranscript(transcript) {
    return this._chat(`Summarize the following lesson transcript in 3-5 concise sentences for a course catalog. Return ONLY the summary text.\n\n"""${transcript}"""`);
  }

  async healthCheck() {
    try {
      await this._chat('Reply with the single word: OK');
      return { status: "connected", message: "Connected" };
    } catch (e) {
      return { status: e.status || "offline", message: e.message };
    }
  }
}

module.exports = OllamaProvider;
