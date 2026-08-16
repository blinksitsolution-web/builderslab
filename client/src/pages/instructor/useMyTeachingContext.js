import { useCallback, useEffect, useState } from "react";
import { fetchMyModules, fetchMyClasses } from "../../api/instructor";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Loads this instructor's assigned teaching context — GET /api/modules/mine
 * and GET /api/classes/mine, both scoped server-side to rows in
 * instructor_modules / instructor_classes for this instructor (see
 * api/instructor.js header comment). Shared by every Phase 12 screen that
 * needs a "which module/class am I working in" picker (Notes, Topics,
 * Attendance, Grading), so the same backend-granted scope — not a
 * client-side re-derivation of it — drives every dropdown consistently.
 */
export function useMyTeachingContext() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [modules, setModules] = useState([]);
  const [classes, setClasses] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    const [modulesResult, classesResult] = await Promise.allSettled([fetchMyModules(), fetchMyClasses()]);

    if ([modulesResult, classesResult].some((r) => r.status === "rejected" && isUnauthorizedError(r.reason))) {
      await refresh();
      return;
    }

    if (modulesResult.status === "rejected" || classesResult.status === "rejected") {
      setStatus("error");
      setErrorMessage((modulesResult.reason || classesResult.reason)?.message || "Couldn't load your teaching assignments.");
      return;
    }

    setModules(modulesResult.value);
    setClasses(classesResult.value);
    setStatus("ready");
  }, [authUser, refresh]);

  useEffect(() => {
    load();
  }, [load]);

  return { status, modules, classes, errorMessage, reload: load };
}
