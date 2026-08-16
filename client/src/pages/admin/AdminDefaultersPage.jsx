import { useAdminDefaulters } from "./useAdminDefaulters";
import { PageHeader, Card, Button, FormField, Input, Textarea, DataTable, LoadingState, ErrorState, UnauthorizedState, EmptyState, Badge } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

function KpiCard({ value, label }) {
  return (
    <Card padding>
      <p style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "var(--font-size-2xl)", color: "var(--color-primary-700)" }}>{value}</p>
      <p className="text-label" style={{ marginTop: "var(--space-2)" }}>
        {label}
      </p>
    </Card>
  );
}

/**
 * Defaulters (final admin migration pass). Migrates legacy
 * adminDefaulters()/messageOwingParents() (dashboard.html) in full — the
 * payment-defaulter report (KPIs + table) plus the "Message parents who
 * owe" broadcast panel, against the same existing endpoints (see
 * api/admin.js).
 *
 * Phase 2: KPIs are now split into monthly vs period arrears (both already
 * returned by the backend's GET /api/payments/defaulters response).
 * The table also shows a Billing Model column and, for period-based rows,
 * the period outstanding amount.
 */
export default function AdminDefaultersPage() {
  const data = useAdminDefaulters();
  const toast = useToast();

  async function handleSend() {
    try {
      const count = await data.messageOwingParents();
      toast.success(`Sent to ${count} parent(s).`);
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      <PageHeader title="Defaulters" />

      {data.status === "loading" && <LoadingState label="Loading Defaulters…" />}
      {data.status === "forbidden" && <UnauthorizedState description="Defaulters is limited to administrators." />}
      {data.status === "error" && <ErrorState description={data.error} action={{ label: "Try again", onClick: data.reload }} />}

      {data.status === "ready" && (
        <>
          {/* Phase 2 — 4-card KPI row: total + split monthly/period arrears + monthly fee */}
          <div className="grid-4" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
            <KpiCard value={data.defaulters.length} label="Learners in arrears" />
            <KpiCard value={`GHS ${data.monthlyArrearsGHS}`} label="Monthly arrears" />
            <KpiCard value={`GHS ${data.periodArrearsGHS}`} label="Period arrears (term/semester)" />
            <KpiCard value={`GHS ${data.monthlyFeeGHS}`} label="Monthly fee" />
          </div>

          <Card padding={false} style={{ marginTop: "var(--space-4)" }}>
            <DataTable
              columns={[
                { key: "name", header: "Learner", render: (d) => d.name },
                { key: "campus", header: "Campus", render: (d) => d.campus || "—" },
                { key: "parent", header: "Parent", render: (d) => d.parentName || "—" },
                { key: "parentPhone", header: "Parent phone", render: (d) => d.parentPhone || "—" },
                {
                  // Phase 2 — show billing model so admin can distinguish monthly vs term/semester
                  key: "billingModel",
                  header: "Billing model",
                  render: (d) =>
                    d.billingModel === "period" ? (
                      <Badge tone="brand">Term / Semester</Badge>
                    ) : (
                      <Badge tone="neutral">Monthly</Badge>
                    ),
                },
                {
                  // Phase 2 — outstanding GHS for period-based rows; monthly rows use payment_status
                  key: "outstanding",
                  header: "Outstanding (GHS)",
                  render: (d) =>
                    d.billingModel === "period" ? (
                      <span style={{ color: "var(--color-danger-text)" }}>GHS {d.periodOutstandingGHS}</span>
                    ) : (
                      <span style={{ color: "var(--color-danger-text)" }}>{d.status}</span>
                    ),
                },
              ]}
              rows={data.defaulters}
              getRowKey={(d) => d.id}
              emptyState={<EmptyState title="No defaulters right now 🎉" />}
            />
          </Card>

          <Card padding style={{ marginTop: "var(--space-4)" }}>
            <h3 className="text-section-title">Message parents who owe</h3>
            <FormField label="Subject" style={{ marginTop: "var(--space-3)" }}>
              <Input value={data.subject} onChange={(e) => data.setSubject(e.target.value)} placeholder="e.g. Outstanding fees" />
            </FormField>
            <FormField label="Message" style={{ marginTop: "var(--space-3)" }}>
              <Textarea rows={3} value={data.body} onChange={(e) => data.setBody(e.target.value)} />
            </FormField>
            <Button style={{ marginTop: "var(--space-3)" }} loading={data.sending} onClick={handleSend}>
              Send to owing parents
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}
