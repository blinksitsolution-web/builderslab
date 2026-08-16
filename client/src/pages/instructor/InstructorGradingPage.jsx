import { useState } from "react";
import { useInstructorGrading } from "./useInstructorGrading";
import { gradeProject } from "../../api/instructor";
import { useToast } from "../../context/ToastContext";
import { PageHeader, Card, Badge, Button, FormField, Input, Select, Skeleton, EmptyState, ErrorState } from "../../components/ui";

const GRADE_OPTIONS = ["", "A", "B", "C", "D"];

function ProjectGradeCard({ project, moduleTitle, onSaved }) {
  const toast = useToast();
  const [grade, setGrade] = useState(project.grade || "");
  const [mark, setMark] = useState(project.mark != null ? String(project.mark) : "");
  const [feedback, setFeedback] = useState(project.feedback || "");
  const [saving, setSaving] = useState(false);
  const graded = project.grade || project.mark != null;

  async function handleSave() {
    setSaving(true);
    try {
      await gradeProject(project.id, grade || null, mark !== "" ? mark : null, feedback);
      toast.success("Grade saved.");
      onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card padding>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)" }}>
        <div>
          <p style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}>{project.title}</p>
          <p className="text-helper" style={{ margin: 0 }}>
            {project.learnerName} · {moduleTitle} · {(project.date || "").slice(0, 10)}
          </p>
          {project.description && <p style={{ marginTop: "var(--space-2)" }}>{project.description}</p>}
        </div>
        <Badge tone={graded ? "success" : "warning"}>
          {graded ? `Graded${project.grade ? `: ${project.grade}` : ""}${project.mark != null ? ` (${project.mark})` : ""}` : "Pending"}
        </Badge>
      </div>
      {project.file_path &&
        (project.media_type === "video" ? (
          <video src={project.file_path} controls style={{ maxWidth: "100%", marginTop: "var(--space-3)", borderRadius: "var(--radius-md)" }} />
        ) : (
          <img src={project.file_path} alt="" style={{ maxWidth: "100%", marginTop: "var(--space-3)", borderRadius: "var(--radius-md)" }} />
        ))}
      <div className="grid-3" style={{ marginTop: "var(--space-3)" }}>
        <FormField label="Grade">
          <Select value={grade} onChange={(e) => setGrade(e.target.value)}>
            {GRADE_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {g || "—"}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Numeric mark">
          <Input type="number" min="0" max="100" value={mark} onChange={(e) => setMark(e.target.value)} placeholder="e.g. 85" />
        </FormField>
        <FormField label="Feedback">
          <Input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Great work, try..." />
        </FormField>
      </div>
      <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
        Save grade
      </Button>
    </Card>
  );
}

/**
 * Instructor Grade Projects (Phase 12). Migrates legacy
 * instructorGrading() / gradeProject() (dashboard.html) — same endpoint
 * (PATCH /api/projects/:projectId/grade), same free-text grade + numeric
 * mark + feedback model (not replaced with a new grading scale).
 */
export default function InstructorGradingPage() {
  const {
    teaching,
    status,
    projects,
    errorMessage,
    moduleFilter,
    setModuleFilter,
    classFilter,
    setClassFilter,
    instanceFilter,
    setInstanceFilter,
    eligibleInstances,
    reload,
  } = useInstructorGrading();
  const moduleById = new Map(teaching.modules.map((m) => [m.id, m.title]));
  const classById = new Map(teaching.classes.map((c) => [c.id, c]));

  return (
    <div>
      <PageHeader title="Grade Projects" description="Review learner project submissions and record a grade." />
      <Card padding>
        <div className="grid-3">
          <FormField label="Filter by module" helperText="Optional">
            <Select
              value={moduleFilter}
              onChange={(e) => {
                setModuleFilter(e.target.value);
                setInstanceFilter("");
              }}
            >
              <option value="">All modules</option>
              {teaching.modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Filter by class" helperText="Optional — by the submitting learner's own class">
            <Select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
              <option value="">All classes</option>
              {teaching.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          {/* Only meaningful once a module with more than one eligible Run
              is picked — matches the same concurrent-Runs pattern used on
              Topics/Attendance/Examinations. */}
          {eligibleInstances.length > 1 && (
            <FormField label="Filter by run/cohort" helperText="Optional">
              <Select value={instanceFilter} onChange={(e) => setInstanceFilter(e.target.value)}>
                <option value="">All runs</option>
                {eligibleInstances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name || i.id}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>
        {classFilter && classById.get(classFilter)?.campusName && (
          <p className="text-helper" style={{ marginTop: "var(--space-3)" }}>
            Campus: {classById.get(classFilter).campusName}
          </p>
        )}
      </Card>

      <div style={{ marginTop: "var(--space-6)" }}>
        {status === "loading" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {[1, 2].map((i) => (
              <Card key={i} padding>
                <Skeleton height={16} width="50%" />
              </Card>
            ))}
          </div>
        )}
        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}
        {status === "ready" && projects.length === 0 && <EmptyState title="No project submissions yet" description="Learner project submissions will show up here." />}
        {status === "ready" && projects.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {projects.map((p) => (
              <ProjectGradeCard key={p.id} project={p} moduleTitle={moduleById.get(p.course_id) || p.course_id} onSaved={reload} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
