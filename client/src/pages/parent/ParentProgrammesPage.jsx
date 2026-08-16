import { useState } from "react";
import { useParentProgrammes } from "./useParentProgrammes";
import WardPicker from "./WardPicker";
import EnrolAdditionalProgrammeModal from "./EnrolAdditionalProgrammeModal";
import PayEnrolmentModal from "./PayEnrolmentModal";
import { PageHeader, Card, Badge, Button, DataTable, Skeleton, EmptyState, ErrorState } from "../../components/ui";

const STATUS_TONE = { active: "success", completed: "neutral", pending_payment: "warning", suspended: "danger" };
const STATUS_LABEL = { active: "Active", completed: "Completed", pending_payment: "Awaiting payment", suspended: "Suspended" };

/**
 * My Programmes (Phase 22, completed Phase 33) — migrates
 * parentProgrammes() / renderMyProgrammesPanel() (dashboard.html) in
 * full: the read side (a Ward picker plus that child's enrolments) plus
 * the "+ Enrol in another programme" wizard and its "Pay to activate"
 * step, previously left on the legacy page (see useParentProgrammes.js
 * and EnrolAdditionalProgrammeModal.jsx / PayEnrolmentModal.jsx for the
 * endpoint-by-endpoint mapping). This was the last functional React ->
 * legacy bridge in the app.
 */
export default function ParentProgrammesPage() {
  const {
    childrenStatus,
    childrenError,
    availableWards,
    reloadChildren,
    selectedChildId,
    setSelectedChildId,
    status,
    enrolments,
    errorMessage,
    reload,
  } = useParentProgrammes();

  const [enrolModalOpen, setEnrolModalOpen] = useState(false);
  const [payTarget, setPayTarget] = useState(null); // { enrollmentId, programmeName } | null

  const selectedChildName = availableWards.find((w) => w.id === selectedChildId)?.name;

  function openPayFor(enrollmentId, programmeName) {
    setPayTarget({ enrollmentId, programmeName });
  }

  function handleEnrolled(enrolment) {
    setEnrolModalOpen(false);
    openPayFor(enrolment.id, enrolment.programmeName);
  }

  function handlePaymentSuccess() {
    reload();
  }

  if (childrenStatus === "loading") {
    return (
      <div>
        <PageHeader title="My Programmes" />
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
        <PageHeader title="My Programmes" />
        <EmptyState title="No learner linked to this account yet" />
      </div>
    );
  }

  const columns = [
    { key: "programme", header: "Programme", render: (e) => `${e.offeringTypeIcon || ""} ${e.programmeName}${e.isPrimary ? " (original)" : ""}` },
    { key: "offering", header: "Offering", render: (e) => e.offeringTypeName || "—" },
    { key: "class", header: "Batch / Cohort", render: (e) => e.className || "—" },
    { key: "run", header: "Run", render: (e) => e.learningInstanceName || (e.learningInstanceId ? "Current run" : "—") },
    { key: "status", header: "Status", render: (e) => <Badge tone={STATUS_TONE[e.status] || "neutral"}>{STATUS_LABEL[e.status] || e.status}</Badge> },
    {
      key: "action",
      header: "",
      render: (e) =>
        e.status === "pending_payment" ? (
          <Button variant="ghost" size="sm" onClick={() => openPayFor(e.id, e.programmeName)}>
            Pay to activate
          </Button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="My Programmes"
        actions={
          <Button variant="secondary" onClick={() => setEnrolModalOpen(true)}>
            + Enrol in another programme
          </Button>
        }
      />

      <Card padding>
        <WardPicker wards={availableWards} selectedId={selectedChildId} onChange={setSelectedChildId} />
      </Card>

      <div style={{ marginTop: "var(--space-4)" }}>
        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}

        <Card padding>
          <DataTable
            columns={columns}
            rows={enrolments}
            getRowKey={(e) => e.id}
            loading={status === "loading"}
            emptyState={<EmptyState title="Nothing enrolled yet" />}
          />
        </Card>
      </div>

      <EnrolAdditionalProgrammeModal
        open={enrolModalOpen}
        onClose={() => setEnrolModalOpen(false)}
        childId={selectedChildId}
        childName={selectedChildName}
        onEnrolled={handleEnrolled}
      />

      <PayEnrolmentModal
        open={!!payTarget}
        onClose={() => setPayTarget(null)}
        childId={selectedChildId}
        childName={selectedChildName}
        enrollmentId={payTarget?.enrollmentId}
        programmeName={payTarget?.programmeName}
        country={availableWards.find((w) => w.id === selectedChildId)?.data?.country}
        onSuccess={handlePaymentSuccess}
      />
    </div>
  );
}
