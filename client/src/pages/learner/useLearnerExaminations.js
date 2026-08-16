import { useCallback, useEffect, useState } from "react";
import { fetchModules, fetchExamsForModule } from "../../api/learner";
import { fetchUser } from "../../api/users";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Mirrors legacy learnerExams()'s data assembly (see dashboard.html):
 * fetch the learner's own fresh enrolled-module list, then one
 * GET /api/exams?moduleId= per module (retake exams the learner wasn't
 * assigned to are already filtered out server-side — see
 * visibleToLearner() in exams.js). A restricted account naturally yields
 * zero enrolled modules (GET /api/users/:id redacts `modules` to [] for a
 * restricted self-view — see userView.js), so no per-module call happens
 * at all; the restriction is still shown explicitly via
 * `accessRestricted` rather than presented as "no exams".
 */
export function useLearnerExaminations() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [errorMessage, setErrorMessage] = useState(null);
  const [accessRestricted, setAccessRestricted] = useState(false);
  const [exams, setExams] = useState([]);
  const [moduleTitles, setModuleTitles] = useState({});

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const [freshUser, allModules] = await Promise.all([fetchUser(authUser.id), fetchModules()]);
      setAccessRestricted(!!freshUser.accessRestricted);
      setModuleTitles(Object.fromEntries(allModules.map((m) => [m.id, m.title])));

      const enrolledIds = freshUser.courseIds || [];
      const lists = await Promise.all(
        enrolledIds.map(async (moduleId) => {
          try {
            return await fetchExamsForModule(moduleId);
          } catch (err) {
            // A single restricted/unavailable module shouldn't blank the
            // rest of the list — isolate it, same defensive pattern as
            // useModuleLessons.js.
            return [];
          }
        })
      );
      setExams(lists.flat());
      setStatus("ready");
    } catch (err) {
      if (isUnauthorizedError(err)) {
        await refresh();
        return;
      }
      if (isAccessRestrictedError(err)) {
        setAccessRestricted(true);
        setExams([]);
        setStatus("ready");
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Something went wrong loading your examinations.");
      setStatus("error");
    }
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  return { status, errorMessage, accessRestricted, exams, moduleTitles, reload: load };
}
