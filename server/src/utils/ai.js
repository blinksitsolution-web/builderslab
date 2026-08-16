const db = require("../db/db");
const { getLesson } = require("../data/lessons");
const { extractYoutubeId } = require("./lessonCatalog");
const { getActiveProvider } = require("./aiProviderRegistry");
const { AIProviderError } = require("./aiProvider");

const MIN_QUIZ_QUESTIONS = 10; // "at least 10 MCQs" per lesson video or note read

// Reads a previously-cached quiz WITHOUT ever calling an AI provider. Used by
// the learner-facing quiz endpoints for instructor-published video lessons,
// so students only ever see the one quiz saved at publish time.
function getStoredQuiz(courseId, lessonId) {
  const cached = db.prepare("SELECT questions FROM ai_quiz_cache WHERE course_id = ? AND lesson_id = ?").get(courseId, lessonId);
  return cached ? JSON.parse(cached.questions) : null;
}

// A cached row counts as "already AI-generated" (and therefore reusable,
// never regenerated) as long as its source isn't the curated fallback bank.
// This also keeps legacy rows (source='gemini' from before the provider
// migration) valid without any backfill.
function cacheIsAiGenerated(cached) {
  return !!(cached && cached.source && cached.source !== "fallback");
}

// Repeats a short fallback bank (e.g. a lesson with only 1-3 hand-written
// questions) until it reaches the required minimum, so learners always get
// at least MIN_QUIZ_QUESTIONS even without an AI provider configured.
function padToMinimum(bank) {
  if (!bank || !bank.length) return bank;
  const out = [];
  let i = 0;
  while (out.length < MIN_QUIZ_QUESTIONS) {
    out.push(bank[i % bank.length]);
    i++;
  }
  return out;
}

// A small generic bank used only when a note has no AI provider configured
// and no hand-written quizBank of its own (unlike video lessons, notes/slides
// don't ship with curated questions in code) — better than blocking the
// learner outright, but admins should configure an AI provider for real
// content-aware questions.
function genericFallbackBank(title) {
  return padToMinimum([
    { q: `What was the main topic of "${title}"?`, options: ["The subject covered in this note", "Something unrelated", "A different module entirely", "None of the above"], answer: 0 },
    { q: `Did you read through all of "${title}" before starting this quiz?`, options: ["Yes, I read it carefully", "No, I skipped it", "I only skimmed it", "I didn't open it"], answer: 0 },
  ]);
}

async function generateQuiz(courseId, lessonId) {
  const cached = db.prepare("SELECT questions, source FROM ai_quiz_cache WHERE course_id = ? AND lesson_id = ?").get(courseId, lessonId);
  if (cacheIsAiGenerated(cached)) return JSON.parse(cached.questions);

  const lesson = getLesson(courseId, lessonId);
  if (!lesson) return [];

  const provider = getActiveProvider();
  let questions = null;
  try {
    questions = await provider.generateQuiz({ title: lesson.title, content: lesson.transcript });
  } catch (e) {
    console.error(`${provider.name} quiz generation failed, using fallback bank:`, e.message);
  }
  const source = questions ? provider.name.toLowerCase() : "fallback";
  if (!questions) questions = padToMinimum(lesson.quizBank);

  if (source !== "fallback") {
    db.prepare(
      "INSERT OR REPLACE INTO ai_quiz_cache (course_id, lesson_id, questions, source, provider, model) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(courseId, lessonId, JSON.stringify(questions), source, provider.name, provider.model || null);
  }

  return questions;
}

// Same idea as generateQuiz, but for a note/slide instead of a video lesson
// (there's no entry in data/lessons.js to look up, so the caller passes the
// note's title/body directly). Cached under a synthetic lessonId of the
// form "note:<noteId>" so it reuses the same progress/quiz-score plumbing.
async function generateNoteQuiz(courseId, noteLessonId, note) {
  const cached = db.prepare("SELECT questions, source FROM ai_quiz_cache WHERE course_id = ? AND lesson_id = ?").get(courseId, noteLessonId);
  if (cacheIsAiGenerated(cached)) return JSON.parse(cached.questions);

  const provider = getActiveProvider();
  let questions = null;
  try {
    questions = await provider.generateQuiz({ title: note.title, content: note.body });
  } catch (e) {
    console.error(`${provider.name} quiz generation failed, using generic fallback:`, e.message);
  }
  const source = questions ? provider.name.toLowerCase() : "fallback";
  if (!questions) questions = genericFallbackBank(note.title);

  if (source !== "fallback") {
    db.prepare(
      "INSERT OR REPLACE INTO ai_quiz_cache (course_id, lesson_id, questions, source, provider, model) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(courseId, noteLessonId, JSON.stringify(questions), source, provider.name, provider.model || null);
  }

  return questions;
}

// Falls back to a plain, still-accurate sentence if there's no AI provider
// configured or the call fails — certificates should never be blocked on AI
// being down.
async function generateSkillsSummary(moduleTitle, moduleBlurb, grade) {
  try {
    const provider = getActiveProvider();
    const ai = await provider.generateRemarks({ title: moduleTitle, blurb: moduleBlurb, grade });
    if (ai) return ai;
  } catch (e) {
    console.error("AI skills-summary generation failed, using fallback:", e.message);
  }
  const gradeText = grade != null ? ` with an overall grade of ${grade}%` : "";
  return `Successfully completed all lessons, quizzes and projects in ${moduleTitle}${gradeText}, demonstrating practical, hands-on STEM and robotics skills.`;
}

// Best-effort automatic transcript fetch from YouTube's public captions
// endpoint (no API key). Returns null if unavailable — the instructor's
// Lesson Summary is used instead in that case.
async function fetchAutoTranscript(youtubeId) {
  if (!youtubeId) return null;
  try {
    const res = await fetch(`https://video.google.com/timedtext?lang=en&v=${youtubeId}`);
    if (!res.ok) return null;
    const xml = await res.text();
    if (!xml || !xml.includes("<text")) return null;
    const text = Array.from(xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g))
      .map((m) => m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">"))
      .join(" ")
      .trim();
    return text || null;
  } catch (e) {
    return null;
  }
}

