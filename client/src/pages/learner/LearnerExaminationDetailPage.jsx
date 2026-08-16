import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useLearnerExaminationAttempt } from "./useLearnerExaminationAttempt";
import { endedReasonLabel, endedReasonTone } from "./assessmentLabels";
import AssessmentRunner from "./AssessmentRunner";
import { PageHeader, Breadcrumbs, Card, Badge, Button, Alert, Skeleton, ErrorState, UnauthorizedState, ConfirmationDialog } from "../../components/ui";

const TERM_TYPE_LABELS = { midterm: "Midterm", end_of_term: "End Of Term", retake: "Retake", final: "Final Exam" };

function DetailSkeleton() {
  return (
    <div>
      <Skeleton height={28} width="50%" />
      <div style={{ marginTop: "var(--space-4)" }}>
        <Skeleton height={100} width="100%" />
      </div>
    </div>
  );
}

export default function LearnerExaminationDetailPage() {
  const { id } = useParams();
  const {
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
    submit,
    violationMessage,
    monitor,
    reload,
  } = useLearnerExaminationAttempt(id);
  const [confirmStartOpen, setConfirmStartOpen] = useState(false);

  const breadcrumbs = <Breadcrumbs items={[{ label: "Examinations", href: "/app/learner/examinations" }, { label: exam ? exam.title : "Examination" }]} />;

  if (status === "loading") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Examination" />
        <DetailSkeleton />
      </div>
    );
  }

  if (status === "not_found") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Examination" />
        <ErrorState
          title="Examination not found"
          description="This examination may have been removed, or isn't available to you."
          action={{ label: "Back to Examinations", onClick: () => window.history.back() }}
        />
      </div>
    );
  }

  if (status === "forbidden") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Examination" />
        <UnauthorizedState description={errorMessage || "This examination wasn't assigned to you."} />
      </div>
    );
  }

  if (status === "restricted") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Examination" />
        <UnauthorizedState
          title="Examinations are hidden"
          description="Your account currently has a payment restriction, so this examination isn't available. Resolve it to continue."
        />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Examination" />
        <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />
      </div>
    );
  }

  const questions = exam.questions.map((q, i) => ({ key: i, text: q.question, options: q.choices }));
  const hasReview = !!correctAnswers && myAttempt && myAttempt.status !== "in_progress";
  const review = hasReview ? correctAnswers.map((correctIndex) => ({ correctIndex })) : null;

  return (
    <div>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={exam.title}
        description={
          <>
            <Badge tone="neutral">{TERM_TYPE_LABELS[exam.termType] || exam.termType}</Badge> {exam.questionCount} question(s)
          </>
        }
      />

      {!myAttempt && (
        <Card padding>
          <h3 style={{ marginTop: 0 }}>Before you start</h3>
          <ul style={{ paddingLeft: "1.2em", color: "var(--color-neutral-700)" }}>
            <li>
              You get <strong>one attempt</strong> at this examination — there's no retake once it's submitted.
            </li>
            {exam.closesAt && <li>Closes: {new Date(exam.closesAt).toLocaleString()}</li>}
            {exam.timedEnabled ? (
              <li>
                This is a <strong>timed</strong> attempt — you'll have {exam.durationMinutes} minute(s) once you start. The countdown is enforced by the
                server, so refreshing or reopening this page won't reset or extend it.
              </li>
            ) : (
              <li>This attempt is untimed.</li>
            )}
            <li>Leaving this tab/window during the attempt is tracked: the first time only warns you, the second time ends your attempt immediately.</li>
          </ul>
          <Button variant="primary" loading={starting} onClick={() => setConfirmStartOpen(true)}>
            Start examination
          </Button>
          <ConfirmationDialog open={confirmStartOpen} onClose={() => setConfirmStartOpen(false)} onConfirm={start} title="Start examination?" confirmLabel="Start now">
            <p>You'll only get one attempt at this examination. Start now?</p>
          </ConfirmationDialog>
        </Card>
      )}

      {isActive && (
        <>
          {violationMessage && (
            <div style={{ marginBottom: "var(--space-4)" }}>
              <Alert variant="warning">{violationMessage}</Alert>
            </div>
          )}
          <AssessmentRunner
            questions={questions}
            answers={answers}
            onSelect={selectAnswer}
            remainingLabel={monitor.remainingLabel}
            approachingExpiry={monitor.approachingExpiry}
            violationWarning={monitor.violationWarning}
            onSubmit={submit}
            submitting={submitting}
            disabled={false}
            review={null}
          />
        </>
      )}

      {myAttempt && myAttempt.status !== "in_progress" && (
        <>
          <Card padding style={{ marginBottom: hasReview ? "var(--space-5)" : 0 }}>
            <Badge tone={endedReasonTone(myAttempt.endedReason)}>{endedReasonLabel(myAttempt.endedReason)}</Badge>
            <p style={{ marginTop: "var(--space-3)", fontSize: "var(--font-size-xl)", fontWeight: "var(--font-weight-semibold)" }}>Score: {myAttempt.score}%</p>
            {!hasReview && (
              <Link to="/app/learner/examinations">
                <Button variant="ghost">Back to Examinations</Button>
              </Link>
            )}
          </Card>

          {hasReview && (
            <>
              <AssessmentRunner
                questions={questions}
                answers={answers}
                onSelect={() => {}}
                remainingLabel={null}
                approachingExpiry={false}
                violationWarning={false}
                onSubmit={() => {}}
                submitting={false}
                disabled
                review={review}
              />
              <div style={{ marginTop: "var(--space-4)" }}>
                <Link to="/app/learner/examinations">
                  <Button variant="ghost">Back to Examinations</Button>
                </Link>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
