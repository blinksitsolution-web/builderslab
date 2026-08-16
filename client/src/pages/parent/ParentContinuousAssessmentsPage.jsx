import { useParentContinuousAssessments } from "./useParentContinuousAssessments";
import WardPicker from "./WardPicker";
import { PageHeader, Card, Button, DataTable, Skeleton, EmptyState, ErrorState, UnauthorizedState } from "../../components/ui";

/**
 * Continuous Assessment results (Phase 22) — migrates legacy
 * parentContinuousAssessment() / loadParentCA() (dashboard.html).
 */
export default function ParentContinuousAssessmentsPage() {
  const {
    childrenStatus,
    childrenError,
    availableWards,
    reloadChildren,
    selectedChildId,
    setSelectedChildId,
    status,
    restricted,
    results,
    moduleTitles,
    errorMessage,
    reload,
  } = useParentContinuousAssessments();

  if (childrenStatus === "loading") {
    return (
      <div>
        <PageHeader title="Continuous Assessment" />
        <Skeleton height={120} width="100%" />
      </div>
    );
  }

  if (childrenStatus === "error") {
    return <ErrorState description={childrenError} action={{ label: "Try again", onClick: reloadChildren }} />;
  }

  if (availableWards.length === 0) {
    return (
      <div>
        <PageHeader title="Continuous Assessment" />
        <EmptyState title="No learner linked to this account yet" />
      </div>
    );
  }

  const columns = [
    { key: "title", header: "Assessment", render: (r) => r.title },
    { key: "module", header: "Module", render: (r) => moduleTitles[r.course_id] || r.course_id || "—" },
    { key: "score", header: "Score", render: (r) => `${r.total_marks}/${r.max_marks} (${Math.round(r.percentage)}%)` },
    { key: "date", header: "Date", render: (r) => (r.submitted_at || "").slice(0, 10) },
  ];

  return (
    <div>
      <PageHeader title="Continuous Assessment" />

      <Card padding className="no-print">
        <WardPicker wards={availableWards} selectedId={selectedChildId} onChange={setSelectedChildId} />
      </Card>

      <div style={{ marginTop: "var(--space-4)" }}>
        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}

        {status === "ready" && restricted && (
          <UnauthorizedState
            title="Continuous Assessment results unavailable"
            description="This account currently has a payment restriction, so results aren't available. Resolve it from Payments to continue."
          />
        )}

        {(status === "loading" || (status === "ready" && !restricted)) && (
          <Card padding>
            <div style={{ textAlign: "right", marginBottom: "var(--space-3)" }} className="no-print">
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                🖨 Print / Save as PDF
              </Button>
            </div>
            <DataTable
              columns={columns}
              rows={results}
              getRowKey={(r) => r.id}
              loading={status === "loading"}
              emptyState={<EmptyState title="No results published yet" />}
            />
          </Card>
        )}
      </div>
    </div>
  );
}
