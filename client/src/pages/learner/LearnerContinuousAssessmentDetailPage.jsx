import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useLearnerContinuousAssessmentAttempt } from "./useLearnerContinuousAssessmentAttempt";
import { endedReasonLabel, endedReasonTone } from "./assessmentLabels";
import AssessmentRunner from "./AssessmentRunner";
import { PageHeader, Breadcrumbs, Card, Badge, Button, Alert, Skeleton, EmptyState, ErrorState, UnauthorizedState, ConfirmationDialog } from "../../components/ui";

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

export default function LearnerContinuousAssessmentDetailPage() {
  const { id } = useParams();
  const {
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
    submit,
    violationMessage,
    monitor,
    reload,
  } = useLearnerContinuousAssessmentAttempt(id);
  const [confirmStartOpen, setConfirmStartOpen] = useState(false);

  const breadcrumbs = (
    <Breadcrumbs items={[{ label: "Continuous Assessment", href: "/app/learner/continuous-assessments" }, { label: assessment ? assessment.title : "Assessment" }]} />
  );

  if (status === "loading") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Continuous Assessment" />
        <DetailSkeleton />
      </div>
    );
  }

  if (status === "not_found") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Continuous Assessment" />
        <ErrorState
          title="Assessment not found"
          description="This Continuous Assessment may have been removed or unpublished, or isn't available to you."
          action={{ label: "Back", onClick: () => window.history.back() }}
        />
      </div>
    );
  }

  if (status === "forbidden") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Continuous Assessment" />
        <UnauthorizedState description={errorMessage || "You don't have access to this assessment."} />
      </div>
    );
  }

  if (status === "restricted") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Continuous Assessment" />
        <UnauthorizedState
          title="Continuous Assessment is hidden"
          description="Your account currently has a payment restriction, so this assessment isn't available. Resolve it to continue."
        />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div>
        <PageHeader breadcrumbs={breadcrumbs} title="Continuous Assessment" />
        <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />
      </div>
    );
  }

  const questions = assessment.questions.map((q, i) => ({ key: i, text: q.question, options: q.options, meta: `${q.marks} mark(s)` }));
  const hasReview = !!correctAnswers && myAttempt && myAttempt.status !== "in_progress";
  const review = hasReview ? correctAnswers.map((correctIndex) => ({ correctIndex })) : null;

  return (
    <div>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={assessment.title}
        description={`${assessment.questions.length} question(s) · ${assessment.maxMarks} mark(s) total`}
      />

      {!myAttempt && !assessment.completedLesson && (
        <EmptyState title="Not unlocked yet" description="Finish watching the video lesson or reading the note before taking this Continuous Assessment." />
      )}

      {!myAttempt && assessment.completedLesson && (
        <Card padding>
          <h3 style={{ marginTop: 0 }}>Before you start</h3>
          <ul style={{ paddingLeft: "1.2em", color: "var(--color-neutral-700)" }}>
            <li>
              You get <strong>one attempt</strong> at this Continuous Assessment — there's no retake once it's submitted.
            </li>
            {assessment.closesAt && <li>Closes: {new Date(assessment.closesAt).toLocaleString()}</li>}
            {assessment.timedEnabled ? (
              <li>
                This is a <strong>timed</strong> attempt — you'll have {assessment.durationMinutes} minute(s) once you start. The countdown is enforced by
                the server, so refreshing or reopening this page won't reset or extend it.
              </li>
            ) : (
              <li>This attempt is untimed.</li>
            )}
            <li>Leaving this tab/window during the attempt is tracked: the first time only warns you, the second time ends your attempt immediately.</li>
          </ul>
          <Button variant="primary" loading={starting} onClick={() => setConfirmStartOpen(true)}>
            Start assessment
          </Button>
          <ConfirmationDialog open={confirmStartOpen} onClose={() => setConfirmStartOpen(false)} onConfirm={start} title="Start assessment?" confirmLabel="Start now">
            <p>You'll only get one attempt at this Continuous Assessment. Start now?</p>
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
            <p style={{ marginTop: "var(--space-3)", fontSize: "var(--font-size-xl)", fontWeight: "var(--font-weight-semibold)" }}>
              {myAttempt.totalMarks}/{myAttempt.maxMarks} ({myAttempt.percentage}%)
            </p>
            {!hasReview && (
              <Link to="/app/learner/continuous-assessments">
                <Button variant="ghost">Back to Continuous Assessment</Button>
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
                <Link to="/app/learner/continuous-assessments">
                  <Button variant="ghost">Back to Continuous Assessment</Button>
                </Link>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
