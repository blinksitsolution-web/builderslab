import { Link } from "react-router-dom";
import { useLearnerContinuousAssessments } from "./useLearnerContinuousAssessments";
import { attemptPhase, endedReasonLabel } from "./assessmentLabels";
import { PageHeader, Card, Badge, Button, Alert, EmptyState, ErrorState, Skeleton } from "../../components/ui";

function ListSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {[1, 2, 3].map((i) => (
        <Card key={i} padding>
          <Skeleton height={18} width="40%" />
          <div style={{ marginTop: "var(--space-2)" }}>
            <Skeleton height={12} width="60%" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function CaCard({ assessment, moduleTitle }) {
  const phase = attemptPhase(assessment.myAttempt);
  const locked = !assessment.completedLesson && phase === "not_started";
  return (
    <Card padding className="animate-fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <span className="mono-tag">{moduleTitle}</span> <Badge tone="neutral">Continuous Assessment</Badge>
          <h3 style={{ margin: "var(--space-2) 0 0" }}>{assessment.title}</h3>
          <p className="text-helper" style={{ margin: "var(--space-1) 0 0" }}>
            {assessment.questions.length} question(s) · {assessment.maxMarks} mark(s)
            {assessment.closesAt ? ` · Closes ${new Date(assessment.closesAt).toLocaleString()}` : ""}
            {assessment.timedEnabled ? ` · Timed — ${assessment.durationMinutes} min once started` : ""}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--space-2)" }}>
          {phase === "ended" && (
            <Badge tone={assessment.myAttempt.percentage >= 60 ? "success" : "danger"}>
              {assessment.myAttempt.totalMarks}/{assessment.myAttempt.maxMarks} ({assessment.myAttempt.percentage}%) — {endedReasonLabel(assessment.myAttempt.endedReason)}
            </Badge>
          )}
          {locked ? (
            <Badge tone="neutral">🔒 Finish the lesson to unlock</Badge>
          ) : (
            <Link to={`/app/learner/continuous-assessments/${encodeURIComponent(assessment.id)}`}>
              <Button size="sm" variant={phase === "ended" ? "ghost" : "primary"}>
                {phase === "not_started" ? "View & start" : phase === "in_progress" ? "Resume assessment" : "View result"}
              </Button>
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function LearnerContinuousAssessmentsPage() {
  const { status, errorMessage, accessRestricted, assessments, moduleTitles, reload } = useLearnerContinuousAssessments();

  return (
    <div>
      <PageHeader title="Continuous Assessment" description="Short assessments attached to a video lesson or note in your enrolled modules." />

      {status === "loading" && <ListSkeleton />}

      {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}

      {status === "ready" && accessRestricted && (
        <Alert variant="warning" title="Your account has a payment restriction">
          Continuous Assessment isn't shown until this is resolved. <Link to="/app/learner/payments">Go to payments</Link>.
        </Alert>
      )}

      {status === "ready" && !accessRestricted && assessments.length === 0 && (
        <EmptyState title="No Continuous Assessments yet" description="Continuous Assessments your instructors publish for your modules will show up here." />
      )}

      {status === "ready" && !accessRestricted && assessments.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {assessments.map((a) => (
            <CaCard key={a.id} assessment={a} moduleTitle={moduleTitles[a.courseId] || a.courseId} />
          ))}
        </div>
      )}
    </div>
  );
}
