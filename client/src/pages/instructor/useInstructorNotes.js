import { useCallback, useEffect, useState } from "react";
import { fetchMyNotes, fetchCampuses } from "../../api/instructor";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { useMyTeachingContext } from "./useMyTeachingContext";

/**
 * Notes & Assignments & Video Lessons (Phase 12). GET /api/notes is already
 * auto-scoped server-side to this instructor's own posts (Instructor
 * Content Ownership — see api/instructor.js header), so the list below is
 * never re-filtered client-side.
 */
export function useInstructorNotes() {
  const { user: authUser, refresh } = useAuth();
  const teaching = useMyTeachingContext();
  const [status, setStatus] = useState("loading");
  const [notes, setNotes] = useState([]);
  const [campuses, setCampuses] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    const [notesResult, campusesResult] = await Promise.allSettled([fetchMyNotes(), fetchCampuses()]);

    if ([notesResult, campusesResult].some((r) => r.status === "rejected" && isUnauthorizedError(r.reason))) {
      await refresh();
      return;
    }

    if (notesResult.status === "rejected") {
      setStatus("error");
      setErrorMessage(notesResult.reason?.message || "Couldn't load your notes.");
      return;
    }

    setNotes(notesResult.value);
    setCampuses(campusesResult.status === "fulfilled" ? campusesResult.value : []);
    setStatus("ready");
  }, [authUser, refresh]);

  useEffect(() => {
    load();
  }, [load]);

  return { status, errorMessage, notes, campuses, teaching, reload: load };
}
