import { useCallback, useEffect, useState } from "react";
import { fetchTopics } from "../../api/instructor";
import { useMyTeachingContext } from "./useMyTeachingContext";

/**
 * Monthly Topics (read-ahead) — migrates legacy instructorTopics() /
 * loadInstructorTopicList() (dashboard.html). Topics are scoped by
 * module, chosen from the teaching-context module picker; GET
 * /api/topics/:moduleId is the same endpoint the legacy screen calls.
 *
 * Extended (instructor-portal filter consistency pass) with the same
 * Run picker useInstructorExams already has — auto-resolved when there's
 * only one eligible Run, an explicit choice required when there are
 * several — plus an optional Class filter. A topic with no class_id
 * applies to every class studying this module (see topics.js), so
 * classId here defaults to null/"every class" rather than forcing a pick.
 */
export function useInstructorTopics() {
  const teaching = useMyTeachingContext();
  const [moduleId, setModuleId] = useState(null);
  const [classId, setClassId] = useState(null);
  const [status, setStatus] = useState("idle"); // "idle" | "loading" | "ready" | "error"
  const [topics, setTopics] = useState([]);
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
    if (!moduleId) return;
    setStatus("loading");
    try {
      const rows = await fetchTopics(moduleId, { classId, learningInstanceId });
      setTopics(rows);
      setStatus("ready");
    } catch (e) {
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [moduleId, classId, learningInstanceId]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    teaching,
    moduleId,
    setModuleId,
    classId,
    setClassId,
    status,
    topics,
    errorMessage,
    reload: load,
    eligibleInstances,
    learningInstanceId,
    setLearningInstanceId,
  };
}
