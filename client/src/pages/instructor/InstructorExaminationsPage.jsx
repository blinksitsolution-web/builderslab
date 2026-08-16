import { useState } from "react";
import { useInstructorExams } from "./useInstructorExams";
import { createExam, fetchExamAttempts } from "../../api/instructor";
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
  Skeleton,
  EmptyState,
  ErrorState,
  UnauthorizedState,
  DataTable,
} from "../../components/ui";

const TERM_TYPE_LABELS = { midterm: "Midterm", end_of_term: "End Of Term", retake: "Retake", final: "Final Exam" };
const ATTEMPT_STATUS_LABELS = {
  in_progress: "In progress",
  submitted: "Submitted",
  expired: "Time expired",
  closing_date: "Closing date passed",
  violation: "Ended — left assessment twice",
};

function emptyQuestion() {
  return { question: "", choices: ["", "", "", ""], correctIndex: 0 };
}

function attemptStatusLabel(row) {
  return row.status === "in_progress" ? ATTEMPT_STATUS_LABELS.in_progress : ATTEMPT_STATUS_LABELS[row.ended_reason] || "Submitted";
}

function ExamResults({ examId }) {
  const [status, setStatus] = useState("idle"); // "idle" | "loading" | "ready" | "error"
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
      const rows = await fetchExamAttempts(examId);
      setAttempts(rows);
      setStatus("ready");
    } catch (e) {
      setStatus("error");
    }
  }

  return (
    <div style={{ marginTop: "var(--space-3)" }}>
      <Button variant="ghost" size="sm" onClick={toggle}>
        {open ? "Hide results" : "View results"}
      </Button>
      {open && status === "loading" && <Skeleton height={60} width="100%" />}
      {open && status === "error" && <ErrorState description="Couldn't load results." />}
      {open && status === "ready" && (
        <DataTable
          columns={[
            { key: "learner_name", header: "Learner" },
            { key: "score", header: "Score", render: (r) => (r.score === null ? "—" : `${r.score}%`) },
            { key: "status", header: "Status", render: attemptStatusLabel },
            { key: "submitted_at", header: "Submitted", render: (r) => (r.submitted_at || "").slice(0, 10) },
          ]}
          rows={attempts}
          getRowKey={(r) => r.id}
          emptyState={<EmptyState title="No attempts yet" description="Learner attempts will show up here once someone sits this examination." />}
        />
      )}
    </div>
  );
}

function ExamCard({ exam }) {
  return (
    <Card padding>
      <Badge tone="neutral">{TERM_TYPE_LABELS[exam.termType] || exam.termType}</Badge>
      {exam.termType === "retake" && (
        <span className="text-helper" style={{ marginLeft: "var(--space-2)" }}>
          Assigned to {exam.assignedLearnerIds ? exam.assignedLearnerIds.length : 0} learner(s)
        </span>
      )}
      <h3 style={{ marginTop: "var(--space-2)" }}>{exam.title}</h3>
      <p className="text-helper">{exam.questionCount} question(s)</p>
      <p className="text-helper">
        {exam.closesAt ? `Closes ${new Date(exam.closesAt).toLocaleString()}` : "No closing date"}
        {" · "}
        {exam.timedEnabled ? `Timed — ${exam.durationMinutes} min` : "Untimed"}
      </p>
      <ExamResults examId={exam.id} />
    </Card>
  );
}

/**
 * Instructor Examinations (Phase 14) — migrates legacy instructorExams() /
 * saveExam() / loadInstructorExamList() / loadExamResults() (dashboard.html)
 * onto the existing backend (server/src/routes/exams.js), including the
 * Phase 13 closing-date/timed-attempt configuration fields. The backend
 * remains the sole authority on ownership, allowed Type options per
 * offering type, retake eligibility, and every attempt/deadline/violation
 * rule — this page only authors and lists examinations through it.
 */
