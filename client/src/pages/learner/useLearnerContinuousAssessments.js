import { useCallback, useEffect, useState } from "react";
import { fetchModules, fetchContinuousAssessmentsForModule } from "../../api/learner";
import { fetchUser } from "../../api/users";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * New standalone Continuous Assessment browsing entry point (Phase 15) —
 * the legacy frontend only ever surfaced Continuous Assessments inline
 * beneath their gating video lesson/note (renderCaGate/renderNoteCaGate in
 * dashboard.html); this hook reproduces the same eligibility data
 * (published-only, `completedLesson` gate, `myAttempt`) the backend
 * already computes, just aggregated across every enrolled module in one
 * place. GET /api/continuous-assessments requires a moduleId or noteId
 * (see continuousAssessments.js), so — same as useLearnerExaminations.js —
 * this fetches one page per enrolled module rather than a single unscoped
 * call (no such call exists).
 */
export function useLearnerContinuousAssessments() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [errorMessage, setErrorMessage] = useState(null);
  const [accessRestricted, setAccessRestricted] = useState(false);
  const [assessments, setAssessments] = useState([]);
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
            return await fetchContinuousAssessmentsForModule(moduleId);
          } catch (err) {
            return [];
          }
        })
      );
      setAssessments(lists.flat());
      setStatus("ready");
    } catch (err) {
      if (isUnauthorizedError(err)) {
        await refresh();
        return;
      }
      if (isAccessRestrictedError(err)) {
        setAccessRestricted(true);
        setAssessments([]);
        setStatus("ready");
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Something went wrong loading your Continuous Assessments.");
      setStatus("error");
    }
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  return { status, errorMessage, accessRestricted, assessments, moduleTitles, reload: load };
}
