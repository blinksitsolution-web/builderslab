import { useCallback, useEffect, useState } from "react";
import { fetchInstructorTopicProgress, fetchOfferingTypes } from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Instructor Topic Progress (final admin migration pass). Migrates legacy
 * adminInstructorProgress() (dashboard.html) — same
 * GET /api/topics/admin/progress-summary contract, which already assembles
 * instructor/module topic-completion rows server-side (see
 * server/src/routes/topics.js and api/admin.js). No new backend endpoint
 * needed.
 */
export function useAdminInstructorProgress() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // loading | ready | error | forbidden
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [offeringTypes, setOfferingTypes] = useState([]);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [progress, types] = await Promise.all([fetchInstructorTopicProgress(), fetchOfferingTypes()]);
      setRows(progress);
      setOfferingTypes(types);
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

  return { status, error, rows, offeringTypes, reload: load };
}
