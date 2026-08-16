import { useState } from "react";
import { Card, Badge, Button, Radio, Alert, ConfirmationDialog } from "../../components/ui";
import styles from "./AssessmentRunner.module.css";

/**
 * @param {{ key: string, text: string, options: string[], meta?: string }[]} questions
 * @param {number[]} answers - same length as questions, -1 = unanswered
 * @param {(qIndex:number, optionIndex:number) => void} onSelect
 * @param {string|null} remainingLabel - "mm:ss", or null when untimed
 * @param {boolean} approachingExpiry
 * @param {boolean} violationWarning - first-violation warning currently showing
 * @param {() => void|Promise<void>} onSubmit
 * @param {boolean} submitting
 * @param {boolean} disabled - true once the attempt has ended (defensive — the parent normally stops rendering this at all once ended)
 * @param {{ correctIndex:number }[]|null} review - present only right after a successful graded submission, to show correct/wrong per option
 */
export default function AssessmentRunner({
  questions,
  answers,
  onSelect,
  remainingLabel,
  approachingExpiry,
  violationWarning,
  onSubmit,
  submitting,
  disabled,
  review,
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const total = questions.length;
  const answeredCount = answers.filter((a) => a != null && a >= 0).length;
  const unansweredCount = total - answeredCount;
  const q = questions[currentIndex];

  function handleSubmitClick() {
    setConfirmOpen(true);
  }

  async function handleConfirmedSubmit() {
    await onSubmit();
  }

  return (
    <div>
      <div className={styles.timerBar}>
        <span className={remainingLabel != null ? `${styles.timerLabel} ${approachingExpiry ? styles.timerUrgent : ""}` : styles.timerLabel}>
          {remainingLabel != null ? `Time remaining: ${remainingLabel}` : "Untimed — no time limit on this attempt"}
        </span>
        <Badge tone={unansweredCount === 0 ? "success" : "neutral"}>
          {answeredCount} of {total} answered
        </Badge>
      </div>

      {violationWarning && !disabled && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Alert variant="warning" title="You left this assessment">
            Leaving the assessment tab/window again will end your attempt immediately.
          </Alert>
        </div>
      )}

      <div className={styles.palette}>
        {questions.map((_, i) => (
          <button
            key={i}
            type="button"
            className={[styles.paletteItem, answers[i] != null && answers[i] >= 0 ? styles.answered : "", i === currentIndex ? styles.current : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => setCurrentIndex(i)}
            aria-current={i === currentIndex}
            aria-label={`Question ${i + 1}${answers[i] != null && answers[i] >= 0 ? ", answered" : ", unanswered"}`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      <Card padding>
        <strong>
          Question {currentIndex + 1} of {total}
          {q.meta ? ` — ${q.meta}` : ""}
        </strong>
        <p style={{ marginTop: "var(--space-2)" }}>{q.text}</p>
        <div style={{ marginTop: "var(--space-3)" }}>
          {q.options.map((opt, oi) => {
            const reviewInfo = review && review[currentIndex];
            const isCorrect = reviewInfo && reviewInfo.correctIndex === oi;
            const isWrong = reviewInfo && !isCorrect && answers[currentIndex] === oi;
            return (
              <div key={oi} className={[styles.option, isCorrect ? styles.correct : "", isWrong ? styles.wrong : ""].filter(Boolean).join(" ")}>
                <Radio
                  name={`q-${currentIndex}`}
                  label={opt}
                  checked={answers[currentIndex] === oi}
                  disabled={disabled || !!review}
                  onChange={() => onSelect(currentIndex, oi)}
                />
              </div>
            );
          })}
        </div>
      </Card>

      <div className={styles.navRow}>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button variant="ghost" disabled={currentIndex === 0} onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}>
            Previous
          </Button>
          <Button variant="ghost" disabled={currentIndex === total - 1} onClick={() => setCurrentIndex((i) => Math.min(total - 1, i + 1))}>
            Next
          </Button>
        </div>
        {!disabled && !review && (
          <Button variant="primary" loading={submitting} onClick={handleSubmitClick}>
            Submit
          </Button>
        )}
      </div>

      <ConfirmationDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirmedSubmit}
        title="Submit this assessment?"
        confirmLabel="Submit now"
        confirmVariant={unansweredCount > 0 ? "danger" : "primary"}
      >
        {unansweredCount > 0 ? (
          <p>
            You have <strong>{unansweredCount}</strong> unanswered question(s). Once you submit, you can't change your answers — this is your only
            attempt.
          </p>
        ) : (
          <p>You've answered every question. Once you submit, you can't change your answers — this is your only attempt.</p>
        )}
      </ConfirmationDialog>
    </div>
  );
}
