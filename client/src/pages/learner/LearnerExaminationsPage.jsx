import { Link } from "react-router-dom";
import { useLearnerExaminations } from "./useLearnerExaminations";
import { attemptPhase, endedReasonLabel } from "./assessmentLabels";
import { PageHeader, Card, Badge, Button, Alert, EmptyState, ErrorState, Skeleton } from "../../components/ui";

const TERM_TYPE_LABELS = { midterm: "Midterm", end_of_term: "End Of Term", retake: "Retake", final: "Final Exam" };

function ExamListSkeleton() {
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

function ExamCard({ exam, moduleTitle }) {
  const phase = attemptPhase(exam.myAttempt);
  return (
    <Card padding className="animate-fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-3)", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <span className="mono-tag">{moduleTitle}</span> <Badge tone="neutral">{TERM_TYPE_LABELS[exam.termType] || exam.termType}</Badge>
          <h3 style={{ margin: "var(--space-2) 0 0" }}>{exam.title}</h3>
          <p className="text-helper" style={{ margin: "var(--space-1) 0 0" }}>
            {exam.questionCount} question(s)
            {exam.closesAt ? ` · Closes ${new Date(exam.closesAt).toLocaleString()}` : ""}
            {exam.timedEnabled ? ` · Timed — ${exam.durationMinutes} min once started` : ""}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--space-2)" }}>
          {phase === "ended" && (
            <Badge tone={exam.myAttempt.score >= 60 ? "success" : "danger"}>
              Score: {exam.myAttempt.score}% — {endedReasonLabel(exam.myAttempt.endedReason)}
            </Badge>
          )}
          <Link to={`/app/learner/examinations/${encodeURIComponent(exam.id)}`}>
            <Button size="sm" variant={phase === "ended" ? "ghost" : "primary"}>
              {phase === "not_started" ? "View & start" : phase === "in_progress" ? "Resume examination" : "View result"}
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}

export default function LearnerExaminationsPage() {
  const { status, errorMessage, accessRestricted, exams, moduleTitles, reload } = useLearnerExaminations();

  return (
    <div>
      <PageHeader title="Examinations" description="Midterm, end-of-term, retake, and final examinations for your enrolled modules." />

      {status === "loading" && <ExamListSkeleton />}

      {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}

      {status === "ready" && accessRestricted && (
        <Alert variant="warning" title="Your account has a payment restriction">
          Examinations aren't shown until this is resolved. <Link to="/app/learner/payments">Go to payments</Link>.
        </Alert>
      )}

      {status === "ready" && !accessRestricted && exams.length === 0 && (
        <EmptyState title="No examinations scheduled" description="Examinations your instructors schedule for your modules will show up here." />
      )}

      {status === "ready" && !accessRestricted && exams.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {exams.map((e) => (
            <ExamCard key={e.id} exam={e} moduleTitle={moduleTitles[e.courseId] || e.courseId} />
          ))}
        </div>
      )}
    </div>
  );
}
