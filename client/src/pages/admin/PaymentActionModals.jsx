import { useEffect, useState } from "react";
import { Modal, Button, FormField, Select, Input, Radio, Alert } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

/**
 * Row-action modals for Payments & Access Restrictions (Phase 18).
 *
 * - PaymentStatusModal migrates legacy openPaymentStatusModal()/
 *   savePaymentStatus() (dashboard.html) against the same
 *   PATCH /api/payments/:userId/status contract (see api/admin.js and
 *   server/src/routes/payments.js) — same fields, same
 *   "amountPaid also inserts a ledger row" / "paying registration in full
 *   also activates a pending account" backend behavior, unchanged here.
 *
 * - AccessOverrideModal is new to the React admin portal (legacy
 *   dashboard.html never exposed it), but the backend action itself
 *   already exists in full — server/src/routes/users.js
 *   PATCH /:userId/access-override, gated purely by requireRole("admin").
 *   React only displays the account's current override state and calls
 *   that endpoint; it does not decide who is restricted or why (see
 *   server/src/utils/accessControl.js, the actual enforcement layer).
 */

export function PaymentStatusModal({ account, onClose, onSave, loadSummary }) {
  const toast = useToast();
  const [summary, setSummary] = useState(null);
  const [summaryStatus, setSummaryStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [status, setStatus] = useState("current");
  const [type, setType] = useState("monthly");
  const [amountPaid, setAmountPaid] = useState("");
  const [paymentMonth, setPaymentMonth] = useState(new Date().toISOString().slice(0, 7));
  const [method, setMethod] = useState("Cash");
  const [balanceOwed, setBalanceOwed] = useState("0");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setSummaryStatus("loading");
    loadSummary(account.id)
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        setStatus(data.paymentStatus === "partial" ? "partial" : data.paymentStatus === "unpaid" ? "unpaid" : "current");
        setBalanceOwed(String(data.balanceOwedGHS || 0));
        setSummaryStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setSummaryStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [account, loadSummary]);

  if (!account) return null;

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(account.id, {
        status,
        type,
        amountPaid: amountPaid ? Number(amountPaid) : null,
        balanceOwed: status === "partial" ? Number(balanceOwed || 0) : 0,
        method,
        paymentMonth: type === "monthly" ? paymentMonth : null,
      });
      toast.success("Payment status updated.");
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`Update payment status — ${account.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={summaryStatus === "loading"}>
            Save
          </Button>
        </>
      }
    >
      {summaryStatus === "loading" && <p className="text-helper">Loading current balance…</p>}
      {summaryStatus === "error" && <Alert variant="danger">Couldn't load this learner's payment summary. You can still submit an update below.</Alert>}
      {summary && (
        <p className="text-helper" style={{ marginBottom: "var(--space-4)" }}>
          Total paid to date: GHS {summary.totalPaidGHS}. Current balance owed: GHS {summary.balanceOwedGHS || 0}.
        </p>
      )}

      <FormField label="New status">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="current">Paid in full</option>
          <option value="partial">Paid part (still owing some)</option>
          <option value="unpaid">Owing (nothing paid this cycle)</option>
        </Select>
      </FormField>

      <div className="grid-2">
        <FormField label="Payment type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="registration">Registration</option>
            <option value="monthly">Monthly</option>
            <option value="termly">Termly (all months of the term paid in advance)</option>
            <option value="course">Course (Adult Professional, one-off)</option>
            <option value="workshop">Workshop (Corporate Training, one-off)</option>
            <option value="bootcamp">Bootcamp (one-off)</option>
          </Select>
        </FormField>
        <FormField label="Amount just paid (GHS, optional)">
          <Input type="number" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="0" />
        </FormField>
      </div>

      <div className="grid-2">
        {type === "monthly" && (
          <FormField label="Payment month">
            <Input type="month" value={paymentMonth} onChange={(e) => setPaymentMonth(e.target.value)} />
          </FormField>
        )}
        <FormField label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="Cash">Cash</option>
            <option value="MoMo">MoMo</option>
            <option value="Paystack">Paystack</option>
          </Select>
        </FormField>
      </div>

      {status === "partial" && (
        <FormField label="Remaining balance owed (GHS)">
          <Input type="number" value={balanceOwed} onChange={(e) => setBalanceOwed(e.target.value)} />
        </FormField>
      )}
    </Modal>
  );
}

// Matches the account-shape both PaymentsPage rows (which carry `id`) and
// AccountDetailDrawer (which carries `id` on the fetched account) pass in —
// same component used from both places, per Phase 18's integration
// requirement, rather than a duplicate per screen.
export function AccessOverrideModal({ account, onClose, onSave }) {
  const toast = useToast();
  const [action, setAction] = useState("grant"); // "grant" | "revoke"
  const [reason, setReason] = useState("");
  const [hasExpiry, setHasExpiry] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!account) return;
    setAction(account.access_override ? "revoke" : "grant");
    setReason(account.access_override_reason || "");
    setHasExpiry(!!account.access_override_expires_at);
    setExpiresAt(account.access_override_expires_at ? account.access_override_expires_at.slice(0, 16) : "");
  }, [account]);

  if (!account) return null;

  const granting = action === "grant";

  async function handleSave() {
    if (granting && !reason.trim()) {
      toast.error("A reason is required when granting an access override.");
      return;
    }
    setSaving(true);
    try {
      await onSave(account.id, {
        override: granting,
        reason: granting ? reason.trim() : undefined,
        expiresAt: granting && hasExpiry && expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      toast.success(granting ? "Access override granted." : "Access override revoked.");
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`Access override — ${account.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant={granting ? "primary" : "danger"} onClick={handleSave} loading={saving}>
            {granting ? "Grant override" : "Revoke override"}
          </Button>
        </>
      }
    >
      {account.status === "suspended" && (
        <Alert variant="warning" title="This account is suspended">
          An access override never bypasses a suspension — reactivate the account from Manage Accounts first if that's the goal.
        </Alert>
      )}

      <p className="text-helper" style={{ marginBottom: "var(--space-4)" }}>
        An override lets this account bypass the payment/pending-payment access restriction without changing their actual payment status. It never bypasses a suspended account status.
      </p>

      <p className="text-label">Action</p>
      <div style={{ display: "flex", gap: "var(--space-4)", marginBottom: "var(--space-4)" }}>
        <Radio name="override-action" label="Grant override" checked={granting} onChange={() => setAction("grant")} />
        <Radio name="override-action" label="Revoke override" checked={!granting} onChange={() => setAction("revoke")} />
      </div>

      {granting && (
        <>
          <FormField label="Reason (required)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Payment confirmed by bank transfer, awaiting reconciliation" />
          </FormField>

          <p className="text-label">Expiry</p>
          <div style={{ display: "flex", gap: "var(--space-4)", marginBottom: "var(--space-2)" }}>
            <Radio name="override-expiry" label="No expiry" checked={!hasExpiry} onChange={() => setHasExpiry(false)} />
            <Radio name="override-expiry" label="Expires at…" checked={hasExpiry} onChange={() => setHasExpiry(true)} />
          </div>
          {hasExpiry && <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />}
        </>
      )}
    </Modal>
  );
}
