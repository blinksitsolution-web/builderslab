import { useAdminLearnerProgress } from "./useAdminLearnerProgress";
import { PageHeader, Card, DataTable, LoadingState, ErrorState, UnauthorizedState, EmptyState } from "../../components/ui";

/**
 * Learner Progress (final admin migration pass). Migrates legacy
 * adminLearnerProgress() (dashboard.html) — one row per learner, listing
 * their campus and per-module completion percentage. See
 * useAdminLearnerProgress.js for why this has no dedicated backend
 * endpoint and reproduces legacy's exact data-assembly flow instead.
 */
export default function AdminLearnerProgressPage() {
  const data = useAdminLearnerProgress();

  return (
    <div>
      <PageHeader title="Learner Progress" />

      {data.status === "loading" && <LoadingState label="Assembling learner progress…" />}
      {data.status === "forbidden" && <UnauthorizedState description="Learner Progress is limited to administrators." />}
      {data.status === "error" && <ErrorState description={data.error} action={{ label: "Try again", onClick: data.reload }} />}

      {data.status === "ready" && (
        <Card padding={false}>
          <DataTable
            columns={[
              { key: "name", header: "Name", render: (r) => r.name },
              { key: "campus", header: "Campus", render: (r) => r.campus || "—" },
              {
                key: "modules",
                header: "Course completion",
                render: (r) => (r.moduleSummaries.length ? r.moduleSummaries.map((m) => `${m.moduleId}: ${m.pct}%`).join(", ") : "—"),
              },
            ]}
            rows={data.rows}
            getRowKey={(r) => r.id}
            emptyState={<EmptyState title="No learners yet" />}
          />
        </Card>
      )}
    </div>
  );
}
