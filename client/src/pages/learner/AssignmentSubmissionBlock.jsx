import { useRef, useState } from "react";
import { submitAssignment } from "../../api/learner";
import { useToast } from "../../context/ToastContext";
import { Badge, Button, FormField, Textarea } from "../../components/ui";

/**
 * Port of legacy renderLearnerNoteBlock()'s assignment branch +
 * submitLearnerAssignment() (see Phase 1 analysis, dashboard.html):
 * type an answer and/or attach a file, submit (or resubmit — the backend
 * overwrites the previous submission and clears any prior grade), and see
 * grading status once available. Nothing about grading is computed here;
 * `submission.grade`/`.feedback` come straight from the backend.
 */
export default function AssignmentSubmissionBlock({ noteId, submission, onSubmitted }) {
  const toast = useToast();
  const [textContent, setTextContent] = useState(submission?.text_content || "");
  const fileInputRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const file = fileInputRef.current?.files?.[0] || null;
    if (!textContent.trim() && !file) {
      toast.error("Type an answer or attach a file before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      await submitAssignment(noteId, { textContent: textContent.trim(), file });
      toast.success(submission ? "Assignment resubmitted." : "Assignment submitted.");
      onSubmitted?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <FormField label={submission ? "Resubmit — type your answer" : "Type your answer"}>
        <Textarea rows={4} value={textContent} onChange={(e) => setTextContent(e.target.value)} />
      </FormField>
      <FormField label="Or attach a file">
        <input ref={fileInputRef} type="file" />
      </FormField>
      <Button variant="secondary" size="sm" loading={submitting} onClick={handleSubmit}>
        {submission ? "Resubmit" : "Submit"}
      </Button>

      {submission && (
        <div style={{ marginTop: "var(--space-3)" }}>
          {submission.grade != null ? (
            <>
              <Badge tone="success">Graded: {submission.grade}</Badge>
              {submission.feedback && (
                <p className="text-helper" style={{ marginTop: "var(--space-2)" }}>
                  {submission.feedback}
                </p>
              )}
            </>
          ) : (
            <Badge tone="warning">Submitted {(submission.submitted_at || "").slice(0, 10)} — awaiting grading</Badge>
          )}
        </div>
      )}
    </div>
  );
}
