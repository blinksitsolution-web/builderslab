import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMyNotes, fetchContinuousAssessments } from "../../api/instructor";
import { useMyTeachingContext } from "./useMyTeachingContext";

/**
 * Instructor Continuous Assessment (Phase 14) — migrates legacy
 * openCaManager()/renderCaManagerModal() (dashboard.html) into a standalone
 * screen. A Continuous Assessment is always attached to one note/video
 * lesson (server/src/routes/continuousAssessments.js requires
 * `notes.kind IN ('video_lesson','note')`), so this hook layers a
 * note picker under the same module cascade the rest of the Instructor
 * portal uses — reusing GET /api/notes (already scoped server-side to this
 * instructor's own posts) rather than inventing a new endpoint.
 */
export function useInstructorContinuousAssessments() {
  const teaching = useMyTeachingContext();
  const [moduleId, setModuleId] = useState(null);
  const [notesStatus, setNotesStatus] = useState("idle");
  const [allNotes, setAllNotes] = useState([]);
  const [noteId, setNoteId] = useState(null);
  const [status, setStatus] = useState("idle"); // "idle" | "loading" | "ready" | "error" | "forbidden"
  const [assessments, setAssessments] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  // ABRS v2.2 amendment (concurrent Programme Runs) — same pattern as
  // useInstructorExams: the selected module's own `eligibleInstances`
  // (only present when this instructor has 2+ currently-Active Runs to
  // choose from for it).
  const [learningInstanceId, setLearningInstanceId] = useState(null);
  // Instructor-portal filter consistency pass: which Class this
  // Continuous Assessment is for — continuous_assessments had no class_id
  // at all until now (see migrate.js), unlike Notes/Examinations which
  // both already supported it. Defaults to "every class studying this
  // module" (null), same convention as those.
  const [classId, setClassId] = useState(null);

  useEffect(() => {
    if (teaching.status === "ready" && teaching.modules.length > 0 && !moduleId) {
      setModuleId(teaching.modules[0].id);
    }
  }, [teaching.status, teaching.modules, moduleId]);

  const selectedModule = teaching.modules.find((m) => m.id === moduleId) || null;
  const eligibleInstances = selectedModule?.eligibleInstances || [];

  useEffect(() => {
    if (eligibleInstances.length === 1) {
      setLearningInstanceId(eligibleInstances[0].id);
    } else {
      setLearningInstanceId(null);
    }
    setClassId(null);
  }, [moduleId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    setNotesStatus("loading");
    fetchMyNotes()
      .then((notes) => {
        if (!cancelled) {
          setAllNotes(notes);
          setNotesStatus("ready");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setNotesStatus("error");
          setErrorMessage(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A Continuous Assessment can only be attached to a video lesson or a
  // note (not an assignment) — see continuousAssessments.js's kind check.
  const eligibleNotes = useMemo(
    () => allNotes.filter((n) => n.course_id === moduleId && (n.kind === "video_lesson" || n.kind === "note" || !n.kind)),
    [allNotes, moduleId]
  );

  useEffect(() => {
    if (eligibleNotes.length > 0 && (!noteId || !eligibleNotes.some((n) => n.id === noteId))) {
      setNoteId(eligibleNotes[0].id);
    } else if (eligibleNotes.length === 0) {
      setNoteId(null);
    }
  }, [eligibleNotes, noteId]);

  const load = useCallback(async () => {
    if (!noteId) {
      setAssessments([]);
      setStatus("ready");
      return;
    }
    setStatus("loading");
    try {
      const rows = await fetchContinuousAssessments({ noteId, classId: classId || undefined });
      setAssessments(rows);
      setStatus("ready");
    } catch (e) {
      if (e.status === 403) {
        setStatus("forbidden");
        setErrorMessage(e.message);
      } else {
        setErrorMessage(e.message);
        setStatus("error");
      }
    }
  }, [noteId, classId]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    teaching,
    moduleId,
    setModuleId,
    notesStatus,
    eligibleNotes,
    noteId,
    setNoteId,
    status,
    assessments,
    errorMessage,
    reload: load,
    eligibleInstances,
    learningInstanceId,
    setLearningInstanceId,
    classId,
    setClassId,
  };
}
