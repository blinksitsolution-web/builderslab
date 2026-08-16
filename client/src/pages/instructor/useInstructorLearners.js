import { useCallback, useEffect, useState } from "react";
import { searchLearners, fetchCampuses } from "../../api/instructor";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { useMyTeachingContext } from "./useMyTeachingContext";

/**
 * My Learners — migrates legacy instructorLearners() / filterLearners()
 * (dashboard.html). GET /api/users is already scoped server-side to this
 * instructor's assigned classes/adult-learner modules (see
 * server/src/routes/users.js) — search/campus/class here are just
 * narrowing filters within that scope, not the authorization boundary.
 */
export function useInstructorLearners() {
  const { user: authUser, refresh } = useAuth();
  const teaching = useMyTeachingContext();
  const [status, setStatus] = useState("loading");
  const [learners, setLearners] = useState([]);
  const [campuses, setCampuses] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [search, setSearch] = useState("");
  const [campus, setCampus] = useState("");
  const [classId, setClassId] = useState("");

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    try {
      const [learnerRows, campusRows] = await Promise.all([
        searchLearners({ search: search || undefined, campus: campus || undefined, class: classId || undefined }),
        fetchCampuses(),
      ]);
      setLearners(learnerRows);
      setCampuses(campusRows);
      setStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setErrorMessage(e.message);
      setStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, refresh, search, campus, classId]);

  useEffect(() => {
    load();
  }, [load]);

  return { teaching, status, learners, campuses, errorMessage, search, setSearch, campus, setCampus, classId, setClassId, reload: load };
}
