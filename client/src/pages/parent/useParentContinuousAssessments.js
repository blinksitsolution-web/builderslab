import { useCallback, useEffect, useState } from "react";
import { useParentChildren } from "./useParentChildren";
import { fetchContinuousAssessmentResults, fetchModules } from "../../api/parent";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Continuous Assessment results (Phase 22) — migrates legacy
 * parentContinuousAssessment() / loadParentCA() (dashboard.html): a Ward
 * picker plus that child's published results, GET
 * /api/continuous-assessments/mine/:childId, joined against GET
 * /api/modules (same two calls legacy makes) purely to show each
 * result's module title.
 */
export function useParentContinuousAssessments() {
  const { refresh } = useAuth();
  const { status: childrenStatus, errorMessage: childrenError, availableWards, reload: reloadChildren } = useParentChildren();
  const [selectedChildId, setSelectedChildId] = useState(null);
  const [status, setStatus] = useState("idle");
  const [restricted, setRestricted] = useState(false);
  const [results, setResults] = useState([]);
  const [moduleTitles, setModuleTitles] = useState({});
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
      setRestricted(false);
      setErrorMessage(null);
      try {
        const [caResults, modules] = await Promise.all([fetchContinuousAssessmentResults(childId), fetchModules()]);
        setResults(caResults);
        setModuleTitles(Object.fromEntries(modules.map((m) => [m.id, m.title])));
        setStatus("ready");
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await refresh();
          return;
        }
        if (isAccessRestrictedError(err)) {
          setRestricted(true);
          setResults([]);
          setStatus("ready");
          return;
        }
        setErrorMessage(err && err.message ? err.message : "Couldn't load Continuous Assessment results.");
        setStatus("error");
      }
    },
    [refresh]
  );

  useEffect(() => {
    load(selectedChildId);
  }, [selectedChildId, load]);

  return {
    childrenStatus,
    childrenError,
    availableWards,
    reloadChildren,
    selectedChildId,
    setSelectedChildId,
    status,
    restricted,
    results,
    moduleTitles,
    errorMessage,
    reload: () => load(selectedChildId),
  };
}
