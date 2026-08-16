import { useEffect, useState } from "react";
import { fetchAssignmentSubmissions, gradeAssignment } from "../../api/instructor";
import { useToast } from "../../context/ToastContext";
import { Button, Badge, Modal, FormField, Input, Textarea, Skeleton, EmptyState, ErrorState } from "../../components/ui";

function GradeSubmissionModal({ submission, onClose, onGraded }) {
  const toast = useToast();
  const [grade, setGrade] = useState(submission.grade || "");
  const [feedback, setFeedback] = useState(submission.feedback || "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await gradeAssignment(submission.id, grade.trim(), feedback.trim());
      toast.success("Grade saved.");
      onGraded();
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${submission.learner_name}'s submission`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>
            Save grade
          </Button>
        </>
      }
    >
      <p className="text-helper">Submitted {(submission.submitted_at || "").slice(0, 10)}</p>
      {submission.text_content && (
        <div style={{ background: "var(--surface-sunken)", padding: "var(--space-3)", borderRadius: "var(--radius-md)", whiteSpace: "pre-wrap", marginBottom: "var(--space-3)" }}>
          {submission.text_content}
        </div>
      )}
      {submission.file_path && (
        <p>
          <a href={submission.file_path} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary-700)", fontWeight: "var(--font-weight-semibold)" }}>
            📄 View submitted file
          </a>
        </p>
      )}
      <FormField label="Grade" helperText="e.g. 85% or A">
        <Input value={grade} onChange={(e) => setGrade(e.target.value)} />
      </FormField>
      <FormField label="Feedback">
        <Textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      </FormField>
    </Modal>
  );
}

/**
 * Submissions for a single assignment-kind Note. Migrates legacy
 * loadAssignmentSubmissions()/openGradeAssignmentModal()/saveAssignmentGrade()
 * (dashboard.html) — same endpoints (GET /api/assignments/:noteId,
 * PATCH /api/assignments/submission/:id/grade), same fields.
 */
export default function AssignmentSubmissionsPanel({ noteId }) {
  const [status, setStatus] = useState("loading");
  const [submissions, setSubmissions] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [grading, setGrading] = useState(null);

  async function load() {
    setStatus("loading");
    try {
      const subs = await fetchAssignmentSubmissions(noteId);
      setSubmissions(subs);
      setStatus("ready");
    } catch (e) {
      setErrorMessage(e.message);
      setStatus("error");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  if (status === "loading") {
    return (
      <div style={{ marginTop: "var(--space-3)" }}>
        <Skeleton height={16} width="60%" />
      </div>
    );
  }

  if (status === "error") {
    return <ErrorState title="Couldn't load submissions" description={errorMessage} action={{ label: "Try again", onClick: load }} />;
  }

  if (submissions.length === 0) {
    return <EmptyState title="No submissions yet" description="Learner submissions for this assignment will show up here." />;
  }

  return (
    <div style={{ marginTop: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {submissions.map((s) => (
        <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-2) 0", borderTop: "1px solid var(--border-default)" }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}>{s.learner_name}</p>
            <p className="text-helper" style={{ margin: 0 }}>
              Submitted {(s.submitted_at || "").slice(0, 10)}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <Badge tone={s.grade != null ? "success" : "warning"}>{s.grade != null ? String(s.grade) : "Ungraded"}</Badge>
            <Button variant="ghost" size="sm" onClick={() => setGrading(s)}>
              Review &amp; grade
            </Button>
          </div>
        </div>
      ))}
      {grading && <GradeSubmissionModal submission={grading} onClose={() => setGrading(null)} onGraded={load} />}
    </div>
  );
}
