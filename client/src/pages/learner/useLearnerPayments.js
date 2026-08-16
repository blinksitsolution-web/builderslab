import { useCallback, useEffect, useState } from "react";
import { fetchUser } from "../../api/users";
import { fetchPayments, fetchPeriodPaymentStatus } from "../../api/parent";
import { fetchPublicSettings } from "../../api/public";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Payments (final migration pass, period payments added Phase 10) —
 * migrates legacy learnerPayments() / renderPaymentsPanel() (dashboard.html)
 * for a learner viewing their own account: balance/status (GET
 * /api/users/:id), payment history (GET /api/payments/user/:userId), the
 * manual bank/Mobile-Money transfer accounts (GET /api/settings/public),
 * and — new in Phase 10 — every period payment requirement across this
 * learner's own Learning Instances (GET /api/payments/:userId/period-status).
 *
 * fetchPayments/fetchPeriodPaymentStatus/fetchPublicSettings are the exact
 * same generic wrappers ParentPaymentsPage already uses (api/parent.js,
 * api/public.js) — every one of these endpoints already accepts any
 * caller viewing their own account via requireSelfParentOrStaff, so
 * reusing them here rather than adding learner-specific duplicates
 * matches how fetchUser (api/users.js) is already shared between the two
 * portals.
 *
 * Legacy only shows this panel to adult learners at all — a non-adult
 * learner's payments are handled entirely by their parent's portal, and
 * legacy's learnerPayments() returns a static message without making any
 * of these calls. This hook mirrors that: it does nothing (and makes no
 * request) when the account isn't an adult learner.
 */
export function useLearnerPayments() {
  const { user: authUser, refresh } = useAuth();
  const isAdult = !!authUser?.is_adult;
  const [status, setStatus] = useState(isAdult ? "loading" : "not-applicable");
  const [errorMessage, setErrorMessage] = useState(null);
  const [learner, setLearner] = useState(null);
  const [payments, setPayments] = useState([]);
  const [periodPayments, setPeriodPayments] = useState([]);
  const [paymentAccounts, setPaymentAccounts] = useState([]);

  const load = useCallback(async () => {
    if (!authUser || !isAdult) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const [freshUser, paymentsResult, settings, periodPaymentsResult] = await Promise.all([
        fetchUser(authUser.id),
        fetchPayments(authUser.id),
        fetchPublicSettings(),
        fetchPeriodPaymentStatus(authUser.id).catch(() => []),
      ]);
      setLearner(freshUser);
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
  }, [authUser, isAdult, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id, isAdult]);

  // After a successful payment, reload the self record (balance/status
  // changes), payment history, and period payment status together.
  const reloadAfterPayment = useCallback(async () => {
    await load();
  }, [load]);

  return { isAdult, status, errorMessage, learner, payments, periodPayments, paymentAccounts, reload: load, reloadAfterPayment };
}
