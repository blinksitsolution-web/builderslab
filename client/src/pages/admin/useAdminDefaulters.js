import { useCallback, useEffect, useState } from "react";
import { fetchDefaulters, fetchOwingParents, sendMessage } from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Defaulters (final admin migration pass). Migrates legacy
 * adminDefaulters()/messageOwingParents() (dashboard.html) — same
 * GET /api/payments/defaulters, GET /api/payments/owing-parents and
 * POST /api/messages contracts (see api/admin.js and
 * server/src/routes/payments.js, messages.js).
 */
export function useAdminDefaulters() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // loading | ready | error | forbidden
  const [error, setError] = useState(null);
  const [defaulters, setDefaulters] = useState([]);
  const [estimatedArrearsGHS, setEstimatedArrearsGHS] = useState(0);
  // Phase 2 — split monthly vs period arrears (backend already returns both)
  const [monthlyArrearsGHS, setMonthlyArrearsGHS] = useState(0);
  const [periodArrearsGHS, setPeriodArrearsGHS] = useState(0);
  const [monthlyFeeGHS, setMonthlyFeeGHS] = useState(0);

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const data = await fetchDefaulters();
      setDefaulters(data.defaulters);
      setEstimatedArrearsGHS(data.estimatedArrearsGHS);
      setMonthlyArrearsGHS(data.monthlyArrearsGHS ?? 0);
      setPeriodArrearsGHS(data.periodArrearsGHS ?? 0);
      setMonthlyFeeGHS(data.monthlyFeeGHS);
      setStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      if (isForbiddenError(e)) {
        setStatus("forbidden");
        setError(e.message);
        return;
      }
      setStatus("error");
      setError(e.message);
    }
  }, [refresh]);

  useEffect(() => {
    load();
  }, [load]);

  async function messageOwingParents() {
    if (!body.trim()) throw new Error("Write a message first.");
    setSending(true);
    try {
      const parents = await fetchOwingParents();
      await Promise.all(parents.map((p) => sendMessage({ to: p.id, subject, body })));
      setSubject("");
      setBody("");
      return parents.length;
    } finally {
      setSending(false);
    }
  }

  return {
    status,
    error,
    defaulters,
    estimatedArrearsGHS,
    monthlyArrearsGHS,
    periodArrearsGHS,
    monthlyFeeGHS,
    reload: load,
    subject,
    setSubject,
    body,
    setBody,
    sending,
    messageOwingParents,
  };
}
