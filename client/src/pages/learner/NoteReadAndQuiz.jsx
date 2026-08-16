import { useState } from "react";
import { markNoteRead } from "../../api/learner";
import { useToast } from "../../context/ToastContext";
import { Button } from "../../components/ui";
import QuizGate from "./QuizGate";

/**
 * Faithful port of legacy renderLearnerNoteBlock()'s note-quiz gating (see
 * Phase 1 analysis: markNoteReadAndRefresh/startNoteQuiz/submitNoteQuiz in
 * dashboard.html) — a Note reuses the exact same AI-quiz plumbing as a
 * video lesson via a synthetic `note:<id>` lesson id (see progress.js
 * noteLessonId()), gated on "read" (one click) instead of "watched".
 *
 * This wraps the already-migrated QuizGate (Phase 10) rather than
 * reimplementing the quiz UI — only the "mark as read" step in front of
 * it is new, since Notes don't have a watch-progress equivalent.
 */
export default function NoteReadAndQuiz({ userId, moduleId, noteId, read: initialRead, quizScore, onProgressChange }) {
  const toast = useToast();
  const [read, setRead] = useState(initialRead);
  const [marking, setMarking] = useState(false);

  async function handleMarkRead() {
    setMarking(true);
    try {
      await markNoteRead(userId, moduleId, noteId);
      setRead(true);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setMarking(false);
    }
  }

  if (!read) {
    return (
      <Button variant="secondary" size="sm" loading={marking} onClick={handleMarkRead}>
        Mark as read
      </Button>
    );
  }

  return (
    <QuizGate
      userId={userId}
      moduleId={moduleId}
      lesson={{ id: `note:${noteId}` }}
      done={true}
      quizScore={quizScore}
      onScoreChange={onProgressChange}
    />
  );
}
