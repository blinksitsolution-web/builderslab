const { AIProvider, AIProviderError, classifyStatus } = require("../aiProvider");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
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
  console.error("===== RAW GROQ RESPONSE START =====");
  console.error(text);
  console.error("===== RAW GROQ RESPONSE END =====");

  throw new AIProviderError(
    "service_unavailable",
    `${providerLabel} returned an invalid quiz.`,
    `JSON parse error: ${e.message}`
  );
}
}

class GroqProvider extends AIProvider {
  constructor({ apiKey, model } = {}) {
    super();
    this.apiKey = apiKey;
    this.model = model || "llama-3.1-8b-instant";
  }

  get name() {
    return "Groq";
  }

  async _chat(prompt, maxTokens) {
    if (!this.apiKey) throw new AIProviderError("invalid_api_key", "No Groq API key is configured.", "Missing Groq API key.");
    let res;
    try {
      res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
      });
    } catch (e) {
      throw new AIProviderError("service_unavailable", "Unable to reach Groq.", e.message);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const status = classifyStatus(res.status);
      const msg =
        status === "invalid_api_key" ? "Invalid Groq API key." :
        status === "rate_limited" ? "Groq quota exceeded. Please retry later or check your Groq console usage/limits." :
        status === "model_not_found" ? `Groq model "${this.model}" not found.` :
        `Groq API error (HTTP ${res.status}).`;
      throw new AIProviderError(status, msg, `HTTP ${res.status}: ${raw}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AIProviderError("service_unavailable", "Groq returned an empty response.", "Empty choices[0].message.content.");
    return text;
  }

  async generateQuiz({ title, content }) {
    const text = await this._chat(quizPrompt(title, content), 1800);
    return parseQuizJson("Groq", text);
  }

  async generateRemarks({ title, blurb, grade }) {
    return this._chat(remarksPrompt(title, blurb, grade), 200);
  }

  async summarizeTranscript(transcript) {
    return this._chat(`Summarize the following lesson transcript in 3-5 concise sentences for a course catalog. Return ONLY the summary text.\n\n"""${transcript}"""`, 400);
  }

  async healthCheck() {
    try {
      await this._chat('Reply with the single word: OK', 10);
      return { status: "connected", message: "Connected" };
    } catch (e) {
      return { status: e.status || "service_unavailable", message: e.message };
    }
  }
}

module.exports = GroqProvider;
