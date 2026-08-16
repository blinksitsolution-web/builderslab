import { useRef, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { useLearnerProjects } from "./useLearnerProjects";
import { submitProject } from "../../api/learner";
import { PageHeader, Card, Badge, Button, FormField, Input, Textarea, Select, EmptyState, ErrorState, UnauthorizedState, Skeleton } from "../../components/ui";

function ProjectsSkeleton() {
  return (
    <div>
      <Card padding>
        <Skeleton height={18} width="30%" />
        <div style={{ marginTop: "var(--space-3)" }}>
          <Skeleton height={40} width="100%" />
        </div>
      </Card>
      <div style={{ marginTop: "var(--space-6)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {[1, 2].map((i) => (
          <Card key={i} padding>
            <Skeleton height={16} width="40%" />
          </Card>
        ))}
      </div>
    </div>
  );
}

function ProjectRow({ project }) {
  const graded = project.grade != null || project.mark != null;
  return (
    <Card padding className="animate-fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}>{project.title}</p>
          <p className="text-helper" style={{ margin: 0 }}>
            {project.module} · {new Date(project.date).toLocaleDateString()}
          </p>
          {project.description && <p style={{ marginTop: "var(--space-2)" }}>{project.description}</p>}
          {project.filePath && (
            <a href={project.filePath} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-primary-700)", fontWeight: "var(--font-weight-semibold)" }}>
              View submitted {project.mediaType === "video" ? "video" : project.mediaType === "image" ? "image" : "file"}
            </a>
          )}
          {graded && project.feedback && (
            <p className="text-helper" style={{ marginTop: "var(--space-2)" }}>
              {project.feedback}
            </p>
          )}
        </div>
        <Badge tone={graded ? "success" : "neutral"}>{graded ? `Graded${project.grade ? `: ${project.grade}` : ""}` : "Pending review"}</Badge>
      </div>
    </Card>
  );
}

function NewProjectForm({ userId, enrolledModules, onSubmitted }) {
  const toast = useToast();
  const [moduleId, setModuleId] = useState(enrolledModules[0]?.id || "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const fileInputRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!moduleId || !title.trim()) {
      toast.error("Choose a module and enter a title before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      const file = fileInputRef.current?.files?.[0] || null;
      await submitProject(userId, { moduleId, title: title.trim(), description: description.trim(), file });
      toast.success("Project submitted for grading.");
      setTitle("");
      setDescription("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      onSubmitted?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card padding>
      <h3 style={{ marginTop: 0 }}>Submit a new project</h3>
      <FormField label="Course">
        <Select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
          {enrolledModules.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
      <FormField label="Description" helperText="Optional">
        <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </FormField>
      <FormField label="Photo or video" helperText="Optional">
        <input ref={fileInputRef} type="file" accept="image/*,video/*" />
      </FormField>
      <Button variant="primary" loading={submitting} onClick={handleSubmit}>
        Submit for grading
      </Button>
    </Card>
  );
}

/**
 * Learner Projects (Phase 11). Migrates legacy learnerProjects() /
 * submitProject() (see Phase 1 analysis, dashboard.html) — open-ended
 * project/media submissions, distinct from instructor-assigned
 * Assignments (see Notes & Assignments page). Existing submissions come
 * straight from GET /api/users/:id, which already redacts `projects` and
 * `modules` to empty for a restricted learner (see userView.js); the
 * explicit `learner.accessRestricted` check below only swaps in a clear
 * restricted message instead of letting that redaction silently read as
 * "no projects yet" (see Phase 11 section 7/10 requirements).
 */
export default function ProjectsPage() {
  const { user: authUser } = useAuth();
  const { status, errorMessage, learner, enrolledModules, reload } = useLearnerProjects();

  if (status === "loading") {
    return (
      <div>
        <PageHeader title="Projects" />
        <ProjectsSkeleton />
      </div>
    );
  }

  if (status === "error") {
    return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  }

  if (learner.accessRestricted) {
    return (
      <div>
        <PageHeader title="Projects" />
        <UnauthorizedState
          title="Projects are hidden"
          description="Your account currently has a payment restriction, so this content isn't available. Resolve it to see your projects again."
        />
      </div>
    );
  }

  const projects = learner.projects || [];

  return (
    <div>
      <PageHeader title="Projects" description="Submit open-ended projects for grading and track feedback here." />

      {enrolledModules.length > 0 ? (
        <NewProjectForm userId={authUser.id} enrolledModules={enrolledModules} onSubmitted={reload} />
      ) : (
        <EmptyState title="No modules enrolled yet" description="Once you're enrolled in a module, you'll be able to submit a project for it here." />
      )}

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2 className="text-section-title">Your submissions</h2>
        {projects.length === 0 ? (
          <EmptyState title="No projects submitted yet" description="Projects you submit will show up here, along with grading feedback once it's available." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {projects.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
