import { useCallback, useEffect, useState } from "react";
import { fetchModules, fetchTopicsForModule, fetchMonthlyProgress } from "../../api/learner";
import { fetchUser } from "../../api/users";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Reproduces legacy renderTopicsAndProgress() (see Phase 1 analysis,
 * dashboard.html): per-module "read ahead" topics plus a term progress
 * chart. Course Topics themselves (GET /api/topics/:moduleId) are not
 * gated by requireActiveAccessSelf on the backend, but a restricted
 * learner already gets modules:[] from fetchUser, so no per-module topic
 * fetch happens at all for them — same redaction-driven gating as
 * useLearnerDashboard.js. The monthly progress chart *is* backend-gated
 * (requireActiveAccess), so it's fetched independently with its own
 * fallback rather than blanking the whole page on that one call failing
 * (mirrors legacy's `.catch()` on DTL.monthlyProgress, but distinguishes
 * a genuine restriction from an unrelated failure instead of swallowing
 * both the same way).
 */
export function useCourseTopics() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "restricted" | "error"
  const [errorMessage, setErrorMessage] = useState(null);
  const [moduleTopicGroups, setModuleTopicGroups] = useState([]); // [{ moduleId, moduleTitle, topics }]
  const [monthly, setMonthly] = useState({});
  const [termTotalPct, setTermTotalPct] = useState(0);
  const [progressUnavailable, setProgressUnavailable] = useState(false);

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const freshUser = await fetchUser(authUser.id);

      if (freshUser.accessRestricted) {
        setStatus("restricted");
        return;
      }

      const enrolledIds = freshUser.courseIds || [];
      const allModules = await fetchModules();

      const groups = await Promise.all(
        enrolledIds.map(async (moduleId) => {
          const meta = allModules.find((m) => m.id === moduleId);
          const topics = await fetchTopicsForModule(moduleId);
          return { moduleId, moduleTitle: meta ? meta.title : moduleId, topics };
        })
      );
      setModuleTopicGroups(groups);

      try {
        const monthlyResult = await fetchMonthlyProgress(authUser.id);
        setMonthly(monthlyResult.monthly || {});
        setTermTotalPct(monthlyResult.termTotalPct || 0);
        setProgressUnavailable(false);
      } catch (progErr) {
        // Doesn't block the topics list itself — see note above.
        setProgressUnavailable(true);
      }

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
      setErrorMessage(err && err.message ? err.message : "Something went wrong loading your course topics.");
      setStatus("error");
    }
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  return { status, errorMessage, moduleTopicGroups, monthly, termTotalPct, progressUnavailable, reload: load };
}
