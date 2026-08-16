import { useCallback, useEffect, useRef, useState } from "react";
import { fetchContinuousAssessment, startCaAttempt, saveCaAnswers, reportCaViolation, submitCaAttempt } from "../../api/learner";
import { isAccessRestrictedError, isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { useAssessmentMonitor } from "../../hooks/useAssessmentMonitor";
import { useAnswerAutosave } from "../../hooks/useAnswerAutosave";

/**
 * Owns one Continuous Assessment's full learner-facing lifecycle. The
 * backend (server/src/routes/continuousAssessments.js) remains the sole
 * authority for the lesson/note-completion prerequisite gate, the
 * deadline, violation counting, and grading throughout.
 */
export function useLearnerContinuousAssessmentAttempt(assessmentId) {
  const { refresh } = useAuth();
  const toast = useToast();

  const [status, setStatus] = useState("loading"); // "loading" | "not_found" | "forbidden" | "restricted" | "error" | "ready"
  const [errorMessage, setErrorMessage] = useState(null);
  const [assessment, setAssessment] = useState(null); // full detail incl. myAttempt/attempted/completedLesson
  const [answers, setAnswers] = useState([]);
  const [correctAnswers, setCorrectAnswers] = useState(null);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [violationMessage, setViolationMessage] = useState(null);

  const submitLock = useRef(false);

  const load = useCallback(
    async (opts = {}) => {
      const { preserveLocalState = false } = opts;
      if (!assessmentId) return;
      setStatus("loading");
      setErrorMessage(null);
      if (!preserveLocalState) setCorrectAnswers(null);
      try {
        const data = await fetchContinuousAssessment(assessmentId);
        setAssessment(data);
        const qCount = data.questions.length;
        if (data.myAttempt && data.myAttempt.status === "in_progress") {
          const restored = Array.isArray(data.myAttempt.answers) ? data.myAttempt.answers : new Array(qCount).fill(-1);
          setAnswers(restored.length === qCount ? restored : new Array(qCount).fill(-1));
        } else if (!preserveLocalState) {
          setAnswers(new Array(qCount).fill(-1));
        }
        setStatus("ready");
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await refresh();
          return;
        }
        if (isAccessRestrictedError(err)) {
          setStatus("restricted");
          return;
        }
        if (isForbiddenError(err)) {
          setStatus("forbidden");
          setErrorMessage(err.message);
          return;
        }
        if (err && err.status === 404) {
          setStatus("not_found");
          return;
        }
        setErrorMessage(err && err.message ? err.message : "Something went wrong loading this Continuous Assessment.");
        setStatus("error");
      }
    },
    [assessmentId, refresh]
  );

  useEffect(() => {
    load();
  }, [load]);

  const myAttempt = assessment ? assessment.myAttempt : null;
  const isActive = !!myAttempt && myAttempt.status === "in_progress";

  async function start() {
    setStarting(true);
    setViolationMessage(null);
    try {
      const res = await startCaAttempt(assessmentId);
      setAssessment((prev) => ({ ...prev, myAttempt: res.attempt, attempted: true }));
      if (res.attempt.status === "in_progress") {
        const restored = Array.isArray(res.attempt.answers) ? res.attempt.answers : [];
        setAnswers(restored.length === assessment.questions.length ? restored : new Array(assessment.questions.length).fill(-1));
      } else {
        toast.info("This attempt ended before it could begin — see the reason below.");
      }
    } catch (err) {
      if (isUnauthorizedError(err)) {
        await refresh();
        return;
      }
      toast.error(err.message);
      await load();
    } finally {
      setStarting(false);
    }
  }

  function selectAnswer(qIndex, optionIndex) {
    setAnswers((prev) => {
      const next = [...prev];
      next[qIndex] = optionIndex;
      return next;
    });
  }

  const doSubmit = useCallback(
    async (silent) => {
      if (submitLock.current) return;
      submitLock.current = true;
      setSubmitting(true);
      try {
        const res = await submitCaAttempt(assessmentId, answers);
        if (!silent) toast.success(`Continuous Assessment marked automatically: ${res.totalMarks}/${res.maxMarks} (${res.percentage}%).`);
        await load({ preserveLocalState: true });
        setCorrectAnswers(res.correctAnswers || null);
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await refresh();
          return;
        }
        if (!silent) toast.error(err.message);
        await load();
      } finally {
        setSubmitting(false);
        submitLock.current = false;
      }
    },
    [assessmentId, answers, toast, load, refresh]
  );

  useAnswerAutosave(answers, (a) => saveCaAnswers(assessmentId, a), isActive);

  const monitor = useAssessmentMonitor({
    deadlineAt: myAttempt ? myAttempt.deadlineAt : null,
    active: isActive,
    onExpire: () => doSubmit(true),
    reportViolation: () => reportCaViolation(assessmentId, answers),
    onViolationWarning: () => setViolationMessage("Warning: leaving this assessment again will end your attempt immediately."),
    onViolationEnd: (res) => {
      setAssessment((prev) => ({ ...prev, myAttempt: res.attempt }));
      toast.error("Your Continuous Assessment attempt was ended — you left the assessment twice.");
    },
  });

  return {
    status,
    errorMessage,
    assessment,
    myAttempt,
    isActive,
    answers,
    selectAnswer,
    correctAnswers,
    starting,
    start,
    submitting,
    submit: () => doSubmit(false),
    violationMessage,
    monitor,
    reload: load,
  };
}
