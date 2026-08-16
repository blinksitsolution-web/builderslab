import { useState } from "react";
import { useParentPayments } from "./useParentPayments";
import WardPicker from "./WardPicker";
import PayMonthlyFeeModal from "./PayMonthlyFeeModal";
import PayPeriodModal from "./PayPeriodModal";
import { PageHeader, Card, Badge, Button, DataTable, Skeleton, EmptyState, ErrorState } from "../../components/ui";

const STATUS_TONE = { successful: "success", pending: "warning" };
// Phase 10 — tone/label for a period payment requirement's overall status
// (utils/periodPayments.js's getPeriodPaymentStatus: "paid" | "partial" |
// "unpaid" | "not_required").
const PERIOD_STATUS_TONE = { paid: "success", partial: "warning", unpaid: "danger", not_required: "neutral" };
const PERIOD_STATUS_LABEL = { paid: "Paid in full", partial: "Paid in part", unpaid: "Not paid", not_required: "No payment required" };

/**
 * Payments (Phase 22, period payments added Phase 10) — migrates legacy
 * parentPayments() / renderPaymentsPanel() (dashboard.html): balance/
 * status, payment history, "Pay via Mobile Money" (PayMonthlyFeeModal),
 * and manual bank/Mobile-Money transfer account details, per selected
 * Ward — plus, new in Phase 10, a Period Payments table that shows every
 * academic-period payment requirement (Learning Instance, period,
 * required mode/amount, amount paid, outstanding balance, status) across
 * that Ward's own Learning Instances, distinct from the flattened payment
 * history below it.
 */
