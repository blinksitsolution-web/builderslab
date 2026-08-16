import { useAuth } from "../../context/AuthContext";
import { useLearnerNotes } from "./useLearnerNotes";
import NoteReadAndQuiz from "./NoteReadAndQuiz";
import AssignmentSubmissionBlock from "./AssignmentSubmissionBlock";
import { PageHeader, Card, Badge, EmptyState, ErrorState, UnauthorizedState, Skeleton } from "../../components/ui";

const KIND_LABELS = { assignment: "Assignment", note: "Note" };

function NotesSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {[1, 2, 3].map((i) => (
        <Card key={i} padding>
          <Skeleton height={14} width="20%" />
          <div style={{ marginTop: "var(--space-2)" }}>
            <Skeleton height={20} width="50%" />
          </div>
          <div style={{ marginTop: "var(--space-2)" }}>
            <Skeleton height={12} width="90%" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function NoteCard({ note, moduleTitle, userId, watchedSeconds, quizScore, submission, onProgressChange }) {
  return (
    <Card padding className="animate-fade-in">
      <Badge tone="brand">{moduleTitle}</Badge> <Badge tone="neutral">{KIND_LABELS[note.kind] || "Note"}</Badge>
      <h3 style={{ marginTop: "var(--space-2)" }}>
        {note.title}
        {note.topic ? ` — ${note.topic}` : ""}
      </h3>
      <p>{note.body}</p>
      {note.file_path && (
        <a href={note.file_path} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary-700)", fontWeight: "var(--font-weight-semibold)" }}>
          📄 View attached file
        </a>
      )}
      <p className="text-helper" style={{ marginTop: "var(--space-2)" }}>
        Posted by {note.posted_by} · {(note.date || "").slice(0, 10)}
      </p>

      <div style={{ marginTop: "var(--space-4)", borderTop: "1px dashed var(--border-default)", paddingTop: "var(--space-4)" }}>
        {note.kind === "assignment" ? (
          <AssignmentSubmissionBlock noteId={note.id} submission={submission} onSubmitted={onProgressChange} />
        ) : (
          <NoteReadAndQuiz
            userId={userId}
            moduleId={note.course_id}
            noteId={note.id}
            read={watchedSeconds >= 1}
            quizScore={quizScore}
            onProgressChange={onProgressChange}
          />
        )}
      </div>
    </Card>
  );
}

/**
 * Learner Notes & Assignments (Phase 11). Migrates legacy learnerNotes()
 * (see Phase 1 analysis, dashboard.html) — Notes and instructor-assigned
 * Assignments for the learner's enrolled modules. Video lessons are
 * deliberately excluded here; they already live in the Phase 10 Module
 * Learning flow.
 */
export default function NotesAndAssignmentsPage() {
  const { user: authUser } = useAuth();
  const { status, errorMessage, learner, modules, relevantNotes, submissionsByNoteId, reload } = useLearnerNotes();

  if (status === "loading") {
    return (
      <div>
        <PageHeader title="Assignments & Notes" />
        <NotesSkeleton />
      </div>
    );
  }

  if (status === "error") {
    return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  }

  if (status === "restricted") {
    return (
      <div>
        <PageHeader title="Assignments & Notes" />
        <UnauthorizedState
          title="Assignments & Notes are hidden"
          description="Your account currently has a payment restriction, so this content isn't available. Resolve it to see your notes and assignments again."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Assignments & Notes" />
      {relevantNotes.length === 0 ? (
        <EmptyState title="Nothing posted yet" description="Nothing has been posted for your modules yet — check back soon." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {relevantNotes.map((n) => {
            const mod = modules.find((m) => m.id === n.course_id);
            const prog = (learner.progress || {})[n.course_id] || {};
            const lessonId = `note:${n.id}`;
            return (
              <NoteCard
                key={n.id}
                note={n}
                moduleTitle={mod ? mod.title : n.course_id}
                userId={authUser.id}
                watchedSeconds={(prog.watched || {})[lessonId] || 0}
                quizScore={(prog.quizScores || {})[lessonId] ?? null}
                submission={submissionsByNoteId.get(n.id)}
                onProgressChange={reload}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
