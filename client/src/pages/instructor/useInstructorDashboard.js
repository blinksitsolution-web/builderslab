import { useCallback, useEffect, useState } from "react";
import { fetchLearners, fetchAllProjects, fetchMyNotes, fetchMyModules, fetchMyClasses } from "../../api/instructor";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

const EMPTY_SECTION = { status: "loading", value: null, error: null };

/**
 * Reproduces the data legacy instructorOverview() assembles (see Phase 1
 * — dashboard.html: total learners, projects awaiting grading, notes
 * posted), plus the assigned-teaching-context data (myModules/myClasses)
 * already used elsewhere in the legacy instructor screens. All five
 * requests are independent and run in parallel via Promise.allSettled —
 * one failing section (e.g. a transient 500 on /api/projects) shows an
 * inline error for that section only, never blanks the rest of the
 * dashboard (Phase 7 section 10).
 */
export function useInstructorDashboard() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [learners, setLearners] = useState(EMPTY_SECTION);
  const [projects, setProjects] = useState(EMPTY_SECTION);
  const [notes, setNotes] = useState(EMPTY_SECTION);
  const [modules, setModules] = useState(EMPTY_SECTION);
  const [classes, setClasses] = useState(EMPTY_SECTION);

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setLearners(EMPTY_SECTION);
    setProjects(EMPTY_SECTION);
    setNotes(EMPTY_SECTION);
    setModules(EMPTY_SECTION);
    setClasses(EMPTY_SECTION);

    const [learnersResult, projectsResult, notesResult, modulesResult, classesResult] = await Promise.allSettled([
      fetchLearners(),
      fetchAllProjects(),
      fetchMyNotes(),
      fetchMyModules(),
      fetchMyClasses(),
    ]);

    const allErrors = [learnersResult, projectsResult, notesResult, modulesResult, classesResult]
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason);

    // A session that expired mid-visit will 401 every one of these at
    // once — treat that as a session problem, not five separate section
    // errors. Once AuthContext reflects unauthenticated, ProtectedRoute
    // redirects to /app/login on its own.
    if (allErrors.length > 0 && allErrors.every(isUnauthorizedError)) {
      await refresh();
      return;
    }

    const toSection = (result) =>
      result.status === "fulfilled"
        ? { status: "ready", value: result.value, error: null }
        : { status: "error", value: null, error: result.reason?.message || "Couldn't load this." };

    setLearners(toSection(learnersResult));
    setProjects(toSection(projectsResult));
    setNotes(toSection(notesResult));
    setModules(toSection(modulesResult));
    setClasses(toSection(classesResult));

    // Only the top-level view goes to a full-page error state if every
    // single section failed — otherwise render with whatever succeeded.
    setStatus(allErrors.length === 5 ? "error" : "ready");
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  return { status, learners, projects, notes, modules, classes, reload: load };
}