export default function ParentPaymentsPage() {
  const {
    childrenStatus,
    childrenError,
    availableWards,
    reloadChildren,
    selectedChildId,
    setSelectedChildId,
    selectedWard,
    status,
    payments,
    periodPayments,
    paymentAccounts,
    errorMessage,
    reload,
    reloadAfterPayment,
  } = useParentPayments();
  const [payModalOpen, setPayModalOpen] = useState(false);
  // Which Period Payments row (if any) is currently being paid via
  // PayPeriodModal — null means that modal is closed. Set directly from a
  // row's own data (learningInstance/academicPeriod ids + outstanding
  // amount), never re-derived, so the exact same figure the table already
  // showed is what the modal displays.
  const [payPeriodTarget, setPayPeriodTarget] = useState(null);

  if (childrenStatus === "loading") {
    return (
      <div>
        <PageHeader title="Payments" />
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
        <PageHeader title="Payments" />
        <EmptyState title="No learner linked to this account yet" />
      </div>
    );
  }

  const target = selectedWard?.data;
  const statusTone = target?.payment_status === "current" ? "success" : target?.payment_status === "partial" ? "warning" : "danger";
  const statusLabel = target?.payment_status === "current" ? "Fees current" : target?.payment_status === "partial" ? "Paid in part" : "Fees due";

  const columns = [
    { key: "date", header: "Date", render: (p) => (p.date || "").slice(0, 10) },
    { key: "type", header: "Type", render: (p) => p.type },
    { key: "amount", header: "Amount", render: (p) => `GHS ${p.amount}` },
    { key: "method", header: "Method", render: (p) => p.method },
    { key: "status", header: "Status", render: (p) => <Badge tone={STATUS_TONE[p.status] || "danger"}>{p.status}</Badge> },
    {
      key: "programme",
      header: "Programme / Run",
      render: (p) => {
        if (!p.programmeName) return "—";
        const run = p.learningInstanceName ? ` (${p.learningInstanceName})` : "";
        const period = p.academicPeriodName ? ` — ${p.academicPeriodName}` : "";
        return `${p.programmeName}${run}${period}`;
      },
    },
  ];

  // Phase 10 — the requirement side: which periods exist, what's required,
  // and where each stands (regardless of whether any payment has actually
  // been made yet — this table shows unpaid/not_required rows too, unlike
  // the payment-history table which only ever shows payments that happened).
  const periodColumns = [
    {
      key: "run",
      header: "Learning Instance / Period",
      render: (p) => (
        <>
          {p.learningInstance.name}
          <br />
          <span className="text-helper">{p.academicPeriod.name}</span>
        </>
      ),
    },
    { key: "mode", header: "Required mode", render: (p) => (p.mode ? p.mode.replace(/_/g, " ") : "—") },
    { key: "required", header: "Required amount", render: (p) => (p.requiredAmountGHS != null ? `GHS ${p.requiredAmountGHS}` : "—") },
    { key: "paid", header: "Amount paid", render: (p) => `GHS ${p.amountPaidGHS || 0}` },
    { key: "outstanding", header: "Outstanding", render: (p) => (p.outstandingGHS ? `GHS ${p.outstandingGHS}` : "—") },
    {
      key: "status",
      header: "Status",
      render: (p) => <Badge tone={PERIOD_STATUS_TONE[p.status] || "neutral"}>{PERIOD_STATUS_LABEL[p.status] || p.status}</Badge>,
    },
    {
      key: "action",
      header: "",
      render: (p) =>
        p.satisfied ? null : (
          <Button
            size="sm"
            onClick={() =>
              setPayPeriodTarget({
                learningInstanceId: p.learningInstance.id,
                academicPeriodId: p.academicPeriod.id,
                instanceName: p.learningInstance.name,
                periodName: p.academicPeriod.name,
                amountGHS: p.outstandingGHS,
              })
            }
          >
            Pay
          </Button>
        ),
    },
  ];

  return (
    <div>
      <PageHeader title="Payments" />

      <Card padding>
        <WardPicker wards={availableWards} selectedId={selectedChildId} onChange={setSelectedChildId} />
      </Card>

      {status === "error" && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />
        </div>
      )}

      {status === "loading" && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <Skeleton height={280} width="100%" />
        </div>
      )}

      {status === "ready" && target && (
        <Card padding style={{ marginTop: "var(--space-4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
            <h3 style={{ margin: 0 }}>{selectedWard.name}'s payments</h3>
            <Badge tone={statusTone}>{statusLabel}</Badge>
          </div>
          <p className="text-helper">Student ID: {target.student_code || "—"}</p>
          {target.balance_owed_ghs ? (
            <p className="text-helper">
              Balance still owed: <strong>GHS {target.balance_owed_ghs}</strong>
            </p>
          ) : null}

          {periodPayments.length > 0 && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <h4 style={{ marginBottom: "var(--space-2)" }}>Period payments</h4>
              <DataTable
                columns={periodColumns}
                rows={periodPayments}
                getRowKey={(p) => `${p.learningInstance.id}:${p.academicPeriod.id}`}
                emptyState={<EmptyState title="No period payment requirements" />}
              />
            </div>
          )}

          <div style={{ marginTop: "var(--space-3)" }}>
            <DataTable columns={columns} rows={payments} getRowKey={(p) => p.id} emptyState={<EmptyState title="No payments yet" />} />
          </div>

          {/* The generic legacy monthly/programme-fee action only makes
              sense when this Ward has no period-based payment requirement
              at all — periodPayments is empty exactly when none of their
              active Learning Instances have an Academic Structure
              configured. Once a Run is period/semester-based, its
              specific outstanding balance is paid via the "Pay" action on
              the Period Payments row above instead — this button must
              never charge the flat monthly fee in that case, since it
              wouldn't settle (or even relate to) that period's actual
              requirement. */}
          {periodPayments.length === 0 && (
            <div style={{ marginTop: "var(--space-4)" }}>
              <Button onClick={() => setPayModalOpen(true)}>Pay this month's fee</Button>
            </div>
          )}

          {paymentAccounts.length > 0 && (
            <Card variant="flat" padding style={{ marginTop: "var(--space-4)", background: "var(--surface-sunken)" }}>
              <h4 style={{ marginTop: 0 }}>Prefer to transfer directly?</h4>
              <p className="text-helper">
                Send to any of the numbers below, then quote <strong>{target.student_code || "—"}</strong> as the reference so we can match it to{" "}
                {selectedWard.name}'s account. We'll confirm and update the status here once received.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "var(--space-2)" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Network</th>
                    <th style={{ textAlign: "left" }}>Number</th>
                    <th style={{ textAlign: "left" }}>Account name</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentAccounts.map((a, i) => (
                    <tr key={i}>
                      <td>{a.network}</td>
                      <td>{a.account_number}</td>
                      <td>{a.account_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </Card>
      )}

      <PayMonthlyFeeModal
        open={payModalOpen}
        onClose={() => setPayModalOpen(false)}
        childId={selectedChildId}
        childName={selectedWard?.name}
        country={target?.country}
        onSuccess={reloadAfterPayment}
      />

      <PayPeriodModal
        open={!!payPeriodTarget}
        onClose={() => setPayPeriodTarget(null)}
        childId={selectedChildId}
        childName={selectedWard?.name}
        country={target?.country}
        learningInstanceId={payPeriodTarget?.learningInstanceId}
        academicPeriodId={payPeriodTarget?.academicPeriodId}
        instanceName={payPeriodTarget?.instanceName}
        periodName={payPeriodTarget?.periodName}
        amountGHS={payPeriodTarget?.amountGHS}
        onSuccess={reloadAfterPayment}
      />
    </div>
  );
}
