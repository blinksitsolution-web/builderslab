/* ==========================================================================
   Instructor dashboard API methods (Phase 7). Deliberately minimal — only
   the calls the legacy instructorOverview() renderer makes
   (dashboard.html, see Phase 1 analysis), plus the two "assigned teaching
   context" endpoints (/modules/mine, /classes/mine) already used
   elsewhere in the legacy instructor screens (e.g. the Notes cascade) and
   explicitly invited by Phase 7 section 5. Same paths, methods, and
   response shapes as api.js's DTL.allUsers / DTL.allProjects / DTL.notes /
   DTL.myModules / DTL.myClasses.

   Every backend boundary below is enforced server-side, not re-derived
   here:
     - GET /api/users, GET /api/projects: role-gated to instructor/admin,
       genuinely unscoped by design (any instructor may see every learner
       / every submission — see server/src/routes/users.js and
       projects.js) — this is real backend-granted authorization, not a
       leak this migration introduces.
     - GET /api/notes: auto-scoped server-side to `posted_by = req.user.name`
       for an instructor caller (server/src/routes/notes.js — "Instructor
       Content Ownership") — an instructor can only ever see their own
       posts through this endpoint, enforced by the server regardless of
       what query params are sent.
     - GET /api/modules/mine, GET /api/classes/mine: scoped server-side to
       rows in instructor_modules / instructor_classes for this instructor.
   ========================================================================== */
import { apiGet, apiPost, apiPatch, apiDelete } from "./client";
import { notifyMessagesRead } from "./notificationEvents";

export async function fetchLearners() {
  const { users } = await apiGet("/api/users?role=learner");
  return users;
}

// Same GET /api/users endpoint as fetchLearners, just role=parent — used to
// build the Messages contact list (legacy instructorMessages() draws
// parent contacts from the same unscoped allUsers() call).
export async function fetchParents() {
  const { users } = await apiGet("/api/users?role=parent");
  return users;
}

// Promotion Subsystem (ABRS v2.1 §12) — instructor recommendation for a
// learner currently in one of the instructor's assigned classes. Same
// POST /api/promotion/recommend endpoint api/admin.js's
// submitPromotionRecommendation calls; kept as its own wrapper here so
// instructor pages import from api/instructor.js like everything else
// they use, matching this file's existing convention. The server derives
// the learner's class_id itself and rejects (403) if the instructor isn't
// assigned to it — see routes/promotion.js.
export async function submitPromotionRecommendation({ learnerId, recommends, note }) {
  return apiPost("/api/promotion/recommend", { learnerId, recommends, note });
}

export async function fetchAllProjects() {
  const { projects } = await apiGet("/api/projects");
  return projects;
}

export async function fetchMyNotes() {
  const { notes } = await apiGet("/api/notes");
  return notes;
}

export async function fetchMyModules() {
  const { courses } = await apiGet("/api/modules/mine");
  return courses;
}

export async function fetchMyClasses() {
  const { classes } = await apiGet("/api/classes/mine");
  return classes;
}

/* --------------------------------------------------------------------------
   Phase 12 additions below. Every method is a thin wrapper matching the
   legacy DTL.* method of the same purpose (see api.js) — same endpoint,
   HTTP verb, request shape and response shape. No new business rules.
   -------------------------------------------------------------------------- */

// ---- teaching context / learner directory ---------------------------------

export async function fetchCampuses() {
  const { campuses } = await apiGet("/api/modules/campuses/mine");
  return campuses;
}

// GET /api/users already scopes results server-side (role/search/campus/class
// filters are just narrowing, not the authorization boundary — see
// server/src/routes/users.js).
export async function searchLearners(filters = {}) {
  const params = { role: "learner", ...filters };
  Object.keys(params).forEach((k) => (params[k] === undefined || params[k] === "") && delete params[k]);
  const qs = new URLSearchParams(params).toString();
  const { users } = await apiGet(`/api/users${qs ? `?${qs}` : ""}`);
  return users;
}

export async function fetchUser(userId) {
  const { user } = await apiGet(`/api/users/${userId}`);
  return user;
}

// ---- notes / assignments / video lessons -----------------------------------

export async function createNote({ module, classId, title, body, target, kind, videoUrl, topic, learningInstanceId, aiQuizEnabled, file }) {
  const fd = new FormData();
  // Pre-existing bug fix (unrelated to concurrent Programme Runs — same
  // key-mismatch class found and fixed in createExam/createContinuousAssessment
  // above): server/src/routes/notes.js's POST / reads req.body.courseId
  // and 400s without it ("module, class, title and body are required."),
  // but this was only ever sending "module".
  fd.append("module", module);
  fd.append("courseId", module);
  fd.append("classId", classId);
  fd.append("title", title);
  fd.append("body", body);
  fd.append("target", target || "all");
  fd.append("kind", kind || "note");
  if (videoUrl) fd.append("videoUrl", videoUrl);
  if (topic) fd.append("topic", topic);
  if (file) fd.append("file", file);
  if (learningInstanceId) fd.append("learningInstanceId", learningInstanceId);
  fd.append("aiQuizEnabled", aiQuizEnabled ? "true" : "false");
  return apiPost("/api/notes", fd, { isForm: true });
}

