import { useState } from "react";
import { fetchQuiz, submitQuiz } from "../../api/learner";
import { useToast } from "../../context/ToastContext";
import { Badge, Button, Radio } from "../../components/ui";

/**
 * Faithful port of legacy renderQuizGate()/startQuiz()/submitQuiz() (see
 * Phase 10 analysis). This is the AI-generated quiz directly gating a
 * lesson's completion — distinct from, and unrelated to, the separate
 * Continuous Assessment system (out of scope for this phase; the legacy
 * CA gate is intentionally not ported here).
 *
 * @param {boolean} done - has the learner finished watching this lesson
 * @param {number|null} quizScore - current stored score, if any
 * @param {() => void} onScoreChange - called after a submit so the parent can refresh lesson state
 */
export default function QuizGate({ userId, moduleId, lesson, done, quizScore, onScoreChange }) {
  const toast = useToast();
  const [questions, setQuestions] = useState(null);
  const [answers, setAnswers] = useState([]);
  const [result, setResult] = useState(null); // { score, correctAnswers }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  if (!done) {
    return <Badge tone="neutral">Finish watching the video to unlock this lesson's quiz</Badge>;
  }

  async function start() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const q = await fetchQuiz(moduleId, lesson.id);
      setQuestions(q);
      setAnswers(new Array(q.length).fill(-1));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    setLoading(true);
    try {
      const res = await submitQuiz(userId, moduleId, lesson.id, answers);
      setResult(res);
      toast[res.score >= 60 ? "success" : "info"](`You scored ${res.score}%. ${res.score >= 60 ? "Next lesson unlocked!" : "You need 60% to unlock the next lesson — you can retake it."}`);
      onScoreChange?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return <Badge tone="neutral">{error}</Badge>;
  }

  if (questions) {
    return (
      <div>
        <h3>Quick check — {questions.length} question(s)</h3>
        {questions.map((q, qi) => (
          <div key={qi} style={{ marginBottom: "var(--space-4)" }}>
            <strong>
              {qi + 1}. {q.q}
            </strong>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
              {q.options.map((opt, oi) => {
                const isCorrect = result && result.correctAnswers[qi] === oi;
                const isWrong = result && !isCorrect && answers[qi] === oi;
                return (
                  <div
                    key={oi}
                    style={{
                      padding: "var(--space-1) var(--space-2)",
                      borderRadius: "var(--radius-sm)",
                      background: isCorrect ? "var(--color-success-bg)" : isWrong ? "var(--color-danger-bg)" : "transparent",
                    }}
                  >
                    <Radio
                      name={`q${qi}`}
                      label={opt}
                      checked={answers[qi] === oi}
                      disabled={!!result}
                      onChange={() => {
                        const next = [...answers];
                        next[qi] = oi;
                        setAnswers(next);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {!result && (
          <Button variant="secondary" loading={loading} onClick={submit}>
            Submit answers
          </Button>
        )}
        {result && (
          <Button variant="ghost" onClick={start}>
            Retake quiz
          </Button>
        )}
      </div>
    );
  }

  if (quizScore != null) {
    return (
      <div>
        <Badge tone={quizScore >= 60 ? "success" : "danger"}>
          Quiz score: {quizScore}% {quizScore >= 60 ? "— passed, next lesson unlocked" : "— retake to unlock the next lesson"}
        </Badge>
        {quizScore < 60 && (
          <div style={{ marginTop: "var(--space-3)" }}>
            <Button variant="secondary" size="sm" loading={loading} onClick={start}>
              Retake quiz
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <Button variant="secondary" loading={loading} onClick={start}>
      ✨ Take the AI-generated quiz
    </Button>
  );
}
