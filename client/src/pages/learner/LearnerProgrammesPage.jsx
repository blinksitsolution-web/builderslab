import { useState } from "react";
import { useLearnerProgrammes } from "./useLearnerProgrammes";
import { useAuth } from "../../context/AuthContext";
import EnrolAdditionalProgrammeModal from "../parent/EnrolAdditionalProgrammeModal";
import PayEnrolmentModal from "../parent/PayEnrolmentModal";
import { PageHeader, Card, Badge, Button, DataTable, Skeleton, EmptyState, ErrorState, Alert } from "../../components/ui";

const STATUS_TONE = { active: "success", completed: "neutral", pending_payment: "warning", suspended: "danger" };
const STATUS_LABEL = { active: "Active", completed: "Completed", pending_payment: "Awaiting payment", suspended: "Suspended" };

/**
 * My Programmes (final migration pass) — migrates legacy
 * learnerProgrammes()/renderMyProgrammesPanel() (dashboard.html) for an
 * adult learner viewing/managing their own account: the current
 * enrolments table plus the "+ Enrol in another programme" wizard and
 * its "Pay to activate" step.
 *
 * Deliberately reuses EnrolAdditionalProgrammeModal and PayEnrolmentModal
 * from pages/parent/ as-is rather than duplicating them — both already
 * operate on a plain userId/childId with no parent-specific assumptions
 * (see ParentProgrammesPage.jsx), matching the precedent
 * LearnerPaymentsPage.jsx already set by reusing parent/PayMonthlyFeeModal
 * directly. No Ward picker here since a learner only ever manages their
 * own account.
 *
 * Legacy gates this whole panel on `user.is_adult` — a non-adult
 * learner's programme enrolment is handled by their parent's portal
 * instead (see ParentProgrammesPage.jsx). This mirrors that exactly,
 * same as LearnerPaymentsPage.jsx does for Payments.
 */
export default function LearnerProgrammesPage() {
  const { user: authUser } = useAuth();
  const { isAdult, status, errorMessage, enrolments, reload } = useLearnerProgrammes();

  const [enrolModalOpen, setEnrolModalOpen] = useState(false);
  const [payTarget, setPayTarget] = useState(null); // { enrollmentId, programmeName } | null

  if (!isAdult) {
    return (
      <div>
        <PageHeader title="My Programmes" />
        <Alert variant="info">Enrolling into additional programmes is handled by your parent/guardian from their portal.</Alert>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div>
        <PageHeader title="My Programmes" />
        <Skeleton height={280} width="100%" />
      </div>
    );
  }

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

      <EnrolAdditionalProgrammeModal
        open={enrolModalOpen}
        onClose={() => setEnrolModalOpen(false)}
        childId={authUser?.id}
        childName={null}
        onEnrolled={handleEnrolled}
      />

      <PayEnrolmentModal
        open={!!payTarget}
        onClose={() => setPayTarget(null)}
        childId={authUser?.id}
        childName={null}
        enrollmentId={payTarget?.enrollmentId}
        programmeName={payTarget?.programmeName}
        country={authUser?.country}
        onSuccess={handlePaymentSuccess}
      />
    </div>
  );
}
