import { useCallback, useEffect, useState } from "react";
import { fetchModules, fetchNotes, fetchMyAssignmentSubmissions } from "../../api/learner";
import { fetchUser } from "../../api/users";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Reproduces legacy relevantNotesForLearner() + learnerNotes() (see Phase 1
 * analysis, dashboard.html): a Note/Assignment is relevant to this learner
 * when its module is one the learner is enrolled in, its `target` is
 * "all" or matches the learner's campus, and it has no class restriction
 * or matches the learner's class — filtering that was always done
 * client-side in the legacy app (GET /api/notes itself has no such
 * filter; see notes.js), so this preserves rather than broadens that
 * behavior. Video lessons are excluded — they already surface inside the
 * Phase 10 Module Learning flow (see lessonCatalog.js), not here.
 *
 * A payment-restricted learner already gets modules:[] back from
 * fetchUser (see userView.js's redaction), so `relevant` naturally comes
 * back empty without any extra restriction handling — same pattern as
 * useLearnerDashboard.js.
 */
export function useLearnerNotes() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "restricted" | "error"
  const [errorMessage, setErrorMessage] = useState(null);
  const [learner, setLearner] = useState(null);
  const [modules, setModules] = useState([]);
  const [relevantNotes, setRelevantNotes] = useState([]);
  const [submissionsByNoteId, setSubmissionsByNoteId] = useState(new Map());

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const freshUser = await fetchUser(authUser.id);

      if (freshUser.accessRestricted) {
        setLearner(freshUser);
        setStatus("restricted");
        return;
      }

      const [allNotes, allModules, submissions] = await Promise.all([
        fetchNotes(),
        fetchModules(),
        fetchMyAssignmentSubmissions(authUser.id),
      ]);

      const enrolledIds = freshUser.courseIds || [];
      // notes.course_id (see server/src/routes/notes.js / the `notes` table)
      // is the actual field name — there is no `module_id` on a note. Using
      // the wrong name here made `enrolledIds.includes(...)` always false,
      // so no Note/Assignment ever reached a learner regardless of correct
      // enrollment or targeting.
      const relevant = allNotes.filter(
        (n) =>
          enrolledIds.includes(n.course_id) &&
          (n.target === "all" || n.target === freshUser.campus) &&
          (!n.class_id || n.class_id === freshUser.class_id) &&
          n.kind !== "video_lesson"
      );

      setLearner(freshUser);
      setModules(allModules);
      setRelevantNotes(relevant);
      setSubmissionsByNoteId(new Map(submissions.map((s) => [s.note_id, s])));
      setStatus("ready");
    } catch (err) {
      if (isUnauthorizedError(err)) {
        await refresh();
        return;
      }
      if (isAccessRestrictedError(err)) {
        setStatus("restricted");
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Something went wrong loading your notes and assignments.");
      setStatus("error");
    }
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  return { status, errorMessage, learner, modules, relevantNotes, submissionsByNoteId, reload: load };
}
