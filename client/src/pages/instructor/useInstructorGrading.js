import { useCallback, useEffect, useState } from "react";
import { fetchAllProjects } from "../../api/instructor";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { useMyTeachingContext } from "./useMyTeachingContext";

/**
 * Grade Projects — migrates legacy instructorGrading() (dashboard.html).
 * GET /api/projects is genuinely unscoped for instructor/admin by design
 * (see api/instructor.js header) — every submission is fetched, then
 * optionally narrowed to one module client-side, exactly like the legacy
 * screen's own moduleId filter.
 *
 * Extended (instructor-portal filter consistency pass) with Class and Run
 * filters, same as Topics/Attendance/Examinations. A project has no class
 * of its own (it's a learner's own submission) — classFilter narrows by
 * the submitting learner's own class instead (learnerClassId, joined in
 * by routes/projects.js). Run narrows by the submission's own
 * learning_instance_id.
 */
export function useInstructorGrading() {
  const { user: authUser, refresh } = useAuth();
  const teaching = useMyTeachingContext();
  const [status, setStatus] = useState("loading");
  const [projects, setProjects] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [moduleFilter, setModuleFilter] = useState("");
  const [classFilter, setClassFilter] = useState("");
  const [instanceFilter, setInstanceFilter] = useState("");

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    try {
      const rows = await fetchAllProjects();
      setProjects(rows);
      setStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [authUser, refresh]);

  useEffect(() => {
    load();
  }, [load]);

  let visibleProjects = projects;
  if (moduleFilter) visibleProjects = visibleProjects.filter((p) => p.course_id === moduleFilter);
  if (classFilter) visibleProjects = visibleProjects.filter((p) => p.learnerClassId === classFilter);
  if (instanceFilter) visibleProjects = visibleProjects.filter((p) => p.learning_instance_id === instanceFilter);

  // Every Run the currently-selected module is eligible for, so the Run
  // filter only ever offers choices that are actually relevant — same
  // source (teaching.modules[].eligibleInstances) Topics/Examinations use.
  const eligibleInstances = moduleFilter ? teaching.modules.find((m) => m.id === moduleFilter)?.eligibleInstances || [] : [];

  return {
    teaching,
    status,
    projects: visibleProjects,
    errorMessage,
    moduleFilter,
    setModuleFilter,
    classFilter,
    setClassFilter,
    instanceFilter,
    setInstanceFilter,
    eligibleInstances,
    reload: load,
  };
}
