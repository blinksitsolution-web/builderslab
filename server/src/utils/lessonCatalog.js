const db = require("../db/db");
const { lessonsForCourse } = require("../data/lessons");

// Instructor-posted video lessons behave like real timed videos once merged
// into "My Lessons" — we don't call the YouTube Data API for their real
// duration, so we use a conservative placeholder. The player's "video ended"
// handler always marks a lesson fully watched regardless of this number, so
// it only affects the progress bar, never completion/unlock correctness.
const NOTE_VIDEO_DURATION_SEC = 600;

const VIDEO_NOTE_PREFIX = "vlesson:";
function isVideoNoteItem(itemId) {
  return typeof itemId === "string" && itemId.startsWith(VIDEO_NOTE_PREFIX);
}
function videoNoteLessonId(noteId) {
  return `${VIDEO_NOTE_PREFIX}${noteId}`;
}
function videoNoteId(lessonId) {
  return lessonId.slice(VIDEO_NOTE_PREFIX.length);
}

// Same YouTube URL formats the frontend's videoEmbedUrl() recognizes, but
// returns the bare video ID (what the existing YT.Player lesson viewer needs).
function extractYoutubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtube.com") {
      const id = u.searchParams.get("v");
      if (id) return id;
      const parts = u.pathname.split("/").filter(Boolean);
      if ((parts[0] === "embed" || parts[0] === "shorts") && parts[1]) return parts[1];
    }
    if (host === "youtu.be" && u.pathname.length > 1) return u.pathname.slice(1);
  } catch (e) { /* not a valid absolute URL */ }
  return null;
}

// Instructor-posted video_lesson notes for this module, visible to the given
// viewer — same campus/class targeting rules used everywhere else in the
// portal — reshaped to the exact {id, title, youtubeId, durationSec,
// resources} shape the curated catalog already uses. Non-YouTube video URLs
// are skipped here (they still show under "Video lessons from your
// instructors", just not in the timed-lesson player).
function videoLessonEntriesForCourse(courseId, viewer) {
  const notes = db
    .prepare(
      `SELECT * FROM notes WHERE course_id = ? AND kind = 'video_lesson'
       AND (class_id IS NULL OR class_id = ?)
       AND (target = 'all' OR target = ?)
       ORDER BY date ASC`
    )
    .all(courseId, viewer.classId || null, viewer.campus || null);
  return notes
    .map((n) => {
      const youtubeId = extractYoutubeId(n.video_url || "");
      if (!youtubeId) return null;
      return {
        id: videoNoteLessonId(n.id),
        title: n.title,
        youtubeId,
        durationSec: NOTE_VIDEO_DURATION_SEC,
        resources: n.file_path ? [{ name: "Attached file", url: n.file_path }] : [],
      };
    })
    .filter(Boolean);
}

// Curated lessons (data/lessons.js) followed by instructor-posted video
// lessons for the same module, in posting order.
function getMergedLessons(courseId, viewer) {
  return [...lessonsForCourse(courseId), ...videoLessonEntriesForCourse(courseId, viewer)];
}
function getMergedLesson(courseId, lessonId, viewer) {
  return getMergedLessons(courseId, viewer).find((l) => l.id === lessonId) || null;
}
function getNextMergedLessonId(courseId, lessonId, viewer) {
  const lessons = getMergedLessons(courseId, viewer);
  const idx = lessons.findIndex((l) => l.id === lessonId);
  const next = lessons[idx + 1];
  return next ? next.id : lessonId;
}

// ---------------------------------------------------------------------
// Stage 4E — module content access gate.
//
// Before this, GET /:courseId/lessons (routes/modules.js) and the
// progress/quiz routes below it (routes/progress.js) only checked
// payment status (requireActiveAccess*) — never whether the caller is
// actually enrolled in that specific module at all. The learner-facing
// dashboard already only *displays* a module if it's in the learner's
// own `enrollments` row set (see useLearnerDashboard.js), but that's a
// UI-only filter: nothing stopped a signed-in learner from calling the
// same endpoint directly for a courseId they were never enrolled in and
// getting real lesson content back. This closes that gap server-side,
// which is the one place it can actually be enforced.
//
// `enrollments` (user_id, course_id) is the existing, already-populated
// source of truth for "this learner has this module" — every
// registration/add-child/participant-creation path already writes to it
// (see routes/auth.js and routes/users.js) — so this reuses it rather
// than inventing a second enrollment concept.
function isLearnerEnrolledInCourse(userId, courseId) {
  return !!db.prepare("SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?").get(userId, courseId);
}

// Caller-shaped variant for routes with no explicit :userId in the URL
// (the caller is always req.user — a learner viewing their own content,
// or a parent viewing on behalf of a linked child). Instructors/admins
// always pass, matching every other access gate in this app. A parent is
// allowed through if ANY linked child has the module — mirrors
// requireActiveAccessSelf's own "can't scope to one ward here" tradeoff
// (see middleware/auth.js) rather than inventing a stricter rule this
// one route alone would enforce.
function callerCanAccessCourse(user, courseId) {
  if (!user) return false;
  if (user.role === "instructor" || user.role === "admin") return true;
  if (user.role === "learner") return isLearnerEnrolledInCourse(user.id, courseId);
  if (user.role === "parent") {
    return !!db
      .prepare("SELECT 1 FROM enrollments e JOIN users u ON u.id = e.user_id WHERE u.parent_id = ? AND e.course_id = ?")
      .get(user.id, courseId);
  }
  return false;
}

module.exports = {
  isVideoNoteItem,
  videoNoteId,
  getMergedLessons,
  getMergedLesson,
  getNextMergedLessonId,
  extractYoutubeId,
  isLearnerEnrolledInCourse,
  callerCanAccessCourse,
};