export async function updateNote(noteId, { module, classId, title, body, target, kind, videoUrl, topic, learningInstanceId, aiQuizEnabled, file }) {
  const fd = new FormData();
  // Same pre-existing courseId/module key mismatch fixed in createNote above.
  if (module) {
    fd.append("module", module);
    fd.append("courseId", module);
  }
  if (classId) fd.append("classId", classId);
  if (title) fd.append("title", title);
  if (body) fd.append("body", body);
  if (target) fd.append("target", target);
  if (kind) fd.append("kind", kind);
  if (videoUrl) fd.append("videoUrl", videoUrl);
  if (topic) fd.append("topic", topic);
  if (file) fd.append("file", file);
  if (learningInstanceId !== undefined) fd.append("learningInstanceId", learningInstanceId || "");
  if (aiQuizEnabled !== undefined) fd.append("aiQuizEnabled", aiQuizEnabled ? "true" : "false");
  return apiPatch(`/api/notes/${noteId}`, fd, { isForm: true });
}

export async function deleteNote(noteId) {
  return apiDelete(`/api/notes/${noteId}`);
}

export async function publishNote(noteId) {
  return apiPost(`/api/notes/${noteId}/publish`);
}

export async function unpublishNote(noteId) {
  return apiPost(`/api/notes/${noteId}/unpublish`);
}

export async function reprocessNote(noteId) {
  return apiPost(`/api/notes/${noteId}/reprocess`);
}

export async function fetchAssignmentSubmissions(noteId) {
  const { submissions } = await apiGet(`/api/assignments/${noteId}`);
  return submissions;
}

export async function gradeAssignment(submissionId, grade, feedback) {
  return apiPatch(`/api/assignments/submission/${submissionId}/grade`, { grade, feedback });
}

// ---- monthly topics (read-ahead) -------------------------------------------

export async function fetchTopics(moduleId, { classId, learningInstanceId } = {}) {
  const params = new URLSearchParams();
  if (classId) params.set("classId", classId);
  if (learningInstanceId) params.set("learningInstanceId", learningInstanceId);
  const qs = params.toString();
  const { topics } = await apiGet(`/api/topics/${moduleId}${qs ? `?${qs}` : ""}`);
  return topics;
}

export async function createTopic({ moduleId, monthLabel, title, body, file, classId, learningInstanceId }) {
  const fd = new FormData();
  // Pre-existing bug fix (same class found in createExam/createNote/etc.
  // above): server/src/routes/topics.js's POST / reads req.body.courseId.
  fd.append("moduleId", moduleId);
  fd.append("courseId", moduleId);
  fd.append("monthLabel", monthLabel);
  fd.append("title", title);
  if (body) fd.append("body", body);
  if (file) fd.append("file", file);
  if (classId) fd.append("classId", classId);
  if (learningInstanceId) fd.append("learningInstanceId", learningInstanceId);
  return apiPost("/api/topics", fd, { isForm: true });
}

export async function deleteTopic(topicId) {
  return apiDelete(`/api/topics/${topicId}`);
}

export async function setTopicCompleted(topicId, completed) {
  return apiPatch(`/api/topics/${topicId}/complete`, { completed });
}

// ---- projects / grading -----------------------------------------------------

export async function gradeProject(projectId, grade, mark, feedback) {
  return apiPatch(`/api/projects/${projectId}/grade`, { grade, mark, feedback });
}

// ---- attendance --------------------------------------------------------------

export async function fetchAttendance(moduleId, date, audience) {
  const qs = new URLSearchParams({ date, ...(audience ? { audience } : {}) }).toString();
  const { attendance } = await apiGet(`/api/attendance/${moduleId}?${qs}`);
  return attendance;
}

export async function markAttendance({ moduleId, date, records, learningInstanceId }) {
  // Pre-existing bug fix (same class as above): server/src/routes/attendance.js's
  // POST / reads req.body.courseId.
  return apiPost("/api/attendance", { moduleId, courseId: moduleId, date, records, learningInstanceId: learningInstanceId || undefined });
}

// ---- messaging ----------------------------------------------------------------

export async function fetchThread(otherUserId) {
  const { messages } = await apiGet(`/api/messages/thread/${otherUserId}`);
  notifyMessagesRead();
  return messages;
}

export async function sendMessage({ to, body, subject }) {
  return apiPost("/api/messages", { to, body, subject });
}

export async function broadcastLearners({ subject, body, moduleId, campus, audience, learningInstanceId, classId }) {
  return apiPost("/api/messages/broadcast-learners", { subject, body, courseId: moduleId, campus, audience, learningInstanceId, classId });
}

