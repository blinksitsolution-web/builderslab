import { useCallback, useEffect, useState } from "react";
import { fetchExamsForModule, fetchExamTermTypes, fetchRetakeEligibleLearners } from "../../api/instructor";
import { useMyTeachingContext } from "./useMyTeachingContext";

/**
 * Instructor Examinations (Phase 14) — migrates legacy instructorExams() /
 * onExamModuleChange() (dashboard.html). Same module-scoped cascade
 * pattern as useInstructorTopics/useInstructorAttendance: pick a module
 * from the instructor's assigned teaching context, then load whatever is
 * scoped to it. Backend remains authoritative for every rule (ownership,
 * allowed term types per offering type, retake eligibility, closing
 * date/timed-attempt enforcement) — this hook only fetches and exposes
 * that state.
 */
export function useInstructorExams() {
  const teaching = useMyTeachingContext();
  const [moduleId, setModuleId] = useState(null);
  const [termType, setTermType] = useState(null);
  const [termTypes, setTermTypes] = useState([]);
  const [status, setStatus] = useState("idle"); // "idle" | "loading" | "ready" | "error" | "forbidden"
  const [exams, setExams] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [retakeLearners, setRetakeLearners] = useState([]);
  const [retakeStatus, setRetakeStatus] = useState("idle");
  // ABRS v2.2 amendment (concurrent Programme Runs) — the selected
  // module's own `eligibleInstances` (see routes/modules.js's GET /mine,
  // only present when this instructor has 2+ currently-Active Runs to
  // choose from for this module). learningInstanceId holds the choice;
  // stays null/undefined for the still-overwhelmingly-common case of 0 or
  // 1 eligible Runs, which createExam() below treats identically to
  // before this existed (server falls back to the module's one Active Run).
  const [learningInstanceId, setLearningInstanceId] = useState(null);
  // Instructor-portal filter consistency pass: which Class this
  // examination is for (examinations.class_id already existed in the
  // schema and was already accepted by createExam/POST — this was the
  // missing UI). Defaults to "every class studying this module" (null),
  // same NULL-means-unscoped convention topics/notes already use.
  const [classId, setClassId] = useState(null);

  useEffect(() => {
    if (teaching.status === "ready" && teaching.modules.length > 0 && !moduleId) {
      setModuleId(teaching.modules[0].id);
    }
  }, [teaching.status, teaching.modules, moduleId]);

  const selectedModule = teaching.modules.find((m) => m.id === moduleId) || null;
  const eligibleInstances = selectedModule?.eligibleInstances || [];

  // Reset/auto-resolve the run choice whenever the selected module
  // changes: exactly one eligible Run -> pick it automatically (nothing
  // to ask); 2+ -> clear it and require an explicit pick before allowing
  // exam creation (see InstructorExaminationsPage's submit guard).
  useEffect(() => {
    if (eligibleInstances.length === 1) {
      setLearningInstanceId(eligibleInstances[0].id);
    } else {
      setLearningInstanceId(null);
    }
    setClassId(null);
  }, [moduleId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-resolve the allowed Type options whenever the module changes — the
  // available set (and whether it's ever labelled "Term") depends on the
  // module's Learning Offering Type (see exams.js allowedTermTypesForModule).
  useEffect(() => {
    if (!moduleId) return;
    let cancelled = false;
    fetchExamTermTypes(moduleId)
      .then((types) => {
        if (cancelled) return;
        setTermTypes(types);
        setTermType((current) => (current && types.includes(current) ? current : types[0] || null));
      })
      .catch(() => {
        if (!cancelled) setTermTypes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  const load = useCallback(async () => {
    if (!moduleId) return;
    setStatus("loading");
    try {
      const rows = await fetchExamsForModule(moduleId, { classId: classId || undefined });
      setExams(rows);
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
  }, [moduleId, classId]);

  useEffect(() => {
    load();
  }, [load]);

  // Retake-eligible learner picker — only meaningful while "retake" is the
  // selected Type. Reloaded whenever the module or term type changes.
  useEffect(() => {
    if (!moduleId || termType !== "retake") {
      setRetakeLearners([]);
      return;
    }
    let cancelled = false;
    setRetakeStatus("loading");
    fetchRetakeEligibleLearners(moduleId)
      .then((learners) => {
        if (!cancelled) {
          setRetakeLearners(learners);
          setRetakeStatus("ready");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setRetakeStatus("error");
          setErrorMessage(e.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId, termType]);

  return {
    teaching,
    moduleId,
    setModuleId,
    termType,
    setTermType,
    termTypes,
    status,
    exams,
    errorMessage,
    reload: load,
    retakeLearners,
    retakeStatus,
    eligibleInstances,
    learningInstanceId,
    setLearningInstanceId,
    classId,
    setClassId,
  };
}
