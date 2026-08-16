import { useState } from "react";
import { useLearnerPayments } from "./useLearnerPayments";
import PayMonthlyFeeModal from "../parent/PayMonthlyFeeModal";
import PayPeriodModal from "../parent/PayPeriodModal";
import { PageHeader, Card, Badge, Button, DataTable, Skeleton, EmptyState, ErrorState, Alert } from "../../components/ui";

const STATUS_TONE = { successful: "success", pending: "warning" };
// Phase 10 — same period-status tone/label map as ParentPaymentsPage.jsx
// (utils/periodPayments.js's getPeriodPaymentStatus statuses).
const PERIOD_STATUS_TONE = { paid: "success", partial: "warning", unpaid: "danger", not_required: "neutral" };
const PERIOD_STATUS_LABEL = { paid: "Paid in full", partial: "Paid in part", unpaid: "Not paid", not_required: "No payment required" };

/**
 * Payments (final migration pass, period payments added Phase 10) —
 * migrates legacy learnerPayments() / renderPaymentsPanel() (dashboard.html)
 * for a learner viewing their own account. Same balance/status, payment
 * history, "Pay via Mobile Money" (PayMonthlyFeeModal — the exact same
 * modal ParentPaymentsPage already uses, since it takes a plain userId),
 * manual bank/Mobile-Money transfer account details, and — new in Phase
 * 10 — a Period Payments table (Learning Instance, period, required
 * mode/amount, amount paid, outstanding balance, status) ParentPaymentsPage
 * shows per Ward, just for the learner's own account (no Ward picker
 * needed).
 *
 * Legacy gates this whole panel on `user.is_adult` — a non-adult
 * learner's payments are handled by their parent's portal instead. This
 * mirrors that exactly rather than inventing a workflow legacy never
 * exposed to non-adult learners.
 */
export default function LearnerPaymentsPage() {
  const { isAdult, status, errorMessage, learner, payments, periodPayments, paymentAccounts, reload, reloadAfterPayment } = useLearnerPayments();
  const [payModalOpen, setPayModalOpen] = useState(false);
  // Same convention as ParentPaymentsPage.jsx's payPeriodTarget — which
  // Period Payments row (if any) is currently being paid via
  // PayPeriodModal, set directly from that row's own data.
  const [payPeriodTarget, setPayPeriodTarget] = useState(null);

  if (!isAdult) {
    return (
      <div>
        <PageHeader title="Payments" />
        <Alert variant="info">Payment for your access is handled by your parent/guardian from their portal.</Alert>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div>
        <PageHeader title="Payments" />
        <Skeleton height={280} width="100%" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div>
        <PageHeader title="Payments" />
        <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />
      </div>
    );
  }

  const statusTone = learner?.payment_status === "current" ? "success" : learner?.payment_status === "partial" ? "warning" : "danger";
  const statusLabel = learner?.payment_status === "current" ? "Fees current" : learner?.payment_status === "partial" ? "Paid in part" : "Fees due";

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
          <h3 style={{ margin: 0 }}>Payment history</h3>
          <Badge tone={statusTone}>{statusLabel}</Badge>
        </div>
        <p className="text-helper">Student ID: {learner?.student_code || "—"}</p>
        {learner?.balance_owed_ghs ? (
          <p className="text-helper">
            Balance still owed: <strong>GHS {learner.balance_owed_ghs}</strong>
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

        {/* See ParentPaymentsPage.jsx's identical comment — this generic
            legacy action only applies when there's no period-based
            payment requirement at all. */}
        {periodPayments.length === 0 && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Button onClick={() => setPayModalOpen(true)}>Pay this month's fee</Button>
          </div>
        )}

        {paymentAccounts.length > 0 && (
          <Card variant="flat" padding style={{ marginTop: "var(--space-4)", background: "var(--surface-sunken)" }}>
            <h4 style={{ marginTop: 0 }}>Prefer to transfer directly?</h4>
            <p className="text-helper">
              Send to any of the numbers below, then quote <strong>{learner?.student_code || "—"}</strong> as the reference so we can match it
              to your account. We'll confirm and update the status here once received.
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

      <PayMonthlyFeeModal
        open={payModalOpen}
        onClose={() => setPayModalOpen(false)}
        childId={learner?.id}
        childName={null}
        country={learner?.country}
        onSuccess={reloadAfterPayment}
      />

      <PayPeriodModal
        open={!!payPeriodTarget}
        onClose={() => setPayPeriodTarget(null)}
        childId={learner?.id}
        childName={null}
        country={learner?.country}
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