/* --------------------------------------------------------------------------
   Phase 14 additions below — Instructor Examination / Continuous Assessment
   management. Every method is a thin wrapper matching the legacy DTL.*
   method of the same purpose (see api.js) — same endpoint, HTTP verb,
   request shape and response shape. The Phase 13 backend foundation
   (closing date/timed-attempt config, attempt lifecycle, violation
   tracking) is consumed as-is; none of those rules are reimplemented here.
   -------------------------------------------------------------------------- */

// ---- examinations (midterm / end of term / retake / final) ----------------

export async function createExam({ moduleId, classId, title, termType, questions, assignedLearnerIds, learningInstanceId, closesAt, timedEnabled, durationMinutes }) {
  // Pre-existing bug fix (unrelated to concurrent Programme Runs, found
  // while wiring the "which run?" picker through this exact call):
  // server/src/routes/exams.js's POST / reads req.body.courseId, but this
  // was sending `moduleId` — exam creation 400'd with "courseId... are
  // required" regardless of anything below. Sending both keeps this
  // function's own calling convention (moduleId) unchanged everywhere
  // else in the instructor UI while actually reaching the server.
  return apiPost("/api/exams", { moduleId, courseId: moduleId, classId, title, termType, questions, assignedLearnerIds, learningInstanceId, closesAt, timedEnabled, durationMinutes });
}

export async function fetchExamsForModule(moduleId, { classId } = {}) {
  // Same pre-existing moduleId/courseId key mismatch as createExam above
  // — server/src/routes/exams.js's GET / reads req.query.courseId. This
  // wasn't just returning empty: an unset/undefined courseId falls
  // through to that route's "no courseId -> return every examination in
  // the system" branch, so this was silently over-fetching, not just
  // failing.
  const params = new URLSearchParams();
  if (moduleId) params.set("courseId", moduleId);
  if (classId) params.set("classId", classId);
  const qs = params.toString();
  const { examinations } = await apiGet(qs ? `/api/exams?${qs}` : "/api/exams");
  return examinations;
}

// Instructor/admin view of every learner's attempt for one examination —
// includes in-progress/expired/violation status, not just final scores
// (see toPublicAttempt / GET /api/exams/:id/attempts).
export async function fetchExamAttempts(examId) {
  const { attempts } = await apiGet(`/api/exams/${examId}/attempts`);
  return attempts;
}

// Which examination type(s) this module supports — e.g. ["final"] only for
// Corporate Training/Bootcamp, else midterm/end_of_term/retake.
export async function fetchExamTermTypes(moduleId) {
  const { termTypes } = await apiGet(`/api/exams/term-types/${moduleId}`);
  return termTypes;
}

// Learners currently eligible for a Retake exam in this module (transcript
// interpretation = Retake for the active Academic Term).
export async function fetchRetakeEligibleLearners(moduleId) {
  const { learners } = await apiGet(`/api/exams/retake-eligible/${moduleId}`);
  return learners;
}

// ---- continuous assessments (independent of AI quizzes & examinations) ----

export async function createContinuousAssessment({ moduleId, noteId, title, questions, closesAt, timedEnabled, durationMinutes, learningInstanceId, classId }) {
  // Same pre-existing courseId/moduleId key mismatch fixed in createExam
  // above — server/src/routes/continuousAssessments.js's POST / also
  // reads req.body.courseId.
  return apiPost("/api/continuous-assessments", { moduleId, courseId: moduleId, noteId, title, questions, closesAt, timedEnabled, durationMinutes, learningInstanceId, classId });
}

export async function fetchContinuousAssessments({ moduleId, noteId, classId } = {}) {
  // Same pre-existing moduleId/courseId key mismatch — GET / here reads
  // req.query.courseId (and 400s outright when neither courseId nor
  // noteId is present, so the moduleId-only call always failed).
  const qs = noteId ? `noteId=${noteId}` : `courseId=${moduleId}`;
  const { assessments } = await apiGet(`/api/continuous-assessments?${qs}${classId ? `&classId=${classId}` : ""}`);
  return assessments;
}

export async function fetchContinuousAssessment(id) {
  return apiGet(`/api/continuous-assessments/${id}`);
}

export async function updateContinuousAssessment(id, { title, questions, closesAt, timedEnabled, durationMinutes }) {
  return apiPatch(`/api/continuous-assessments/${id}`, { title, questions, closesAt, timedEnabled, durationMinutes });
}

export async function deleteContinuousAssessment(id) {
  return apiDelete(`/api/continuous-assessments/${id}`);
}

export async function publishContinuousAssessment(id) {
  return apiPost(`/api/continuous-assessments/${id}/publish`);
}

export async function unpublishContinuousAssessment(id) {
  return apiPost(`/api/continuous-assessments/${id}/unpublish`);
}

export async function fetchContinuousAssessmentAttempts(id) {
  const { attempts } = await apiGet(`/api/continuous-assessments/${id}/attempts`);
  return attempts;
}
