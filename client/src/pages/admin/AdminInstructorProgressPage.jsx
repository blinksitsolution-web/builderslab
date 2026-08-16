import { useMemo } from "react";
import { useAdminInstructorProgress } from "./useAdminInstructorProgress";
import { PageHeader, Card, DataTable, LoadingState, ErrorState, UnauthorizedState, EmptyState } from "../../components/ui";

// Resolves an Offering Type's "Module" terminology label — mirrors the
// legacy instrTerminology() helper (dashboard.html), which itself mirrors
// resolveInstructorTerminology() on the server
// (server/src/utils/offeringTypeSettings.js). Only the moduleLabel field
// is needed for this report's column.
function moduleLabelFor(offeringTypes, offeringTypeId) {
  const t = offeringTypes.find((x) => x.id === offeringTypeId);
  return (t && t.settings && t.settings.terminology && t.settings.terminology.moduleLabel) || "Module";
}

/**
 * Instructor Topic Progress (final admin migration pass). Migrates legacy
 * adminInstructorProgress() (dashboard.html) — one row per
 * instructor/module assignment, with total/completed/remaining topic
 * counts and completion percentage.
 */
export default function AdminInstructorProgressPage() {
  const data = useAdminInstructorProgress();

  const otById = useMemo(() => new Map(data.offeringTypes.map((t) => [t.id, t])), [data.offeringTypes]);

  return (
    <div>
      <PageHeader title="Instructor Topic Progress" />

      {data.status === "loading" && <LoadingState label="Loading instructor progress…" />}
      {data.status === "forbidden" && <UnauthorizedState description="Instructor Topic Progress is limited to administrators." />}
      {data.status === "error" && <ErrorState description={data.error} action={{ label: "Try again", onClick: data.reload }} />}

      {data.status === "ready" && (
        <Card padding={false}>
          <DataTable
            columns={[
              { key: "instructor", header: "Instructor", render: (r) => r.instructorName },
              { key: "offeringType", header: "Learning Offering Type", render: (r) => otById.get(r.offeringTypeId)?.name || "—" },
              { key: "programme", header: "Programme", render: (r) => r.programmeName || "—" },
              { key: "module", header: "Course / Programme", render: (r) => `${moduleLabelFor(data.offeringTypes, r.offeringTypeId)}: ${r.courseTitle}` },
              { key: "total", header: "Total topics", render: (r) => r.totalTopics },
              { key: "completed", header: "Completed", render: (r) => r.completedTopics },
              { key: "remaining", header: "Remaining", render: (r) => r.remainingTopics },
              { key: "pct", header: "Completion", render: (r) => `${r.completionPct}%` },
            ]}
            rows={data.rows}
            getRowKey={(r) => `${r.instructorId}:${r.courseId}`}
            emptyState={<EmptyState title="No instructor/module assignments with topics yet" />}
          />
        </Card>
      )}
    </div>
  );
}
