import { useCallback, useEffect, useState } from "react";
import { fetchModules, fetchLessonsForModule } from "../../api/learner";
import { fetchUser } from "../../api/users";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
// Phase 2 — fetch the learner's own period payment status for the Dashboard
// context card (level + current period + payment status). Uses the same
// GET /api/payments/:userId/period-status endpoint LearnerPaymentsPage uses.
// fetchPeriodPaymentStatus lives in parent.js (it calls the same self-service
// endpoint — requireSelfParentOrStaff allows a learner to call it for themselves).
import { fetchPeriodPaymentStatus } from "../../api/parent";

/**
 * Reproduces the data legacy learnerOverview() assembles (see Phase 1 —
 * dashboard.html), with one deliberate addition: GET /api/users/:id
 * redacts modules/progress/projects/grades to empty whenever the learner
 * is access-restricted (see server/src/utils/userView.js) — so a
 * restricted learner's `enrolledIds` is already empty and no per-module
 * fetch happens at all. The per-module try/catch below is a defensive
 * fallback for the narrow race where restriction status changes between
 * the user fetch and a lesson fetch, isolating that one module rather
 * than blanking the whole dashboard — it isn't the primary path.
 *
 * Phase 2 addition: also fetches period payment status in parallel so the
 * Dashboard can show a level + current period + payment-status context
 * card for structured (term/semester) runs. Falls back to [] on error so
 * legacy monthly learners are completely unaffected.
 */
export function useLearnerDashboard() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [errorMessage, setErrorMessage] = useState(null);
  const [learner, setLearner] = useState(null);
  const [moduleSummaries, setModuleSummaries] = useState([]);
  // Phase 2 — period payments for the structured-run context card
  const [periodPayments, setPeriodPayments] = useState([]);

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      // Phase 2 — fetch period status in parallel; never block the dashboard
      // if the period-status endpoint fails (e.g. learner has no structured run).
      // fetchPeriodPaymentStatus returns the periodPayments array directly.
      const [freshUser, allModules, periodPaymentsResult] = await Promise.all([
        fetchUser(authUser.id),
        fetchModules(),
        fetchPeriodPaymentStatus(authUser.id).catch(() => []),
      ]);
      const enrolledIds = freshUser.courseIds || [];

      const summaries = await Promise.all(
        enrolledIds.map(async (moduleId) => {
          const meta = allModules.find((m) => m.id === moduleId);
          const grade = (freshUser.grades || {})[moduleId];
          const base = {
            id: moduleId,
            title: meta ? meta.title : moduleId,
            midterm: grade ? grade.midterm : null,
            endOfTerm: grade ? grade.endOfTerm : null,
          };
          try {
            const lessons = await fetchLessonsForModule(moduleId);
            const watched = ((freshUser.progress || {})[moduleId] || {}).watched || {};
            const watchedCount = Object.keys(watched).length;
            const pct = lessons.length ? Math.round((watchedCount / lessons.length) * 100) : 0;
            return { ...base, restricted: false, lessonCount: lessons.length, pct };
          } catch (err) {
            if (isAccessRestrictedError(err)) {
              return { ...base, restricted: true, lessonCount: null, pct: null };
            }
            // A single module's lesson fetch failing for an unexpected
            // reason shouldn't blank the rest of the dashboard — surface
            // it as "unavailable" for that module only.
            return { ...base, restricted: false, unavailable: true, lessonCount: null, pct: null };
          }
        })
      );

      setLearner(freshUser);
      setModuleSummaries(summaries);
      setPeriodPayments(Array.isArray(periodPaymentsResult) ? periodPaymentsResult : []);
      setStatus("ready");
    } catch (err) {
      if (isUnauthorizedError(err)) {
        // Session expired mid-visit — re-check auth; once AuthContext
        // flips to unauthenticated, ProtectedRoute redirects to /app/login
        // on its own. Nothing further to render here.
        await refresh();
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Something went wrong loading your dashboard.");
      setStatus("error");
    }
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  return { status, errorMessage, learner, moduleSummaries, periodPayments, reload: load };
}