export default function InstructorExaminationsPage() {
  const toast = useToast();
  const { teaching, moduleId, setModuleId, termType, setTermType, termTypes, status, exams, errorMessage, reload, retakeLearners, retakeStatus, eligibleInstances, learningInstanceId, setLearningInstanceId, classId, setClassId } =
    useInstructorExams();

  const [title, setTitle] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [timedEnabled, setTimedEnabled] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState("");
  const [questions, setQuestions] = useState([]);
  const [selectedRetakeIds, setSelectedRetakeIds] = useState([]);
  const [saving, setSaving] = useState(false);

  if (teaching.status === "loading") {
    return (
      <div>
        <PageHeader title="Examinations" />
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
        <PageHeader title="Examinations" />
        <EmptyState title="No modules assigned yet" description="Once an administrator assigns you to a module, you can create examinations here." />
      </div>
    );
  }

  function resetForm() {
    setTitle("");
    setClosesAt("");
    setTimedEnabled(false);
    setDurationMinutes("");
    setQuestions([]);
    setSelectedRetakeIds([]);
  }

  function addQuestion() {
    setQuestions((qs) => [...qs, emptyQuestion()]);
  }
  function removeQuestion(index) {
    setQuestions((qs) => qs.filter((_, i) => i !== index));
  }
  function updateQuestion(index, patch) {
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }
  function updateChoice(qIndex, cIndex, value) {
    setQuestions((qs) => qs.map((q, i) => (i === qIndex ? { ...q, choices: q.choices.map((c, ci) => (ci === cIndex ? value : c)) } : q)));
  }
  function toggleRetakeLearner(learnerId) {
    setSelectedRetakeIds((ids) => (ids.includes(learnerId) ? ids.filter((id) => id !== learnerId) : [...ids, learnerId]));
  }

  async function handleCreate() {
    if (!title.trim()) return toast.error("Give the examination a title.");
    if (!questions.length) return toast.error("Add at least one question.");
    for (const q of questions) {
      if (!q.question.trim() || q.choices.some((c) => !c.trim())) return toast.error("Fill in every question and all 4 choices.");
    }
    if (termType === "retake" && !selectedRetakeIds.length) {
      return toast.error("Select at least one Retake-eligible learner to assign this examination to.");
    }
    if (timedEnabled && (!durationMinutes || Number(durationMinutes) <= 0)) {
      return toast.error("Set a positive duration (in minutes) for the timed attempt.");
    }
    // ABRS v2.2 amendment (concurrent Programme Runs): this module has
    // more than one Run you're assigned to right now — don't let the
    // server's "most recently activated" default silently pick one.
    if (eligibleInstances.length > 1 && !learningInstanceId) {
      return toast.error("Choose which run/cohort this examination is for.");
    }
    setSaving(true);
    try {
      await createExam({
        moduleId,
        classId: classId || undefined,
        termType,
        title: title.trim(),
        questions,
        assignedLearnerIds: termType === "retake" ? selectedRetakeIds : undefined,
        closesAt: closesAt ? new Date(closesAt).toISOString() : undefined,
        timedEnabled,
        durationMinutes: timedEnabled ? Number(durationMinutes) : undefined,
        learningInstanceId: learningInstanceId || undefined,
      });
      toast.success("Examination created.");
      resetForm();
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title="Examinations" description="Create midterm, end-of-term, retake, or final examinations for your modules." />

      <Card padding>
        <h3 style={{ marginTop: 0 }}>Create an examination</h3>
        <FormField label="Course">
          <Select value={moduleId || ""} onChange={(e) => setModuleId(e.target.value)}>
            {teaching.modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </FormField>
        {/* ABRS v2.2 amendment (concurrent Programme Runs) — only rendered
            when this module currently has more than one Active Run you're
            assigned to (routes/modules.js's GET /mine only sends
            eligibleInstances in that case). */}
        {eligibleInstances.length > 1 && (
          <FormField label="Which run/cohort?" helperText="This module currently has more than one active run you're assigned to — choose which one this examination is for.">
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
        <FormField label="Type">
          <Select value={termType || ""} onChange={(e) => setTermType(e.target.value)}>
            {termTypes.map((t) => (
              <option key={t} value={t}>
                {TERM_TYPE_LABELS[t] || t}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Exam title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Robotics Midterm — Term 2" />
        </FormField>
        <FormField label="Closing date/time" helperText="Optional — leave blank for no closing-date restriction.">
          <Input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
        </FormField>
        <Checkbox label="Timed attempt" checked={timedEnabled} onChange={(e) => setTimedEnabled(e.target.checked)} />
        {timedEnabled && (
          <FormField label="Duration (minutes)" className="mt-2">
            <Input type="number" min="1" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} placeholder="e.g. 30" />
          </FormField>
        )}

        {termType === "retake" && (
          <Card padding style={{ background: "var(--color-surface-subtle, #f7f4ef)", marginTop: "var(--space-3)" }}>
            <strong>Retake-eligible learners</strong>
            {retakeStatus === "loading" && <Skeleton height={40} width="100%" />}
            {retakeStatus === "ready" && retakeLearners.length === 0 && <p className="text-helper">No learners are currently eligible for a Retake in this module.</p>}
            {retakeStatus === "ready" &&
              retakeLearners.map((l) => (
                <div key={l.id} style={{ marginTop: "var(--space-2)" }}>
                  <Checkbox
                    label={`${l.name}${l.student_code ? ` (${l.student_code})` : ""}`}
                    checked={selectedRetakeIds.includes(l.id)}
                    onChange={() => toggleRetakeLearner(l.id)}
                  />
                </div>
              ))}
          </Card>
        )}

        <div style={{ marginTop: "var(--space-4)" }}>
          {questions.map((q, qi) => (
            <Card key={qi} padding style={{ background: "var(--color-surface-subtle, #f7f4ef)", marginBottom: "var(--space-3)" }}>
              <FormField label={`Question ${qi + 1}`}>
                <Input value={q.question} onChange={(e) => updateQuestion(qi, { question: e.target.value })} />
              </FormField>
              {q.choices.map((c, ci) => (
                <div key={ci} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
                  <input type="radio" name={`correct-${qi}`} checked={q.correctIndex === ci} onChange={() => updateQuestion(qi, { correctIndex: ci })} />
                  <Input value={c} placeholder={`Choice ${ci + 1}`} style={{ flex: 1 }} onChange={(e) => updateChoice(qi, ci, e.target.value)} />
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => removeQuestion(qi)}>
                Remove question
              </Button>
            </Card>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={addQuestion}>
          + Add question
        </Button>
        <div style={{ marginTop: "var(--space-4)" }}>
          <Button variant="primary" loading={saving} onClick={handleCreate}>
            Create examination
          </Button>
        </div>
      </Card>

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2 className="text-section-title">Examinations posted so far</h2>
        <p className="text-helper" style={{ marginTop: "calc(-1 * var(--space-2))" }}>
          Showing examinations for the Course/Class selected above — change them to see examinations from your other assignments.
        </p>
        {status === "loading" && <Skeleton height={100} width="100%" />}
        {status === "forbidden" && <UnauthorizedState description={errorMessage} />}
        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}
        {status === "ready" && exams.length === 0 && <EmptyState title="No examinations created yet" description="Examinations you create for this module will show up here." />}
        {status === "ready" && exams.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {exams.map((exam) => (
              <ExamCard key={exam.id} exam={exam} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