const videoLessonId = (noteId) => `vlesson:${noteId}`;

// The ONE place an AI provider is called for an instructor-published video
// lesson. Runs once at publish/republish time (or on explicit instructor/
// admin retry) — never from a learner route. Uses the auto-fetched
// transcript when available, otherwise the instructor's Lesson Summary
// (note.body). Never switches providers on failure — only an admin changing
// the active provider in Site Settings does that.
async function processVideoLessonNote(noteId) {
  const note = db.prepare("SELECT * FROM notes WHERE id = ? AND kind = 'video_lesson'").get(noteId);
  if (!note) return { ok: false, error: "Video lesson not found." };

  db.prepare("UPDATE notes SET ai_status = 'processing', ai_error = NULL, ai_error_detail = NULL WHERE id = ?").run(noteId);

  try {
    let transcript = note.ai_transcript;
    let transcriptVersion = note.transcript_version || 0;
    if (!transcript) {
      transcript = await fetchAutoTranscript(extractYoutubeId(note.video_url || ""));
      if (transcript) {
        transcriptVersion += 1;
        db.prepare("UPDATE notes SET ai_transcript = ?, transcript_version = ? WHERE id = ?").run(transcript, transcriptVersion, noteId);
      }
    }

    const source = transcript && transcript.trim() ? transcript : note.body;
    if (!source || !source.trim()) {
      throw new AIProviderError("invalid_endpoint", "No transcript could be obtained and no Lesson Summary was provided.", "No content available to send to the AI provider.");
    }

    const provider = getActiveProvider();
    const { quiz } = await provider.processLesson({ title: note.title, transcript, summary: note.body });

    db.prepare(
      `INSERT OR REPLACE INTO ai_quiz_cache
       (course_id, lesson_id, questions, source, provider, model, transcript_version, summary_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      note.course_id,
      videoLessonId(noteId),
      JSON.stringify(quiz),
      provider.name.toLowerCase(),
      provider.name,
      provider.model || null,
      transcriptVersion,
      note.summary_version || 0
    );

    db.prepare("UPDATE notes SET ai_status = 'completed', ai_error = NULL, ai_error_detail = NULL WHERE id = ?").run(noteId);
    return { ok: true };
  } catch (e) {
    const friendly = e.message || "AI quiz generation failed.";
    const detail = e.detail || friendly; // raw provider error, stored for troubleshooting
    db.prepare("UPDATE notes SET ai_status = 'failed', ai_error = ?, ai_error_detail = ? WHERE id = ?").run(friendly, detail, noteId);
    return { ok: false, error: friendly };
  }
}

// Called on edit when the video, transcript, or Lesson Summary changes:
// invalidates the previous quiz immediately (status -> pending, cache
// cleared) so no stale quiz is served while it's reprocessed.
function invalidateVideoLessonQuiz(note) {
  db.prepare("DELETE FROM ai_quiz_cache WHERE course_id = ? AND lesson_id = ?").run(note.course_id, videoLessonId(note.id));
  db.prepare("UPDATE notes SET ai_status = 'pending', ai_error = NULL, ai_error_detail = NULL WHERE id = ?").run(note.id);
}

module.exports = {
  generateQuiz,
  generateNoteQuiz,
  generateSkillsSummary,
  getStoredQuiz,
  processVideoLessonNote,
  invalidateVideoLessonQuiz,
  videoLessonId,
};
