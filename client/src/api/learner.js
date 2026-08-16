/* ==========================================================================
   Learner API methods (Phase 5 dashboard + Phase 10 lesson experience).
   Deliberately minimal — only endpoints the legacy learner screens
   actually call (dashboard.html's learnerOverview()/learnerLessons(),
   see Phase 1/10 analysis), not a port of every learner method in the
   legacy api.js. Same paths, HTTP methods, and response shapes as
   DTL.loadModules / DTL.lessonsFor / DTL.markWatched / DTL.fetchQuiz /
   DTL.submitQuiz. The user-fetch endpoint (GET /api/users/:id) lives in
   api/users.js since it's shared with the Parent dashboard.
   ========================================================================== */
import { apiGet, apiPost } from "./client";

/* --------------------------------------------------------------------------
   Phase 11 additions — Notes/Assignments, Course Topics, and Projects.
   Same endpoints/shapes as the legacy DTL.notes/topicsFor/submitAssignment/
   myAssignmentSubmissions/submitProject (see api.js), added here only now
   that the Learner-facing screens that call them are being migrated.
   -------------------------------------------------------------------------- */

// GET /api/modules — catalog of all modules (id, title, ...); not gated by
// access-restriction, used here only to resolve a module id to its title.
// The route returns { courses: [...] } (server/src/routes/modules.js) —
// destructure that key, not "modules".
export async function fetchModules() {
  const { courses } = await apiGet("/api/modules");
  return courses;
}

// GET /api/modules/:moduleId/lessons — requireActiveAccessSelf, so this
// can 403 with code:"ACCESS_RESTRICTED" for a payment-restricted learner.
// Callers must handle that rather than treating a 403 as "no lessons"
// (see useModuleLessons.js / LearnerDashboard.jsx).
export async function fetchLessonsForModule(moduleId) {
  const { lessons } = await apiGet(`/api/modules/${moduleId}/lessons`);
  return lessons;
}

// POST /api/progress/:userId/watch — server-authoritative: the backend
// clamps `seconds` to the lesson's real duration and never lets watched
// time move backwards, so this call cannot be used to fabricate
// completion client-side. Returns { ok, watchedSeconds, complete }.
export async function markWatched(userId, moduleId, lessonId, seconds) {
  // Pre-existing bug fix (same class found throughout instructor.js): this
  // was sending `moduleId`, but server/src/routes/progress.js's POST
  // /:userId/watch reads req.body.courseId — every watch-progress update
  // was 403'ing as "This learner isn't enrolled in this module" since
  // courseId was always undefined. High-impact: this is the endpoint
  // called continuously while watching any video lesson.
  return apiPost(`/api/progress/${userId}/watch`, { moduleId, courseId: moduleId, lessonId, seconds });
}

// GET /api/progress/quiz/:moduleId/:lessonId — questions without answers
// (grading happens server-side). Also requireActiveAccessSelf-gated.
export async function fetchQuiz(moduleId, lessonId) {
  const { questions } = await apiGet(`/api/progress/quiz/${moduleId}/${lessonId}`);
  return questions;
}

// POST /api/progress/:userId/quiz/:moduleId/:lessonId/submit — grades
// server-side and, on a passing score, unlocks the next lesson itself
// (nothing about unlock logic is re-derived client-side). Returns
// { ok, score, unlocked, correctAnswers }.
export async function submitQuiz(userId, moduleId, lessonId, answers) {
  return apiPost(`/api/progress/${userId}/quiz/${moduleId}/${lessonId}/submit`, { answers });
}

// POST /api/progress/:userId/read/:moduleId/:noteId — a Note's equivalent
// of "finished watching": one-click acknowledgement so its AI quiz (if
// any) unlocks via the same watched-seconds/quiz plumbing as a video
// lesson (see progress.js noteLessonId()). Distinct from markWatched.
export async function markNoteRead(userId, moduleId, noteId) {
  return apiPost(`/api/progress/${userId}/read/${moduleId}/${noteId}`);
}

// GET /api/notes — every Note/Assignment/Video-lesson post visible to the
// current role (learners only ever get published posts; see notes.js).
// No query params here, matching legacy DTL.notes() with no args — the
// module/campus/class relevance filtering happens client-side exactly as
// it already did (see relevantNotesForLearner in dashboard.html), since
// that was never the backend's access boundary; the backend's actual
// authority is the requireActiveAccessSelf gate on this same route.
export async function fetchNotes() {
  const { notes } = await apiGet("/api/notes");
  return notes;
}

// POST /api/assignments/:noteId/submit — text and/or file. Resubmitting
// (same learner, same note) overwrites the previous submission and clears
// any prior grade/feedback server-side, exactly as before.
export async function submitAssignment(noteId, { textContent, file } = {}) {
  const fd = new FormData();
  if (textContent) fd.append("textContent", textContent);
  if (file) fd.append("file", file);
  return apiPost(`/api/assignments/${noteId}/submit`, fd, { isForm: true });
}

// GET /api/assignments/mine/:userId — every submission this learner has
// made, so Notes can show "submitted"/"graded" status per assignment.
export async function fetchMyAssignmentSubmissions(userId) {
  const { submissions } = await apiGet(`/api/assignments/mine/${userId}`);
  return submissions;
}

