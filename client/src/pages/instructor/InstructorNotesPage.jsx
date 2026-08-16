import { useRef, useState } from "react";
import { useInstructorNotes } from "./useInstructorNotes";
import { createNote, updateNote, deleteNote, publishNote, unpublishNote, reprocessNote } from "../../api/instructor";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import AssignmentSubmissionsPanel from "./AssignmentSubmissionsPanel";
import {
  PageHeader,
  Card,
  Badge,
  Button,
  FormField,
  Input,
  Textarea,
  Select,
  Checkbox,
  Modal,
  ConfirmationDialog,
  Skeleton,
  EmptyState,
  ErrorState,
} from "../../components/ui";

const KIND_LABEL = { assignment: "Assignment", video_lesson: "Video lesson", note: "Note" };

function NotesSkeleton() {
  return (
    <div>
      <Card padding>
        <Skeleton height={18} width="40%" />
        <div style={{ marginTop: "var(--space-3)" }}>
          <Skeleton height={40} width="100%" />
        </div>
      </Card>
      <div style={{ marginTop: "var(--space-6)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {[1, 2].map((i) => (
          <Card key={i} padding>
            <Skeleton height={16} width="50%" />
          </Card>
        ))}
      </div>
    </div>
  );
}

function PostForm({ modules, classes, campuses, onPosted }) {
  const toast = useToast();
  const [moduleId, setModuleId] = useState(modules[0]?.id || "");
  const [classId, setClassId] = useState(classes[0]?.id || "");
  const [target, setTarget] = useState("all");
  const [kind, setKind] = useState("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [topic, setTopic] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [aiQuiz, setAiQuiz] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef(null);
  // ABRS v2.2 amendment (concurrent Programme Runs) — same pattern as the
  // exam/continuous-assessment authoring pages: `eligibleInstances` is
  // only present on a module (routes/modules.js's GET /mine) when this
  // instructor has more than one currently-Active Run to choose from for
  // it. learningInstanceId holds the choice.
  const selectedModule = modules.find((m) => m.id === moduleId);
  const eligibleInstances = selectedModule?.eligibleInstances || [];
  const [learningInstanceId, setLearningInstanceId] = useState(eligibleInstances.length === 1 ? eligibleInstances[0].id : "");

  function handleModuleChange(id) {
    setModuleId(id);
    const nextModule = modules.find((m) => m.id === id);
    const nextEligible = nextModule?.eligibleInstances || [];
    setLearningInstanceId(nextEligible.length === 1 ? nextEligible[0].id : "");
  }

  async function handlePost() {
    if (!classId) return toast.error("Select the class this is for.");
    if (!title.trim() || !body.trim()) return toast.error("Fill in a title and details.");
    if (kind === "video_lesson" && !videoUrl.trim()) return toast.error("Add the video URL for a video lesson.");
    if (eligibleInstances.length > 1 && !learningInstanceId) return toast.error("Choose which run/cohort this is for.");
    setSubmitting(true);
    try {
      await createNote({
        module: moduleId,
        classId,
        title: title.trim(),
        body: body.trim(),
        target,
        kind,
        videoUrl: videoUrl.trim() || undefined,
        topic: topic.trim() || undefined,
        aiQuizEnabled: aiQuiz,
        learningInstanceId: learningInstanceId || undefined,
        file: fileRef.current?.files?.[0] || null,
      });
      toast.success("Posted.");
      setTitle("");
      setBody("");
      setTopic("");
      setVideoUrl("");
      setAiQuiz(false);
      if (fileRef.current) fileRef.current.value = "";
      onPosted();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card padding>
      <h3 style={{ marginTop: 0 }}>Post a new note, assignment, or video lesson</h3>
      <div className="grid-2">
        <FormField label="Course">
          <Select value={moduleId} onChange={(e) => handleModuleChange(e.target.value)}>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </FormField>
        {eligibleInstances.length > 1 && (
          <FormField label="Which run/cohort?" helperText="This module currently has more than one active run you're assigned to.">
            <Select value={learningInstanceId} onChange={(e) => setLearningInstanceId(e.target.value)}>
              <option value="">Choose…</option>
              {eligibleInstances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name || i.id}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Class">
          <Select value={classId} onChange={(e) => setClassId(e.target.value)}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <FormField label="Campus">
        <Select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="all">All campuses</option>
          {campuses.map((c) => (
            <option key={c.id || c.name} value={c.name}>
              {c.name} only
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Type">
        <Select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="note">Note</option>
          <option value="assignment">Assignment (learners submit work for grading)</option>
          <option value="video_lesson">Video lesson</option>
        </Select>
      </FormField>
      {kind === "video_lesson" && (
        <>
          <FormField label="Topic">
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Sensors & Actuators" />
          </FormField>
          <FormField label="Video URL">
            <Input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..." />
          </FormField>
        </>
      )}
      {kind !== "assignment" && (
        <div style={{ marginBottom: "var(--space-3)" }}>
          <Checkbox label="Generate an AI quiz for this lesson (optional — off by default)" checked={aiQuiz} onChange={(e) => setAiQuiz(e.target.checked)} />
        </div>
      )}
      <FormField label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Assignment: sensor sketch" />
      </FormField>
      <FormField label="Details">
        <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </FormField>
      <FormField label="Attach a file" helperText="Optional">
        <input ref={fileRef} type="file" />
      </FormField>
      <Button variant="primary" loading={submitting} onClick={handlePost}>
        Post
      </Button>
    </Card>
  );
}

function EditNoteModal({ note, modules, classes, onClose, onSaved }) {
  const toast = useToast();
  const [moduleId, setModuleId] = useState(note.course_id);
  const [classId, setClassId] = useState(note.class_id);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [topic, setTopic] = useState(note.topic || "");
  const [videoUrl, setVideoUrl] = useState(note.video_url || "");
  const [aiQuiz, setAiQuiz] = useState(!!note.ai_quiz_enabled);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  // ABRS v2.2 amendment (concurrent Programme Runs) — same as PostForm.
  // Defaults to the note's own current learning_instance_id (if it's
  // still among the eligible options); leaving it unset on save is safe
  // — notes.js only touches learning_instance_id when this key is
  // explicitly present in the PATCH body, so an unset value here means
  // "leave the existing Run assignment alone", not "clear it".
  const selectedModule = modules.find((m) => m.id === moduleId);
  const eligibleInstances = selectedModule?.eligibleInstances || [];
  const [learningInstanceId, setLearningInstanceId] = useState(
    eligibleInstances.some((i) => i.id === note.learning_instance_id) ? note.learning_instance_id : ""
  );

  async function handleSave() {
    if (!title.trim() || !body.trim()) return toast.error("Fill in a title and details.");
    if (note.kind === "video_lesson" && !videoUrl.trim()) return toast.error("Add the video URL for a video lesson.");
    setSaving(true);
    try {
      await updateNote(note.id, {
        module: moduleId,
        classId,
        title: title.trim(),
        body: body.trim(),
        kind: note.kind,
        videoUrl: videoUrl.trim() || undefined,
        topic: topic.trim() || undefined,
        aiQuizEnabled: note.kind !== "assignment" ? aiQuiz : undefined,
        learningInstanceId: learningInstanceId || undefined,
        file: fileRef.current?.files?.[0] || null,
      });
      toast.success("Saved.");
      onSaved();
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
      title={`Edit ${KIND_LABEL[note.kind] || "note"}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <FormField label="Course">
          <Select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
            {modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </FormField>
        {eligibleInstances.length > 1 && (
          <FormField label="Which run/cohort?">
            <Select value={learningInstanceId} onChange={(e) => setLearningInstanceId(e.target.value)}>
              <option value="">Leave as-is</option>
              {eligibleInstances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name || i.id}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Class">
          <Select value={classId} onChange={(e) => setClassId(e.target.value)}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      {note.kind === "video_lesson" && (
        <>
          <FormField label="Topic">
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} />
          </FormField>
          <FormField label="Video URL">
            <Input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />
          </FormField>
        </>
      )}
      {note.kind !== "assignment" && (
        <div style={{ marginBottom: "var(--space-3)" }}>
          <Checkbox label="Generate an AI quiz for this lesson" checked={aiQuiz} onChange={(e) => setAiQuiz(e.target.checked)} />
        </div>
      )}
      <FormField label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
      <FormField label="Details">
        <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </FormField>
      <FormField label="Replace attached file" helperText="Optional">
        <input ref={fileRef} type="file" />
      </FormField>
    </Modal>
  );
}

const AI_STATUS_TONE = { pending: "neutral", processing: "warning", completed: "success", failed: "danger" };
const AI_STATUS_LABEL = { pending: "Quiz: pending", processing: "Quiz: processing…", completed: "Quiz: ready", failed: "Quiz: failed" };

function AiQuizStatus({ note, onRetry }) {
  if (note.kind !== "video_lesson" || !note.ai_quiz_enabled) return null;
  const s = note.ai_status || "pending";
  return (
    <div style={{ marginTop: "var(--space-2)", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
      <Badge tone={AI_STATUS_TONE[s]}>{AI_STATUS_LABEL[s]}</Badge>
      {(s === "failed" || s === "pending") && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry AI processing
        </Button>
      )}
      {s === "failed" && note.ai_error && <span className="text-helper" style={{ color: "var(--color-danger-text)" }}>{note.ai_error}</span>}
    </div>
  );
}

function NoteCard({ note, classById, moduleById, canManage, onEdit, onDelete, onTogglePublish, onRetryAi }) {
  const [showSubmissions, setShowSubmissions] = useState(false);
  return (
    <Card padding className="animate-fade-in">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
        <Badge tone="brand">{moduleById?.get(note.course_id) || note.course_id}</Badge>
        <Badge>{note.class_id ? classById.get(note.class_id) || "Class" : "No class"}</Badge>
        <Badge>{note.target === "all" ? "All campuses" : note.target}</Badge>
        <Badge tone="info">{KIND_LABEL[note.kind] || "Note"}</Badge>
        <Badge tone={note.published ? "success" : "neutral"}>{note.published ? "Published" : "Unpublished"}</Badge>
      </div>
      <h3 style={{ margin: 0 }}>
        {note.title}
        {note.topic ? ` — ${note.topic}` : ""}
      </h3>
      <p style={{ marginTop: "var(--space-2)" }}>{note.body}</p>
      {note.file_path && (
        <a href={note.file_path} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary-700)", fontWeight: "var(--font-weight-semibold)" }}>
          📄 View attached file
        </a>
      )}
      {note.kind === "video_lesson" && note.video_url && (
        <p>
          <a href={note.video_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary-700)", fontWeight: "var(--font-weight-semibold)" }}>
            ▶ Watch video
          </a>
        </p>
      )}
      <AiQuizStatus note={note} onRetry={() => onRetryAi(note.id)} />
      <p className="text-helper" style={{ marginTop: "var(--space-2)" }}>
        Posted {(note.date || "").slice(0, 10)} by {note.posted_by}
      </p>
      {note.kind === "assignment" && (
        <div style={{ marginTop: "var(--space-2)" }}>
          <Button variant="ghost" size="sm" onClick={() => setShowSubmissions((v) => !v)}>
            {showSubmissions ? "Hide submissions" : "View submissions"}
          </Button>
          {showSubmissions && <AssignmentSubmissionsPanel noteId={note.id} />}
        </div>
      )}
      {canManage && (
        <div style={{ marginTop: "var(--space-3)", display: "flex", gap: "var(--space-2)" }}>
          <Button variant="ghost" size="sm" onClick={() => onEdit(note)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onTogglePublish(note)}>
            {note.published ? "Unpublish" : "Publish"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDelete(note)}>
            Delete
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Instructor Notes / Assignments / Video Lessons (Phase 12). Migrates
 * legacy instructorNotes() (dashboard.html) — same fields, same
 * endpoints. Continuous Assessment configuration (the legacy "Continuous
 * Assessment" button on note/video_lesson cards) is intentionally left
 * out of this phase — see FINAL REPORT / strict scope.
 */
export default function InstructorNotesPage() {
  const { user } = useAuth();
  const toast = useToast();
  const { status, errorMessage, notes, campuses, teaching, reload } = useInstructorNotes();
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  if (status === "loading" || teaching.status === "loading") return <NotesSkeleton />;
  if (status === "error") return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  if (teaching.status === "error") return <ErrorState description={teaching.errorMessage} action={{ label: "Try again", onClick: teaching.reload }} />;

  const { modules, classes } = teaching;
  const classById = new Map(classes.map((c) => [c.id, c.name]));
  const moduleById = new Map(modules.map((m) => [m.id, m.title]));

  async function handleTogglePublish(note) {
    try {
      if (note.published) await unpublishNote(note.id);
      else await publishNote(note.id);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleRetryAi(noteId) {
    try {
      await reprocessNote(noteId);
      toast.success("Reprocessing started.");
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDeleteConfirmed() {
    try {
      await deleteNote(deleting.id);
      toast.success("Deleted.");
      reload();
    } catch (e) {
      toast.error(e.message || "Couldn't delete this.");
      throw e; // keep the ConfirmationDialog open on failure (see SettingsModulesTab.jsx's handleDelete for why)
    }
  }

  return (
    <div>
      <PageHeader title="Notes & Assignments" description="Post notes, assignments, and video lessons for your classes." />

      {modules.length === 0 || classes.length === 0 ? (
        <EmptyState
          title="No teaching assignments yet"
          description="You haven't been assigned to any module or class yet — ask an administrator to assign you before posting."
        />
      ) : (
        <PostForm modules={modules} classes={classes} campuses={campuses} onPosted={reload} />
      )}

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2 className="text-section-title">Recent posts</h2>
        {notes.length === 0 ? (
          <EmptyState title="Nothing posted yet" description="Notes, assignments, and video lessons you post will show up here." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {notes.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                classById={classById}
                moduleById={moduleById}
                canManage={n.posted_by === user.name || user.role === "admin"}
                onEdit={setEditing}
                onDelete={setDeleting}
                onTogglePublish={handleTogglePublish}
                onRetryAi={handleRetryAi}
              />
            ))}
          </div>
        )}
      </section>

      {editing && <EditNoteModal note={editing} modules={modules} classes={classes} onClose={() => setEditing(null)} onSaved={reload} />}

      <ConfirmationDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDeleteConfirmed}
        title={`Delete "${deleting?.title || ""}"?`}
        confirmLabel="Delete"
        confirmVariant="danger"
      >
        This can't be undone.
      </ConfirmationDialog>
    </div>
  );
}
