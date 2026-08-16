import { useState } from "react";
import { usePaymentsManagement } from "./usePaymentsManagement";
import { PaymentStatusModal, AccessOverrideModal } from "./PaymentActionModals";
import { PageHeader, Card, FormField, Input, Select, DataTable, Badge, StatusIndicator, Button, EmptyState, ErrorState, Skeleton, Alert } from "../../components/ui";

const STATUS_BADGE_TONE = { current: "success", partial: "warning", unpaid: "danger", waived: "success" };
const STATUS_LABEL = { current: "Paid (full)", partial: "Paid (part)", unpaid: "Owing", waived: "Waived (sponsored)" };

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
 * Admin Payments & Access Restrictions (Phase 18). Migrates legacy
 * adminPayments() (dashboard.html) — the payment-status overview table,
 * the full payment ledger, and the Defaulters KPIs — against the same
 * backend endpoints (see api/admin.js and server/src/routes/payments.js),
 * plus the Access Override action against the existing
 * server/src/utils/accessControl.js gate (see api/admin.js for why that
 * action, though new to this React portal, isn't a new backend behavior).
 *
 * Scope note: legacy adminPayments() also renders a full Offering Type/
 * Programme/Learning Instance cascade (learningScopeSelectsHtml) on top of
 * search/class/campus — the same cascade Phase 17's Manage Accounts
 * screen already implements. This page keeps the filters legacy
 * adminPayments() itself actually exposes (search, class, campus, type,
 * month) plus a single Active-runs-only/All-instances toggle per section,
 * rather than duplicating that whole cascade widget here; the backend
 * contract supports the fuller cascade unchanged if a later phase wants
 * to extract it into a shared filter component.
 *
 * "Message parents who owe" (the legacy Defaulters panel's broadcast
 * action) is out of scope here — see api/admin.js's Phase 18 note.
 */
export default function PaymentsPage() {
  const pay = usePaymentsManagement();
  const [statusModalAccount, setStatusModalAccount] = useState(null);
  const [overrideModalAccount, setOverrideModalAccount] = useState(null);

  const totalOwing = pay.overview.filter((l) => l.payment_status === "unpaid").length;
  const totalPartial = pay.overview.filter((l) => l.payment_status === "partial").length;
  const totalBalanceGHS = pay.overview.reduce((a, l) => a + (l.balanceOwedGHS || 0), 0);

  return (
    <div>
      <PageHeader title="Payments" description="Payment records, status, and access restrictions across the platform." />

      <div className="grid-3">
        <KpiCard value={totalOwing} label="Owing in full" />
        <KpiCard value={totalPartial} label="Paid part" />
        <KpiCard value={`GHS ${totalBalanceGHS}`} label="Total balance outstanding" />
      </div>
      <p className="text-helper" style={{ marginTop: "var(--space-2)" }}>
        These totals reflect the current filter below ({pay.overviewConsolidated ? "all Learning Instances, consolidated" : "active runs only, by default"}).
      </p>

      {pay.defaultersStatus === "ready" && pay.defaulters && pay.defaulters.defaulters.length > 0 && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <Alert variant="warning" title={`${pay.defaulters.defaulters.length} learner(s) in arrears`} className="animate-fade-in">
            Estimated arrears this cycle: GHS {pay.defaulters.estimatedArrearsGHS} (monthly fee GHS {pay.defaulters.monthlyFeeGHS}).
          </Alert>
        </div>
      )}

      {/* ---- Accounts & payment status --------------------------------- */}
      <Card padding style={{ marginTop: "var(--space-6)" }}>
        <h3 className="text-section-title">Accounts &amp; payment status</h3>
        <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
          Look up a learner by their unique student ID when confirming a Mobile Money payment, then update their status here.
        </p>

        <div className="grid-3">
          <FormField label="Look up by student ID">
            <Input
              value={pay.lookupCode}
              onChange={(e) => pay.setLookupCode(e.target.value)}
              onBlur={pay.runLookup}
              onKeyDown={(e) => e.key === "Enter" && pay.runLookup()}
              placeholder="e.g. DTL-2026-0001"
            />
          </FormField>
        </div>
        {pay.lookupError && (
          <p className="text-helper" style={{ color: "var(--color-danger-text)" }}>
            {pay.lookupError}
          </p>
        )}
        {pay.lookupResult && (
          <Card padding className="animate-fade-in" style={{ marginTop: "var(--space-2)", marginBottom: "var(--space-3)" }}>
            <strong>{pay.lookupResult.learner.name}</strong> — {pay.lookupResult.learner.campus || "—"}
            {pay.lookupResult.parent ? ` · Parent: ${pay.lookupResult.parent.name} (${pay.lookupResult.parent.phone || "no phone"})` : ""}
            <Button variant="secondary" size="sm" style={{ marginLeft: "var(--space-3)" }} onClick={() => setStatusModalAccount(pay.lookupResult.learner)}>
              Update payment status
            </Button>
          </Card>
        )}

        <div className="grid-3" style={{ marginTop: "var(--space-4)" }}>
          <FormField label="Search learner">
            <Input value={pay.overviewSearch} onChange={(e) => pay.setOverviewSearch(e.target.value)} placeholder="Name or student ID" />
          </FormField>
          <FormField label="Class / Level">
            <Select value={pay.overviewClassId} onChange={(e) => pay.setOverviewClassId(e.target.value)}>
              <option value="">All classes</option>
              {pay.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Campus">
            <Select value={pay.overviewCampus} onChange={(e) => pay.setOverviewCampus(e.target.value)}>
              <option value="">All campuses</option>
              {pay.campuses.map((c) => (
                <option key={c.id || c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <input type="checkbox" checked={pay.overviewConsolidated} onChange={(e) => pay.setOverviewConsolidated(e.target.checked)} />
          <span className="text-helper" style={{ margin: 0 }}>
            Show all Learning Instances (consolidated) instead of active runs only
          </span>
        </label>

        <div style={{ marginTop: "var(--space-4)" }}>
          {pay.overviewStatus === "error" ? (
            <ErrorState description={pay.overviewError} action={{ label: "Try again", onClick: pay.reloadOverview }} />
          ) : (
            <DataTable
              loading={pay.overviewStatus === "loading"}
              rows={pay.overview}
              getRowKey={(l) => l.id}
              emptyState={<EmptyState title="No learners yet" description="Try a different search, class, or campus." />}
              columns={[
                {
                  key: "name",
                  header: "Learner",
                  render: (l) => (
                    <>
                      {l.name}
                      <br />
                      <span className="text-helper">{l.student_code || "—"}</span>
                    </>
                  ),
                },
                { key: "class", header: "Class", render: (l) => (l.is_adult ? "Adult" : l.className || "—") },
                { key: "paid", header: "Amount paid", render: (l) => `GHS ${l.totalPaidGHS || 0}` },
                { key: "owed", header: "Amount owed", render: (l) => (l.balanceOwedGHS ? `GHS ${l.balanceOwedGHS}` : "—") },
                {
                  key: "last",
                  header: "Last payment",
                  render: (l) => (l.lastPaymentDate ? `${(l.lastPaymentDate || "").slice(0, 10)}${l.lastPaymentMonth ? ` (${l.lastPaymentMonth})` : ""}` : "—"),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (l) => <Badge tone={STATUS_BADGE_TONE[l.payment_status] || "neutral"}>{STATUS_LABEL[l.payment_status] || l.payment_status}</Badge>,
                },
                {
                  key: "actions",
                  header: "",
                  render: (l) => (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                      <Button variant="ghost" size="sm" onClick={() => setStatusModalAccount(l)}>
                        Update
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setOverrideModalAccount(l)}>
                        Access
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </div>
      </Card>

      {/* ---- Full payment ledger ---------------------------------------- */}
      <Card padding style={{ marginTop: "var(--space-6)" }}>
        <h3 className="text-section-title">Full payment ledger</h3>

        <div className="grid-3" style={{ marginTop: "var(--space-3)" }}>
          <FormField label="Class / Level">
            <Select value={pay.ledgerClassId} onChange={(e) => pay.setLedgerClassId(e.target.value)}>
              <option value="">All classes</option>
              {pay.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Campus">
            <Select value={pay.ledgerCampus} onChange={(e) => pay.setLedgerCampus(e.target.value)}>
              <option value="">All campuses</option>
              {pay.campuses.map((c) => (
                <option key={c.id || c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Payment type">
            <Select value={pay.ledgerType} onChange={(e) => pay.setLedgerType(e.target.value)}>
              <option value="">All types</option>
              {pay.ledgerTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <div className="grid-3" style={{ marginTop: "var(--space-3)" }}>
          <FormField label="Month (YYYY-MM)">
            <Input value={pay.ledgerMonth} onChange={(e) => pay.setLedgerMonth(e.target.value)} placeholder="e.g. 2026-07" />
          </FormField>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <input type="checkbox" checked={pay.ledgerConsolidated} onChange={(e) => pay.setLedgerConsolidated(e.target.checked)} />
          <span className="text-helper" style={{ margin: 0 }}>
            Show all Learning Instances (consolidated) instead of active runs only
          </span>
        </label>

        <div style={{ marginTop: "var(--space-4)" }}>
          {pay.ledgerStatus === "error" ? (
            <ErrorState description={pay.ledgerError} action={{ label: "Try again", onClick: pay.reloadLedger }} />
          ) : (
            <DataTable
              loading={pay.ledgerStatus === "loading"}
              rows={pay.ledger}
              getRowKey={(p) => p.id}
              emptyState={<EmptyState title="No payments recorded yet" />}
              columns={[
                { key: "learner", header: "Learner", render: (p) => p.learnerName },
                { key: "amount", header: "Amount", render: (p) => `GHS ${p.amount}` },
                { key: "type", header: "Type", render: (p) => p.type },
                {
                  key: "run",
                  header: "Learning Instance / Period",
                  render: (p) =>
                    p.learningInstanceName ? (
                      <>
                        {p.learningInstanceName}
                        {p.academicPeriodName ? (
                          <>
                            <br />
                            <span className="text-helper">{p.academicPeriodName}</span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    ),
                },
                { key: "month", header: "Month", render: (p) => p.payment_month || "—" },
                { key: "method", header: "Method", render: (p) => p.method || "—" },
                { key: "date", header: "Date", render: (p) => (p.date || "").slice(0, 10) },
                {
                  key: "status",
                  header: "Status",
                  render: (p) => (
                    <StatusIndicator tone={p.status === "successful" ? "positive" : p.status === "pending" ? "caution" : "critical"}>{p.status}</StatusIndicator>
                  ),
                },
              ]}
            />
          )}
        </div>
      </Card>

      {pay.defaultersStatus === "loading" && (
        <Card padding style={{ marginTop: "var(--space-6)" }}>
          <Skeleton height={16} width="40%" />
        </Card>
      )}
      {pay.defaultersStatus === "error" && (
        <div style={{ marginTop: "var(--space-6)" }}>
          <ErrorState description={pay.defaultersError} action={{ label: "Try again", onClick: pay.reloadDefaulters }} />
        </div>
      )}

      <PaymentStatusModal account={statusModalAccount} onClose={() => setStatusModalAccount(null)} onSave={pay.updatePaymentStatus} loadSummary={pay.loadSummary} />
      <AccessOverrideModal account={overrideModalAccount} onClose={() => setOverrideModalAccount(null)} onSave={pay.grantOrRevokeAccessOverride} />
    </div>
  );
}
