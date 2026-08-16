import { useState } from "react";
import { useInstructorContinuousAssessments } from "./useInstructorContinuousAssessments";
import {
  createContinuousAssessment,
  updateContinuousAssessment,
  deleteContinuousAssessment,
  publishContinuousAssessment,
  unpublishContinuousAssessment,
  fetchContinuousAssessmentAttempts,
} from "../../api/instructor";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import {
  PageHeader,
  Card,
  Button,
  FormField,
  Input,
  Select,
  Checkbox,
  Badge,
  Modal,
  ConfirmationDialog,
  Skeleton,
  EmptyState,
  ErrorState,
  UnauthorizedState,
  DataTable,
} from "../../components/ui";

const ATTEMPT_STATUS_LABELS = {
  in_progress: "In progress",
  submitted: "Submitted",
  expired: "Time expired",
  closing_date: "Closing date passed",
  violation: "Ended — left assessment twice",
};

function attemptStatusLabel(row) {
  return row.status === "in_progress" ? ATTEMPT_STATUS_LABELS.in_progress : ATTEMPT_STATUS_LABELS[row.ended_reason] || "Submitted";
}

function isoToDatetimeLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function emptyMcq() {
  return { type: "mcq", question: "", options: ["", "", "", ""], correctAnswer: 0, marks: 1 };
}
function emptyTrueFalse() {
  return { type: "true_false", question: "", options: ["True", "False"], correctAnswer: 0, marks: 1 };
}

/** Shared question-builder used by both the create and edit dialogs. */
function QuestionBuilder({ questions, setQuestions }) {
  function update(index, patch) {
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }
  function updateOption(qIndex, oIndex, value) {
    setQuestions((qs) => qs.map((q, i) => (i === qIndex ? { ...q, options: q.options.map((o, oi) => (oi === oIndex ? value : o)) } : q)));
  }
  function remove(index) {
    setQuestions((qs) => qs.filter((_, i) => i !== index));
  }
  return (
    <div>
      {questions.map((q, qi) => (
        <Card key={qi} padding style={{ background: "var(--color-surface-subtle, #f7f4ef)", marginBottom: "var(--space-3)" }}>
          <Badge tone="neutral">{q.type === "true_false" ? "True / False" : "Multiple Choice"}</Badge>
          <FormField label={`Question ${qi + 1}`}>
            <Input value={q.question} onChange={(e) => update(qi, { question: e.target.value })} />
          </FormField>
          {q.options.map((o, oi) => (
            <div key={oi} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
              <input type="radio" name={`ca-correct-${qi}`} checked={q.correctAnswer === oi} onChange={() => update(qi, { correctAnswer: oi })} />
              {q.type === "true_false" ? <span>{o}</span> : <Input value={o} placeholder={`Option ${oi + 1}`} style={{ flex: 1 }} onChange={(e) => updateOption(qi, oi, e.target.value)} />}
            </div>
          ))}
          <FormField label="Marks">
            <Input type="number" min="1" value={q.marks} style={{ maxWidth: 100 }} onChange={(e) => update(qi, { marks: Number(e.target.value) })} />
          </FormField>
          <Button variant="ghost" size="sm" onClick={() => remove(qi)}>
            Remove question
          </Button>
        </Card>
      ))}
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <Button variant="ghost" size="sm" onClick={() => setQuestions((qs) => [...qs, emptyMcq()])}>
          + Multiple Choice
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setQuestions((qs) => [...qs, emptyTrueFalse()])}>
          + True / False
        </Button>
      </div>
    </div>
  );
}

function CaResults({ assessmentId }) {
  const [status, setStatus] = useState("idle");
  const [attempts, setAttempts] = useState([]);
  const [open, setOpen] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (status === "ready") return;
    setStatus("loading");
    try {
      const rows = await fetchContinuousAssessmentAttempts(assessmentId);
      setAttempts(rows);
      setStatus("ready");
    } catch (e) {
      setStatus("error");
    }
  }

  return (
    <div style={{ marginTop: "var(--space-2)" }}>
      <Button variant="ghost" size="sm" onClick={toggle}>
        {open ? "Hide results" : "Results"}
      </Button>
      {open && status === "loading" && <Skeleton height={60} width="100%" />}
      {open && status === "error" && <ErrorState description="Couldn't load results." />}
      {open && status === "ready" && (
        <DataTable
          columns={[
            { key: "learner_name", header: "Learner" },
            { key: "percentage", header: "Score", render: (r) => (r.percentage === null ? "—" : `${r.percentage}%`) },
            { key: "status", header: "Status", render: attemptStatusLabel },
            { key: "submitted_at", header: "Submitted", render: (r) => (r.submitted_at || "").slice(0, 10) },
          ]}
          rows={attempts}
          getRowKey={(r) => r.id}
          emptyState={<EmptyState title="No attempts yet" description="Learner attempts will show up here once someone sits this assessment." />}
        />
      )}
    </div>
  );
}

