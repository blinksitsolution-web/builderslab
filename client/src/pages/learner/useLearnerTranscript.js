import { useCallback, useEffect, useState } from "react";
import { fetchTranscript, fetchTranscriptOptions } from "../../api/parent";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Transcripts — self-view for a learner logged in directly (adult learner).
 * A non-adult learner's transcript is reached through their parent's
 * portal instead (see ParentTranscriptsPage.jsx); this is the same
 * GET /api/grades/:userId/transcript endpoint, just called with the
 * caller's own id rather than a Ward id (both are already authorized by
 * requireSelfParentOrStaff + requireActiveAccess — see api/parent.js).
 *
 * Phase 10 — also loads this learner's own period options (GET
 * .../transcript-options) for the same Learning Instance/Academic Period
 * picker useParentTranscript.js offers; selecting a period re-fetches the
 * transcript scoped to it. No selection = the same default view as before.
 */
export function useLearnerTranscript() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading");
  const [restricted, setRestricted] = useState(false);
  const [transcript, setTranscript] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  const [periodOptions, setPeriodOptions] = useState([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [selectedPeriodId, setSelectedPeriodId] = useState("");

  const loadPeriodOptions = useCallback(async () => {
    if (!authUser) return;
    try {
      const instances = await fetchTranscriptOptions(authUser.id);
      setPeriodOptions(instances);
    } catch (e) {
      setPeriodOptions([]);
    }
  }, [authUser]);

  const load = useCallback(
    async (instanceId, periodId) => {
      if (!authUser) return;
      setStatus("loading");
      setRestricted(false);
      setErrorMessage(null);
      try {
        const t = await fetchTranscript(authUser.id, instanceId && periodId ? { learningInstanceId: instanceId, academicPeriodId: periodId } : {});
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
        setErrorMessage(err && err.message ? err.message : "Couldn't load your transcript.");
        setStatus("error");
      }
    },
    [authUser, refresh]
  );

  useEffect(() => {
    loadPeriodOptions();
    load("", "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  function selectInstance(instanceId) {
    setSelectedInstanceId(instanceId);
    setSelectedPeriodId("");
    load("", "");
  }

  function selectPeriod(periodId) {
    setSelectedPeriodId(periodId);
    if (selectedInstanceId && periodId) load(selectedInstanceId, periodId);
  }

  function clearPeriodSelection() {
    setSelectedInstanceId("");
    setSelectedPeriodId("");
    load("", "");
  }

  return {
    status,
    restricted,
    transcript,
    errorMessage,
    reload: () => load(selectedInstanceId, selectedPeriodId),

    periodOptions,
    selectedInstanceId,
    selectedPeriodId,
    selectInstance,
    selectPeriod,
    clearPeriodSelection,
  };
}
