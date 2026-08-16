import { useParentProgress } from "./useParentProgress";
import { PageHeader, Card, CardHeader, Badge, ProgressBar, DataTable, Alert, Skeleton, EmptyState, ErrorState } from "../../components/ui";

const ATTENDANCE_TONE = { present: "success", late: "warning", absent: "danger" };

function ProjectRow({ project, moduleTitle }) {
  return (
    <Card padding className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <strong style={{ color: "var(--text-default, inherit)" }}>{project.title}</strong>
          <div>
            {moduleTitle} · {(project.date || "").slice(0, 10)}
          </div>
        </div>
        {project.grade ? <Badge tone="success">Grade: {project.grade}</Badge> : <Badge tone="neutral">Pending</Badge>}
      </div>
      {project.filePath &&
        (project.mediaType === "video" ? (
          <video src={project.filePath} controls style={{ maxWidth: "100%", marginTop: "var(--space-2)", borderRadius: "var(--radius-md)" }} />
        ) : (
          <img src={project.filePath} alt={project.title} style={{ maxWidth: "100%", marginTop: "var(--space-2)", borderRadius: "var(--radius-md)" }} />
        ))}
      {project.feedback && <p style={{ marginTop: "var(--space-2)" }}>Instructor feedback: {project.feedback}</p>}
    </Card>
  );
}

function WardProgressBlock({ block }) {
  const moduleTitleById = new Map(block.modules.map((m) => [m.moduleId, m.title]));

  const moduleColumns = [
    { key: "title", header: "Course", render: (r) => r.title },
    {
      key: "pct",
      header: "Lesson progress",
      render: (r) => (r.restricted ? <span className="text-helper">Unavailable</span> : <ProgressBar value={r.pct ?? 0} label={`${r.title} progress`} />),
    },
    { key: "quiz", header: "Avg quiz score", render: (r) => (r.avgQuiz == null ? "—" : `${r.avgQuiz}%`) },
  ];

  const attendanceColumns = [
    { key: "date", header: "Date", render: (r) => r.date },
    { key: "module", header: "Module", render: (r) => moduleTitleById.get(r.course_id) || r.course_id },
    { key: "status", header: "Status", render: (r) => <Badge tone={ATTENDANCE_TONE[r.status] || "neutral"}>{r.status}</Badge> },
  ];

  return (
    <Card padding style={{ marginBottom: "var(--space-5)" }}>
      <CardHeader title={block.childName} />
      <DataTable columns={moduleColumns} rows={block.modules} getRowKey={(r) => r.moduleId} emptyState={<EmptyState title="No modules enrolled" />} />

      <h4 style={{ marginTop: "var(--space-5)" }}>Recent attendance</h4>
      <DataTable
        columns={attendanceColumns}
        rows={block.attendance}
        getRowKey={(r, i) => `${r.date}-${r.course_id}-${i}`}
        emptyState={<EmptyState title="No attendance recorded yet" />}
      />

      <h4 style={{ marginTop: "var(--space-5)" }}>Projects</h4>
      {block.projects.length === 0 ? (
        <EmptyState title="No submissions yet" />
      ) : (
        block.projects.map((p, i) => <ProjectRow key={p.id || i} project={p} moduleTitle={moduleTitleById.get(p.courseId) || p.courseId} />)
      )}
    </Card>
  );
}

/**
 * My Ward's Progress (Phase 22) — migrates legacy parentProgress()
 * (dashboard.html). Shows every linked child's progress at once,
 * matching legacy (no Ward picker on this one screen).
 */
export default function ParentProgressPage() {
  const { childrenStatus, childrenError, availableWards, reloadChildren, status, lessonsRestricted, blocks, errorMessage, reload } = useParentProgress();

  if (childrenStatus === "loading" || status === "loading") {
    return (
      <div>
        <PageHeader title="My Ward's Progress" />
        <Skeleton height={320} width="100%" />
      </div>
    );
  }

  if (childrenStatus === "error") {
    return <ErrorState description={childrenError} action={{ label: "Try again", onClick: reloadChildren }} />;
  }

  if (status === "error") {
    return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  }

  if (availableWards.length === 0) {
    return (
      <div>
        <PageHeader title="My Ward's Progress" />
        <EmptyState title="No learner linked to this account yet" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="My Ward's Progress" />
      {lessonsRestricted && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Alert variant="warning">
            Lesson progress is unavailable right now because one of your linked accounts has a payment restriction. Attendance and project
            information below are unaffected.
          </Alert>
        </div>
      )}
      {blocks.map((block) => (
        <WardProgressBlock key={block.childId} block={block} />
      ))}
    </div>
  );
}
