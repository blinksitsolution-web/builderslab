import { useCallback, useEffect, useState } from "react";
import { useParentChildren } from "./useParentChildren";
import { fetchTranscript, fetchTranscriptOptions } from "../../api/parent";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Transcripts (Phase 22, period-scoping added Phase 10) — migrates legacy
 * parentTranscripts() / loadParentTranscript() / renderTranscript(learnerId,
 * false) (dashboard.html), read-only (never `editable`, matching the
 * parent's legacy call). GET /api/grades/:childId/transcript returns the
 * full payload as-is — nothing recomputed here.
 *
 * Phase 10 additionally loads this child's period options (GET
 * .../transcript-options) so the UI can offer a Learning Instance/Academic
 * Period picker; selecting one re-fetches the transcript scoped to that
 * exact period instead of the default (current-term, every-enrolled-
 * module) view. Clearing the selection returns to the default view
 * exactly as before — nothing here changes what "no selection" means.
 */
export function useParentTranscript() {
  const { refresh } = useAuth();
  const { status: childrenStatus, errorMessage: childrenError, availableWards, reload: reloadChildren } = useParentChildren();
  const [selectedChildId, setSelectedChildId] = useState(null);
  const [status, setStatus] = useState("idle");
  const [restricted, setRestricted] = useState(false);
  const [transcript, setTranscript] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  const [periodOptions, setPeriodOptions] = useState([]); // [{ id, name, status, academicPeriods: [{id,name,sequence}] }]
  // "" = default (non-period-scoped) view.
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [selectedPeriodId, setSelectedPeriodId] = useState("");

  useEffect(() => {
    if (childrenStatus === "ready" && selectedChildId === null && availableWards.length) {
      setSelectedChildId(availableWards[0].id);
    }
  }, [childrenStatus, availableWards, selectedChildId]);

  const loadPeriodOptions = useCallback(async (childId) => {
    if (!childId) return;
    try {
      const instances = await fetchTranscriptOptions(childId);
      setPeriodOptions(instances);
    } catch (e) {
      // Non-fatal — the default transcript view still works without a
      // period picker; just don't offer one.
      setPeriodOptions([]);
    }
  }, []);

  const load = useCallback(
    async (childId, instanceId, periodId) => {
      if (!childId) return;
      setStatus("loading");
      setRestricted(false);
      setErrorMessage(null);
      try {
        const t = await fetchTranscript(childId, instanceId && periodId ? { learningInstanceId: instanceId, academicPeriodId: periodId } : {});
        setTranscript(t);
        setStatus("ready");
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await refresh();
          return;
        }
        if (isAccessRestrictedError(err)) {
          setRestricted(true);
          setTranscript(null);
          setStatus("ready");
          return;
        }
        setErrorMessage(err && err.message ? err.message : "Couldn't load this transcript.");
        setStatus("error");
      }
    },
    [refresh]
  );

  // Switching child resets any period selection (a period picked for one
  // child's Learning Instance is meaningless for another) and reloads
  // that child's own period options.
  useEffect(() => {
    setSelectedInstanceId("");
    setSelectedPeriodId("");
    loadPeriodOptions(selectedChildId);
    load(selectedChildId, "", "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChildId]);

  function selectInstance(instanceId) {
    setSelectedInstanceId(instanceId);
    setSelectedPeriodId("");
    load(selectedChildId, "", ""); // instance alone isn't enough — fall back to default until a period is also chosen
  }

  function selectPeriod(periodId) {
    setSelectedPeriodId(periodId);
    if (selectedInstanceId && periodId) load(selectedChildId, selectedInstanceId, periodId);
  }

  function clearPeriodSelection() {
    setSelectedInstanceId("");
    setSelectedPeriodId("");
    load(selectedChildId, "", "");
  }

  return {
    childrenStatus,
    childrenError,
    availableWards,
    reloadChildren,
    selectedChildId,
    setSelectedChildId,
    status,
    restricted,
    transcript,
    errorMessage,
    reload: () => load(selectedChildId, selectedInstanceId, selectedPeriodId),

    periodOptions,
    selectedInstanceId,
    selectedPeriodId,
    selectInstance,
    selectPeriod,
    clearPeriodSelection,
  };
}
