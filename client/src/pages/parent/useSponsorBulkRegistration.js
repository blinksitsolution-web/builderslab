import { useCallback, useEffect, useState } from "react";
import {
  fetchBulkRegistrationLearningInstances,
  downloadBulkRegistrationTemplate,
  downloadBulkRegistrationReport,
  uploadAndValidateBulkRegistration,
  commitBulkRegistrationBatch,
} from "../../api/sponsorBulkRegistration";

/**
 * Drives the full Sponsor Bulk Registration flow for one sponsor
 * coordinator session. Stages:
 *   pick-instance -> upload -> preview (validated, not yet committed)
 *   -> committed (ready to pay) -> paid
 *
 * Payment itself is intentionally NOT part of this hook — once a batch
 * is committed, its learners sit in the same pending_payment state
 * routes/users.js's individual add-child flow already produces, so the
 * existing combined-charge payment UI (PayEnrolmentModal, reused as-is
 * by SponsorBulkRegistrationPage.jsx) picks the whole batch up through
 * the existing pipeline — no parallel payment workflow here.
 */
export function useSponsorBulkRegistration(sponsorId) {
  const [instances, setInstances] = useState([]);
  const [instancesStatus, setInstancesStatus] = useState("loading"); // loading | ready | error
  const [learningInstanceId, setLearningInstanceId] = useState("");
  const [stage, setStage] = useState("pick-instance"); // pick-instance | upload | preview | committed
  const [batch, setBatch] = useState(null); // { batchId, validation, preview, status, result }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchBulkRegistrationLearningInstances(sponsorId);
        if (cancelled) return;
        setInstances(list);
        setInstancesStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setInstancesStatus("error");
          setError(e.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sponsorId]);

  const selectInstance = useCallback((id) => {
    setLearningInstanceId(id);
    setStage("upload");
    setBatch(null);
    setError(null);
  }, []);

  const downloadTemplate = useCallback(async () => {
    setError(null);
    try {
      await downloadBulkRegistrationTemplate(sponsorId, learningInstanceId);
    } catch (e) {
      setError(e.message);
    }
  }, [sponsorId, learningInstanceId]);

  const uploadFile = useCallback(
    async (file) => {
      setBusy(true);
      setError(null);
      try {
        const result = await uploadAndValidateBulkRegistration(sponsorId, { learningInstanceId, file });
        setBatch(result);
        setStage(result.status === "committed" ? "committed" : "preview");
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    [sponsorId, learningInstanceId]
  );

  const commit = useCallback(async () => {
    if (!batch?.batchId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await commitBulkRegistrationBatch(sponsorId, batch.batchId);
      setBatch((prev) => ({ ...prev, status: "committed", result: result.result }));
      setStage("committed");
      return result;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [sponsorId, batch]);

  const downloadReport = useCallback(async () => {
    if (!batch?.batchId) return;
    setError(null);
    try {
      await downloadBulkRegistrationReport(sponsorId, batch.batchId);
    } catch (e) {
      setError(e.message);
    }
  }, [sponsorId, batch]);

  const reset = useCallback(() => {
    setStage("pick-instance");
    setLearningInstanceId("");
    setBatch(null);
    setError(null);
  }, []);

  return {
    instances,
    instancesStatus,
    learningInstanceId,
    stage,
    batch,
    busy,
    error,
    selectInstance,
    downloadTemplate,
    uploadFile,
    commit,
    downloadReport,
    reset,
  };
}