/**
 * Instructor Continuous Assessment management (Phase 14) — migrates legacy
 * openCaManager()/saveCa()/publishCa()/deleteCaConfirm() (dashboard.html)
 * onto the existing backend (server/src/routes/continuousAssessments.js),
 * including the Phase 13 closing-date/timed-attempt configuration fields.
 * Edit/publish/unpublish/delete stay restricted to the assessment's
 * creator server-side (assertCanManageAssessment) — this page mirrors that
 * by hiding those actions for a co-instructor viewing the same module's CA,
 * not by re-deciding authorization itself.
 */
export default function InstructorContinuousAssessmentsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const { teaching, moduleId, setModuleId, notesStatus, eligibleNotes, noteId, setNoteId, status, assessments, errorMessage, reload, eligibleInstances, learningInstanceId, setLearningInstanceId, classId, setClassId } =
    useInstructorContinuousAssessments();

  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [title, setTitle] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [timedEnabled, setTimedEnabled] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState("");
  const [questions, setQuestions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  if (teaching.status === "loading") {
    return (
      <div>
        <PageHeader title="Continuous Assessment" />
        <Skeleton height={160} width="100%" />
      </div>
    );
  }
  if (teaching.status === "error") {
    return <ErrorState description={teaching.errorMessage} action={{ label: "Try again", onClick: teaching.reload }} />;
  }
  if (teaching.modules.length === 0) {
    return (
      <div>
        <PageHeader title="Continuous Assessment" />
        <EmptyState title="No modules assigned yet" description="Once an administrator assigns you to a module, you can manage Continuous Assessments here." />
      </div>
    );
  }

  function openCreate() {
    setEditingId(null);
    setTitle("");
    setClosesAt("");
    setTimedEnabled(false);
    setDurationMinutes("");
    setQuestions([]);
    setBuilderOpen(true);
  }
  function openEdit(a) {
    setEditingId(a.id);
    setTitle(a.title);
    setClosesAt(isoToDatetimeLocal(a.closesAt));
    setTimedEnabled(!!a.timedEnabled);
    setDurationMinutes(a.durationMinutes || "");
    setQuestions(a.questions.map((q) => ({ type: q.type, question: q.question, options: q.options.slice(), correctAnswer: q.correctAnswer, marks: q.marks })));
    setBuilderOpen(true);
  }

  async function handleSave() {
    if (!title.trim()) return toast.error("Give the assessment a title.");
    if (!questions.length) return toast.error("Add at least one question.");
    for (const q of questions) {
      if (!q.question.trim()) return toast.error("Fill in every question.");
      if (q.type === "mcq" && q.options.some((o) => !o.trim())) return toast.error("Fill in all 4 options for every Multiple Choice question.");
    }
    if (timedEnabled && (!durationMinutes || Number(durationMinutes) <= 0)) {
      return toast.error("Set a positive duration (in minutes) for the timed attempt.");
    }
    // ABRS v2.2 amendment (concurrent Programme Runs): same guard as
    // InstructorExaminationsPage — only applies to a brand-new assessment
    // (editingId means the Run was already fixed at creation time).
    if (!editingId && eligibleInstances.length > 1 && !learningInstanceId) {
      return toast.error("Choose which run/cohort this assessment is for.");
    }
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        questions,
        closesAt: closesAt ? new Date(closesAt).toISOString() : "",
        timedEnabled,
        durationMinutes: timedEnabled ? Number(durationMinutes) : undefined,
      };
      if (editingId) {
        await updateContinuousAssessment(editingId, payload);
        toast.success("Continuous Assessment updated.");
      } else {
        await createContinuousAssessment({ moduleId, noteId, ...payload, closesAt: payload.closesAt || undefined, learningInstanceId: learningInstanceId || undefined, classId: classId || undefined });
        toast.success("Continuous Assessment created.");
      }
      setBuilderOpen(false);
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePublish(a) {
    try {
      if (a.published) await unpublishContinuousAssessment(a.id);
      else await publishContinuousAssessment(a.id);
      toast.success(a.published ? "Unpublished." : "Published.");
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDelete() {
    // Rethrow after the toast, same reasoning as SettingsModulesTab.jsx's
    // handleDelete: ConfirmationDialog closes unconditionally on a
    // resolved onConfirm, so swallowing the error here would make a
    // failed delete look like it succeeded.
    try {
      await deleteContinuousAssessment(deleteTarget.id);
      toast.success("Continuous Assessment deleted.");
      setDeleteTarget(null);
      reload();
    } catch (e) {
      toast.error(e.message || "Couldn't delete this Continuous Assessment.");
      throw e;
    }
  }

  return (
    <div>
      <PageHeader
        title="Continuous Assessment"
        description="Manage Continuous Assessments attached to your notes and video lessons — independent of AI-generated quizzes."
        actions={
          <Button variant="primary" onClick={openCreate} disabled={!noteId}>
            + New assessment
          </Button>
        }
      />

      <Card padding>
        <FormField label="Course">
          <Select value={moduleId || ""} onChange={(e) => setModuleId(e.target.value)}>
            {teaching.modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </FormField>
        {/* ABRS v2.2 amendment (concurrent Programme Runs) — same pattern
            as InstructorExaminationsPage; only rendered when this module
            currently has more than one Active Run you're assigned to. */}
        {eligibleInstances.length > 1 && (
          <FormField label="Which run/cohort?" helperText="This module currently has more than one active run you're assigned to — choose which one this assessment is for.">
            <Select value={learningInstanceId || ""} onChange={(e) => setLearningInstanceId(e.target.value)}>
              <option value="">Choose…</option>
              {eligibleInstances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name || i.id}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Class" helperText="Optional — leave as 'All classes' for it to apply to every class studying this module.">
          <Select value={classId || ""} onChange={(e) => setClassId(e.target.value || null)}>
            <option value="">All classes</option>
            {teaching.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
        {teaching.classes.find((c) => c.id === classId)?.campusName && (
          <p className="text-helper" style={{ marginTop: "calc(-1 * var(--space-2))", marginBottom: "var(--space-3)" }}>
            Campus: {teaching.classes.find((c) => c.id === classId).campusName}
          </p>
        )}
        <FormField label="Note / video lesson">
          {notesStatus === "loading" ? (
            <Skeleton height={36} width="100%" />
          ) : (
            <Select value={noteId || ""} onChange={(e) => setNoteId(e.target.value)} disabled={eligibleNotes.length === 0}>
              {eligibleNotes.length === 0 ? (
                <option value="">No notes or video lessons in this module yet</option>
              ) : (
                eligibleNotes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))
              )}
            </Select>
          )}
        </FormField>
      </Card>

      <section style={{ marginTop: "var(--space-6)" }}>
        {status === "loading" && <Skeleton height={100} width="100%" />}
        {status === "forbidden" && <UnauthorizedState description={errorMessage} />}
        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}
        {status === "ready" && eligibleNotes.length === 0 && (
          <EmptyState title="No notes or video lessons yet" description="Post a note or video lesson for this module first, then attach a Continuous Assessment to it." />
        )}
        {status === "ready" && eligibleNotes.length > 0 && assessments.length === 0 && (
          <EmptyState title="No Continuous Assessments yet" description="Create one for this note using the button above." />
        )}
        {status === "ready" && assessments.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {assessments.map((a) => {
              const canManage = user?.role === "admin" || a.createdBy === user?.name;
              return (
                <Card key={a.id} padding>
                  <Badge tone={a.published ? "success" : "neutral"}>{a.published ? "Published" : "Draft"}</Badge>
                  <h3 style={{ marginTop: "var(--space-2)" }}>{a.title}</h3>
                  <p className="text-helper">
                    {a.questions.length} question(s) · {a.maxMarks} mark(s) · by {a.createdBy}
                  </p>
                  <p className="text-helper">
                    {a.closesAt ? `Closes ${new Date(a.closesAt).toLocaleString()}` : "No closing date"}
                    {" · "}
                    {a.timedEnabled ? `Timed — ${a.durationMinutes} min` : "Untimed"}
                  </p>
                  <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-2)" }}>
                    {canManage && (
                      <Button variant="ghost" size="sm" onClick={() => openEdit(a)}>
                        Edit
                      </Button>
                    )}
                    {canManage && (
                      <Button variant="ghost" size="sm" onClick={() => handleTogglePublish(a)}>
                        {a.published ? "Unpublish" : "Publish"}
                      </Button>
                    )}
                    {canManage && (
                      <Button variant="danger" size="sm" onClick={() => setDeleteTarget(a)}>
                        Delete
                      </Button>
                    )}
                  </div>
                  <CaResults assessmentId={a.id} />
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <Modal open={builderOpen} onClose={() => setBuilderOpen(false)} title={editingId ? "Edit Continuous Assessment" : "New Continuous Assessment"} size="lg">
        <FormField label="Assessment title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sensors Continuous Assessment" />
        </FormField>
        <FormField label="Closing date/time" helperText="Optional — leave blank for no closing-date restriction.">
          <Input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
        </FormField>
        <Checkbox label="Timed attempt" checked={timedEnabled} onChange={(e) => setTimedEnabled(e.target.checked)} />
        {timedEnabled && (
          <FormField label="Duration (minutes)" className="mt-2">
            <Input type="number" min="1" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} placeholder="e.g. 15" />
          </FormField>
        )}
        <QuestionBuilder questions={questions} setQuestions={setQuestions} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
          <Button variant="ghost" onClick={() => setBuilderOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>
            Save
          </Button>
        </div>
      </Modal>

      <ConfirmationDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete this Continuous Assessment?"
        confirmLabel="Delete"
        confirmVariant="danger"
      >
        {deleteTarget && (
          <p>
            This permanently deletes “{deleteTarget.title}” and every learner attempt recorded against it. This can't be undone.
          </p>
        )}
      </ConfirmationDialog>
    </div>
  );
}
