import { useParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useModuleLessons } from "./useModuleLessons";
import YouTubePlayer from "./YouTubePlayer";
import QuizGate from "./QuizGate";
import { PageHeader, Breadcrumbs, Card, Skeleton, ErrorState, UnauthorizedState, EmptyState } from "../../components/ui";

export default function LessonPage() {
  const { moduleId, lessonId } = useParams();
  const { user } = useAuth();
  const { status, errorMessage, moduleTitle, lessons, reload } = useModuleLessons(moduleId);

  if (status === "loading") {
    return (
      <Card padding>
        <Skeleton height={280} />
      </Card>
    );
  }

  if (status === "error") {
    return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  }

  if (status === "restricted") {
    return (
      <UnauthorizedState
        title="This lesson is hidden"
        description="Your account currently has a payment restriction, so lesson content isn't available. Resolve it to continue learning."
      />
    );
  }

  const lesson = lessons.find((l) => l.id === lessonId);

  if (!lesson) {
    return <EmptyState title="Lesson not found" description="This lesson may have been removed or the link is incorrect." />;
  }

  if (!lesson.isUnlocked) {
    return (
      <UnauthorizedState
        title="This lesson is locked"
        description="Finish the previous lesson and pass its quiz to unlock this one."
        action={{ label: `Back to ${moduleTitle}`, onClick: () => (window.location.href = `/app/learner/modules/${encodeURIComponent(moduleId)}`) }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[{ label: "Overview", href: "/app/learner" }, { label: moduleTitle, href: `/app/learner/modules/${encodeURIComponent(moduleId)}` }, { label: lesson.title }]}
          />
        }
        title={lesson.title}
      />

      <Card padding={false}>
        <YouTubePlayer userId={user.id} moduleId={moduleId} lesson={lesson} initialWatchedSec={lesson.watchedSecs} onProgressSaved={reload} />

        <div style={{ padding: "var(--space-5)" }}>
          {lesson.resources.length > 0 && (
            <div style={{ marginBottom: "var(--space-5)" }}>
              <h3>Downloadable resources</h3>
              <ul style={{ paddingLeft: "1.2em", margin: 0 }}>
                {lesson.resources.map((r, i) => (
                  <li key={i}>
                    <a href={r.url} target="_blank" rel="noopener noreferrer">
                      📄 {r.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <QuizGate userId={user.id} moduleId={moduleId} lesson={lesson} done={lesson.done} quizScore={lesson.quizScore} onScoreChange={reload} />
        </div>
      </Card>
    </div>
  );
}
