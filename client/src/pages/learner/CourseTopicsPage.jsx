import { useCourseTopics } from "./useCourseTopics";
import { PageHeader, Card, Badge, ProgressBar, Alert, EmptyState, ErrorState, UnauthorizedState, Skeleton } from "../../components/ui";

function TopicsSkeleton() {
  return (
    <div>
      <Card padding>
        <Skeleton height={18} width="30%" />
        <div style={{ marginTop: "var(--space-3)" }}>
          <Skeleton height={10} width="100%" />
        </div>
      </Card>
      <div style={{ marginTop: "var(--space-6)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {[1, 2].map((i) => (
          <Card key={i} padding>
            <Skeleton height={16} width="40%" />
            <div style={{ marginTop: "var(--space-2)" }}>
              <Skeleton height={12} width="80%" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function TopicRow({ topic }) {
  return (
    <Card padding className="animate-fade-in">
      <Badge tone="neutral">{topic.month_label}</Badge>{" "}
      <Badge tone={topic.completed ? "success" : "neutral"}>{topic.completed ? `Completed ${topic.completed_date || ""}` : "In progress"}</Badge>
      <h3 style={{ marginTop: "var(--space-2)" }}>{topic.title}</h3>
      {topic.body && <p>{topic.body}</p>}
      {topic.file_path && (
        <a href={topic.file_path} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary-700)", fontWeight: "var(--font-weight-semibold)" }}>
          📄 View attached file
        </a>
      )}
      <p className="text-helper" style={{ marginTop: "var(--space-2)" }}>
        Posted by {topic.posted_by} · {(topic.date || "").slice(0, 10)}
      </p>
    </Card>
  );
}

/**
 * Course Topics & Progress (Phase 11). Migrates legacy learnerTopics() /
 * renderTopicsAndProgress() (see Phase 1 analysis, dashboard.html) —
 * "read ahead" topics per enrolled module, plus the term progress chart.
 * Preserves the existing topics<->modules relationship: Course Topics is
 * purely an index layer over data already scoped by module, not a new
 * hierarchy.
 */
export default function CourseTopicsPage() {
  const { status, errorMessage, moduleTopicGroups, monthly, termTotalPct, progressUnavailable, reload } = useCourseTopics();

  if (status === "loading") {
    return (
      <div>
        <PageHeader title="Course Topics & Progress" />
        <TopicsSkeleton />
      </div>
    );
  }

  if (status === "error") {
    return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  }

  if (status === "restricted") {
    return (
      <div>
        <PageHeader title="Course Topics & Progress" />
        <UnauthorizedState
          title="Course Topics are hidden"
          description="Your account currently has a payment restriction, so this content isn't available. Resolve it to see your topics and progress again."
        />
      </div>
    );
  }

  const months = Object.keys(monthly).sort();

  return (
    <div>
      <PageHeader title="Course Topics & Progress" />

      <Card padding>
        <h3 style={{ marginTop: 0 }}>Progress this term</h3>
        {progressUnavailable ? (
          <Alert variant="warning">Progress details couldn't be loaded right now.</Alert>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
              <span className="text-helper">Total for the term</span>
              <Badge tone={termTotalPct >= 80 ? "success" : "warning"}>{termTotalPct || 0}% complete</Badge>
            </div>
            {months.length === 0 ? (
              <p className="text-helper">No completed lessons recorded yet.</p>
            ) : (
              months.map((m) => (
                <div key={m} style={{ marginBottom: "var(--space-3)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", marginBottom: "var(--space-1)" }}>
                    <span>{m}</span>
                    <span>{monthly[m]}%</span>
                  </div>
                  <ProgressBar value={monthly[m]} label={`Progress for ${m}`} />
                </div>
              ))
            )}
          </>
        )}
      </Card>

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2 className="text-section-title">Read ahead — upcoming topics</h2>
        {moduleTopicGroups.length === 0 ? (
          <EmptyState title="No modules enrolled yet" description="Once you're enrolled in a module, its topics will show up here." />
        ) : (
          moduleTopicGroups.map((group) => (
            <div key={group.moduleId} style={{ marginTop: "var(--space-5)" }}>
              <h3 style={{ marginBottom: "var(--space-3)" }}>{group.moduleTitle}</h3>
              {group.topics.length === 0 ? (
                <p className="text-helper">No topics posted yet for this module.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                  {group.topics.map((t) => (
                    <TopicRow key={t.id} topic={t} />
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
