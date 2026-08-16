import { useCallback, useEffect, useState } from "react";
import { useParentChildren } from "./useParentChildren";
import { fetchPayments, fetchPeriodPaymentStatus } from "../../api/parent";
import { fetchPublicSettings } from "../../api/public";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Payments (Phase 22, period payments added Phase 10) — migrates the read
 * side of legacy parentPayments() / renderPaymentsPanel() (dashboard.html):
 * a Ward picker, that child's balance/status (from the same child record
 * useParentChildren already fetches), payment history (GET
 * /api/payments/user/:childId), the manual bank/Mobile-Money transfer
 * accounts (GET /api/settings/public), and — new in Phase 10 — every
 * period payment requirement across that child's own Learning Instances
 * (GET /api/payments/:childId/period-status), so the UI can show required
 * mode/amount, amount paid, outstanding balance, and status per academic
 * period instead of only the flattened payment history. The interactive
 * "Pay via Mobile Money" charge/OTP/poll flow lives in
 * PayMonthlyFeeModal.jsx.
 */
export function useParentPayments() {
  const { refresh } = useAuth();
  const { status: childrenStatus, errorMessage: childrenError, availableWards, reload: reloadChildren } = useParentChildren();
  const [selectedChildId, setSelectedChildId] = useState(null);
  const [status, setStatus] = useState("idle");
  const [payments, setPayments] = useState([]);
  const [periodPayments, setPeriodPayments] = useState([]);
  const [paymentAccounts, setPaymentAccounts] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);

  useEffect(() => {
    if (childrenStatus === "ready" && selectedChildId === null && availableWards.length) {
      setSelectedChildId(availableWards[0].id);
    }
  }, [childrenStatus, availableWards, selectedChildId]);

  const load = useCallback(
    async (childId) => {
      if (!childId) return;
      setStatus("loading");
      setErrorMessage(null);
      try {
        const [paymentsResult, settings, periodPaymentsResult] = await Promise.all([
          fetchPayments(childId),
          fetchPublicSettings(),
          fetchPeriodPaymentStatus(childId).catch(() => []),
        ]);
        setPayments(paymentsResult.slice().reverse());
        setPaymentAccounts(settings.paymentAccounts || []);
        setPeriodPayments(periodPaymentsResult);
        setStatus("ready");
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await refresh();
          return;
        }
        setErrorMessage(err && err.message ? err.message : "Couldn't load payment information.");
        setStatus("error");
      }
    },
    [refresh]
  );

  useEffect(() => {
    load(selectedChildId);
  }, [selectedChildId, load]);

  const selectedWard = availableWards.find((w) => w.id === selectedChildId) || null;

  // After a successful payment, reload the child record (balance/status
  // changes), payment history, and period payment status together.
  const reloadAfterPayment = useCallback(async () => {
    await reloadChildren();
    await load(selectedChildId);
  }, [reloadChildren, load, selectedChildId]);

  return {
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
    reload: () => load(selectedChildId),
    reloadAfterPayment,
  };
}
