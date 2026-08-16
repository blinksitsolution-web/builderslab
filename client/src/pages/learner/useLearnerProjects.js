import { useCallback, useEffect, useState } from "react";
import { fetchModules } from "../../api/learner";
import { fetchUser } from "../../api/users";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Projects (open-ended learner media submissions, distinct from
 * instructor-assigned Assignments) are already embedded on the user
 * record by GET /api/users/:id (see userView.js getFullUser: `user.projects`),
 * the same data LearnerDashboard's "Recent submissions" already reads —
 * this hook just surfaces the full list plus the learner's enrolled
 * modules (for the submission form's module picker) rather than
 * duplicating a project-fetching endpoint that doesn't exist for
 * learners (GET /api/projects is instructor/admin-only; see projects.js).
 * A restricted learner already gets projects:[] and modules:[] back from
 * that same redaction, so no extra restriction handling is needed here.
 */
export function useLearnerProjects() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [errorMessage, setErrorMessage] = useState(null);
  const [learner, setLearner] = useState(null);
  const [enrolledModules, setEnrolledModules] = useState([]); // [{ id, title }]

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const [freshUser, allModules] = await Promise.all([fetchUser(authUser.id), fetchModules()]);
      const enrolledIds = freshUser.courseIds || [];
      setLearner(freshUser);
      setEnrolledModules(enrolledIds.map((mid) => allModules.find((m) => m.id === mid) || { id: mid, title: mid }));
      setStatus("ready");
    } catch (err) {
      if (isUnauthorizedError(err)) {
        await refresh();
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Something went wrong loading your projects.");
      setStatus("error");
    }
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  return { status, errorMessage, learner, enrolledModules, reload: load };
}
