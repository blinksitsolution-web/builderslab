import { useCallback, useEffect, useState } from "react";
import { searchLearners, fetchAttendance } from "../../api/instructor";
import { useMyTeachingContext } from "./useMyTeachingContext";

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Attendance Register — migrates legacy instructorAttendance() /
 * loadAttendanceRoster() (dashboard.html). The legacy roster loop fetched
 * every learner then checked their `.modules` membership one-by-one; here
 * the equivalent, already-supported `?courseId=` filter on GET /api/users
 * (server/src/routes/users.js — scopes learners to those enrolled in the
 * module via the `enrollments` table) does the same scoping server-side in
 * one request instead of N.
 *
 * Bug fix (instructor-portal filter consistency pass): the roster fetch
 * below was sending `moduleId` as the query key, but GET /api/users reads
 * `courseId` — an unrecognised key is just silently ignored, so the
 * roster was never actually narrowed to the selected Course at all; an
 * instructor saw the exact same full list of every learner assigned to
 * them, regardless of which Course was picked above. Fixed by sending
 * both, the same "moduleId, courseId: moduleId" pattern markAttendance()
 * in api/instructor.js already uses for this exact reason.
 *
 * Extended with the same Class and Run filters Topics/Examinations have:
 * classId narrows the roster to one specific class (GET /api/users'
 * `class` param) and, once picked, resolves this instructor's own
 * assignment for that Course+Class combination — the campus/instance
 * pairing that assignment implies is what actually decides which
 * eligible Run applies, exactly like the concurrent-Runs picker
 * elsewhere.
 */
export function useInstructorAttendance() {
  const teaching = useMyTeachingContext();
  const [moduleId, setModuleId] = useState(null);
  const [classId, setClassId] = useState(null);
  const [date, setDate] = useState(today());
  // Only meaningful when the selected module's roster actually contains
  // both Child and Adult learners (Stage 3 — same Module used by both);
  // "both" preserves the original combined-roster behavior.
  const [audience, setAudience] = useState("both");
  const [status, setStatus] = useState("idle");
  const [roster, setRoster] = useState([]);
  const [existing, setExisting] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [learningInstanceId, setLearningInstanceId] = useState(null);

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
  }, [moduleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!moduleId || !date) return;
    setStatus("loading");
    const audienceFilter = audience === "both" ? undefined : audience;
    try {
      const [learners, attendance] = await Promise.all([
        searchLearners({ moduleId, courseId: moduleId, class: classId || undefined, audience: audienceFilter }),
        fetchAttendance(moduleId, date, audienceFilter).catch(() => []),
      ]);
      setRoster(learners);
      setExisting(attendance);
      setStatus("ready");
    } catch (e) {
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [moduleId, classId, date, audience]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    teaching,
    moduleId,
    setModuleId,
    classId,
    setClassId,
    date,
    setDate,
    audience,
    setAudience,
    status,
    roster,
    existing,
    errorMessage,
    reload: load,
    eligibleInstances,
    learningInstanceId,
    setLearningInstanceId,
  };
}
