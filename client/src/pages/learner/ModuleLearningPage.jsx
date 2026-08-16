import { Link, useParams } from "react-router-dom";
import { useModuleLessons } from "./useModuleLessons";
import { PageHeader, Breadcrumbs, Card, Badge, ProgressBar, Skeleton, EmptyState, ErrorState, UnauthorizedState } from "../../components/ui";

function LessonListSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {[1, 2, 3].map((i) => (
        <Card key={i} padding>
          <Skeleton height={18} width="50%" />
          <div style={{ marginTop: "var(--space-2)" }}>
            <Skeleton height={12} width="30%" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export default function ModuleLearningPage() {
  const { moduleId } = useParams();
  const { status, errorMessage, moduleTitle, lessons, reload } = useModuleLessons(moduleId);

  const completedCount = lessons.filter((l) => l.done).length;
  const overallPct = lessons.length ? Math.round((completedCount / lessons.length) * 100) : 0;

  return (
    <div>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Overview", href: "/app/learner" }, { label: moduleTitle }]} />}
        title={moduleTitle}
        description={lessons.length > 0 ? `${completedCount} of ${lessons.length} lessons complete` : undefined}
      />

      {status === "loading" && <LessonListSkeleton />}

      {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}

      {status === "restricted" && (
        <UnauthorizedState
          title="Lessons are hidden"
          description="Your account currently has a payment restriction, so this module's lessons aren't available. Resolve it to continue learning."
        />
      )}

      {status === "ready" && lessons.length === 0 && (
        <EmptyState title="Lessons coming soon" description={`Lesson videos for ${moduleTitle} haven't been uploaded yet — check back soon!`} />
      )}

      {status === "ready" && lessons.length > 0 && (
        <>
          <div style={{ marginBottom: "var(--space-6)" }}>
            <ProgressBar value={overallPct} tone={overallPct === 100 ? "success" : "brand"} label="Module progress" />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {lessons.map((l, i) => (
              <Card key={l.id} padding className="animate-fade-in">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)" }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>
                      {i + 1}. {l.title}
                    </strong>
                    <p className="text-helper" style={{ margin: 0 }}>
                      {Math.round(l.durationSec / 60)} min · {l.resources.length} downloadable resource(s)
                      {l.quizScore != null ? ` · Quiz: ${l.quizScore}%` : ""}
                    </p>
                  </div>
                  {l.isUnlocked ? (
                    <Link to={`/app/learner/modules/${encodeURIComponent(moduleId)}/lessons/${encodeURIComponent(l.id)}`}>
                      <Badge tone={l.done ? "success" : "brand"}>{l.done ? "Review" : "Watch"}</Badge>
                    </Link>
                  ) : (
                    <Badge tone="neutral">🔒 Locked</Badge>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
