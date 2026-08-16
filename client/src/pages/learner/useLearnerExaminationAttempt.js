import { useCallback, useEffect, useRef, useState } from "react";
import { fetchExam, startExamAttempt, saveExamAnswers, reportExamViolation, submitExamAttempt } from "../../api/learner";
import { isAccessRestrictedError, isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { useAssessmentMonitor } from "../../hooks/useAssessmentMonitor";
import { useAnswerAutosave } from "../../hooks/useAnswerAutosave";

/**
 * Owns one examination's full learner-facing lifecycle. The backend
 * (server/src/routes/exams.js) remains the sole authority for eligibility,
 * the deadline, violation counting, and grading throughout — every branch
 * below only relays a server response into UI state, it never decides any
 * of those things itself.
 */
export function useLearnerExaminationAttempt(examId) {
  const { refresh } = useAuth();
  const toast = useToast();

  const [status, setStatus] = useState("loading"); // "loading" | "not_found" | "forbidden" | "restricted" | "error" | "ready"
  const [errorMessage, setErrorMessage] = useState(null);
  const [exam, setExam] = useState(null); // full detail incl. myAttempt
  const [answers, setAnswers] = useState([]);
  const [correctAnswers, setCorrectAnswers] = useState(null); // only right after a successful graded submit
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [violationMessage, setViolationMessage] = useState(null);

  const submitLock = useRef(false); // guards against a client-observed expiry and a manual click racing each other

  const load = useCallback(
    async (opts = {}) => {
      const { preserveLocalState = false } = opts;
      if (!examId) return;
      setStatus("loading");
      setErrorMessage(null);
      if (!preserveLocalState) setCorrectAnswers(null);
      try {
        const data = await fetchExam(examId);
        setExam(data);
        if (data.myAttempt && data.myAttempt.status === "in_progress") {
          const restored = Array.isArray(data.myAttempt.answers) ? data.myAttempt.answers : new Array(data.questionCount).fill(-1);
          setAnswers(restored.length === data.questionCount ? restored : new Array(data.questionCount).fill(-1));
        } else if (!preserveLocalState) {
          setAnswers(new Array(data.questionCount).fill(-1));
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
        setErrorMessage(err && err.message ? err.message : "Something went wrong loading this examination.");
        setStatus("error");
      }
    },
    [examId, refresh]
  );

  useEffect(() => {
    load();
  }, [load]);

  const myAttempt = exam ? exam.myAttempt : null;
  const isActive = !!myAttempt && myAttempt.status === "in_progress";

  async function start() {
    setStarting(true);
    setViolationMessage(null);
    try {
      const res = await startExamAttempt(examId);
      setExam((prev) => ({ ...prev, myAttempt: res.attempt }));
      if (res.attempt.status === "in_progress") {
        const restored = Array.isArray(res.attempt.answers) ? res.attempt.answers : [];
        setAnswers(restored.length === exam.questionCount ? restored : new Array(exam.questionCount).fill(-1));
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
        const res = await submitExamAttempt(examId, answers);
        if (!silent) toast.success(`Examination submitted. Score: ${res.score}%.`);
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
    [examId, answers, toast, load, refresh]
  );

  useAnswerAutosave(answers, (a) => saveExamAnswers(examId, a), isActive);

  const monitor = useAssessmentMonitor({
    deadlineAt: myAttempt ? myAttempt.deadlineAt : null,
    active: isActive,
    onExpire: () => doSubmit(true),
    reportViolation: () => reportExamViolation(examId, answers),
    onViolationWarning: () => setViolationMessage("Warning: leaving this examination again will end your attempt immediately."),
    onViolationEnd: (res) => {
      setExam((prev) => ({ ...prev, myAttempt: res.attempt }));
      toast.error("Your examination attempt was ended — you left the assessment twice.");
    },
  });

  return {
    status,
    errorMessage,
    exam,
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