// GET /api/topics/:moduleId — the "read ahead" Course Topics for one
// module (month label, title, body, optional file, completed state).
export async function fetchTopicsForModule(moduleId) {
  const { topics } = await apiGet(`/api/topics/${moduleId}`);
  return topics;
}

// GET /api/progress/:userId/monthly — per-month lesson-completion % plus
// a term total, for the progress chart above the topics list.
export async function fetchMonthlyProgress(userId) {
  return apiGet(`/api/progress/${userId}/monthly`);
}

// POST /api/projects/:userId — open-ended learner project/media
// submission (distinct from instructor-assigned Assignments above).
export async function submitProject(userId, { moduleId, title, description, file } = {}) {
  const fd = new FormData();
  // Pre-existing bug fix (same class as markWatched above):
  // server/src/routes/projects.js's POST /:userId reads req.body.courseId.
  fd.append("moduleId", moduleId);
  fd.append("courseId", moduleId);
  fd.append("title", title);
  if (description) fd.append("description", description);
  if (file) fd.append("media", file);
  return apiPost(`/api/projects/${userId}`, fd, { isForm: true });
}

/* --------------------------------------------------------------------------
   Phase 15 additions below — Learner Examination / Continuous Assessment
   taking experience. Every method is a thin wrapper over the same Phase 13
   backend endpoints the Phase 14 instructor API module (api/instructor.js)
   already consumes for reading/managing assessments — request shapes,
   response shapes, and error behavior are preserved exactly (see
   FIX_NOTES_exam_ca_closing_timer_violation_controls.md). Nothing about
   eligibility, deadlines, violation counting, or grading is reimplemented
   here; these calls only relay to/from the server, which remains the sole
   authority throughout.
   -------------------------------------------------------------------------- */

// ---- examinations -----------------------------------------------------

// GET /api/exams?courseId= — scoped per-module, matching the legacy
// learnerExams()'s per-enrolled-module fetch (a courseId-less call would
// return every examination system-wide, not just this learner's modules —
// see server/src/routes/exams.js's GET / handler).
export async function fetchExamsForModule(moduleId) {
  // Pre-existing bug fix: this was sending `?moduleId=`, but the server
  // route reads req.query.courseId — meaning this call was hitting
  // exactly the "moduleId-less call returns every examination
  // system-wide" case the comment above warns about. Every learner was
  // seeing every exam in the system, not just their own module's.
  const { examinations } = await apiGet(`/api/exams?courseId=${encodeURIComponent(moduleId)}`);
  return examinations;
}

// GET /api/exams/:id — full question detail (no answer key for a
// learner) plus this learner's own myAttempt. Never creates an attempt.
export async function fetchExam(examId) {
  return apiGet(`/api/exams/${examId}`);
}

// POST /api/exams/:id/start — idempotent create-or-resume. The server
// computes and freezes the deadline; this call never does.
export async function startExamAttempt(examId) {
  return apiPost(`/api/exams/${examId}/start`);
}

// POST /api/exams/:id/answers — autosave only; never grades or ends
// anything itself (see assessmentTiming.js / FIX_NOTES).
export async function saveExamAnswers(examId, answers) {
  return apiPost(`/api/exams/${examId}/answers`, { answers });
}

// POST /api/exams/:id/violation — reports a detected tab/window-visibility
// loss. The server alone decides warn vs. terminate.
export async function reportExamViolation(examId, answers) {
  return apiPost(`/api/exams/${examId}/violation`, { answers });
}

// POST /api/exams/:id/attempt — final submission (also used for the
// silent auto-submit on client-observed expiry; the server re-checks
// expiry itself regardless of what the client believes).
export async function submitExamAttempt(examId, answers) {
  return apiPost(`/api/exams/${examId}/attempt`, { answers });
}

// ---- continuous assessments --------------------------------------------

// GET /api/continuous-assessments?courseId= — published-only for a
// learner, each entry carrying attempted/myAttempt/completedLesson (the
// video-lesson/note prerequisite gate) exactly as the backend computes it.
export async function fetchContinuousAssessmentsForModule(moduleId) {
  // Pre-existing bug fix: this was sending `?moduleId=`, but the server
  // route reads req.query.courseId and 400s outright when neither
  // courseId nor noteId is present ("courseId or noteId is required.") —
  // this call was hard-failing every time.
  const { assessments } = await apiGet(`/api/continuous-assessments?courseId=${encodeURIComponent(moduleId)}`);
  return assessments;
}

// GET /api/continuous-assessments/:id — full detail, no answer key for a
// learner. Never creates an attempt.
export async function fetchContinuousAssessment(id) {
  return apiGet(`/api/continuous-assessments/${id}`);
}

// POST /api/continuous-assessments/:id/start — idempotent create-or-resume.
export async function startCaAttempt(id) {
  return apiPost(`/api/continuous-assessments/${id}/start`);
}

// POST /api/continuous-assessments/:id/answers — autosave only.
export async function saveCaAnswers(id, answers) {
  return apiPost(`/api/continuous-assessments/${id}/answers`, { answers });
}

// POST /api/continuous-assessments/:id/violation
export async function reportCaViolation(id, answers) {
  return apiPost(`/api/continuous-assessments/${id}/violation`, { answers });
}

// POST /api/continuous-assessments/:id/attempt — final submission.
export async function submitCaAttempt(id, answers) {
  return apiPost(`/api/continuous-assessments/${id}/attempt`, { answers });
}
