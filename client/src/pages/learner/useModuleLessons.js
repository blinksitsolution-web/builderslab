import { useCallback, useEffect, useRef, useState } from "react";
import { fetchModules, fetchLessonsForModule } from "../../api/learner";
import { fetchUser } from "../../api/users";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Reproduces legacy renderLessonList()'s exact unlock/progress logic (see
 * Phase 10 analysis, dashboard.html): a lesson is "done" once its watched
 * seconds reach the lesson's duration; a lesson is unlocked if its index
 * is at or before the learner's `unlockedLesson` progress marker (index
 * -1 / not found defaults to only the first lesson being unlocked) — all
 * of this is display logic over data the backend already computed and
 * enforces server-side (progress/watch, progress/quiz endpoints);
 * nothing about *actual* access is decided here.
 *
 * A 403 ACCESS_RESTRICTED on the lessons fetch is tracked as its own
 * "restricted" status, distinct from "ready with zero lessons" — a
 * payment-restricted learner must never see "no lessons" where the truth
 * is "lessons are hidden until this is resolved."
 */
export function useModuleLessons(moduleId) {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "restricted" | "error"
  const [errorMessage, setErrorMessage] = useState(null);
  const [moduleTitle, setModuleTitle] = useState(moduleId);
  const [lessons, setLessons] = useState([]);
  // Bug fix ("clicking Play on a video refreshes and stops without
  // playing"): `reload` (this hook's `load`) is called every time
  // YouTubePlayer.jsx saves watch progress — a completely routine
  // background refresh, not a real navigation. This used to call
  // setStatus("loading") unconditionally on every single call, which
  // made LessonPage.jsx render a full-page Skeleton in place of
  // everything — including the mounted, actively-playing YouTubePlayer
  // — destroying its YT.Player instance mid-playback. Now the loading
  // skeleton only shows for the genuine first load (or a real
  // navigation to a different module, since moduleId is still an effect
  // dependency below); every subsequent call just swaps the data in
  // silently once it arrives, leaving the mounted player alone.
  const hasLoadedOnceRef = useRef(false);

  const load = useCallback(async () => {
    if (!authUser || !moduleId) return;
    if (!hasLoadedOnceRef.current) setStatus("loading");
    setErrorMessage(null);
    try {
      const [freshUser, allModules] = await Promise.all([fetchUser(authUser.id), fetchModules()]);
      const meta = allModules.find((m) => m.id === moduleId);
      setModuleTitle(meta ? meta.title : moduleId);

      const rawLessons = await fetchLessonsForModule(moduleId);
      const prog = (freshUser.progress || {})[moduleId] || { watched: {}, quizScores: {}, unlockedLesson: null };
      const unlockedIdx = rawLessons.findIndex((l) => l.id === prog.unlockedLesson);

      const enriched = rawLessons.map((l, i) => {
        const watchedSecs = (prog.watched || {})[l.id] || 0;
        return {
          ...l,
          watchedSecs,
          done: watchedSecs >= l.durationSec,
          isUnlocked: i <= (unlockedIdx === -1 ? 0 : unlockedIdx),
          quizScore: (prog.quizScores || {})[l.id] ?? null,
        };
      });

      setLessons(enriched);
      setStatus("ready");
      hasLoadedOnceRef.current = true;
    } catch (err) {
      if (isUnauthorizedError(err)) {
        await refresh();
        return;
      }
      if (isAccessRestrictedError(err)) {
        setStatus("restricted");
        hasLoadedOnceRef.current = true;
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Something went wrong loading this module.");
      setStatus("error");
      hasLoadedOnceRef.current = true;
    }
  }, [authUser, moduleId, refresh]);

  useEffect(() => {
    hasLoadedOnceRef.current = false;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id, moduleId]);

  return { status, errorMessage, moduleTitle, lessons, reload: load };
}
