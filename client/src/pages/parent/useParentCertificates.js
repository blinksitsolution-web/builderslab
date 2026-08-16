import { useCallback, useEffect, useState } from "react";
import { useParentChildren } from "./useParentChildren";
import { fetchCertificates } from "../../api/parent";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Certificates (Phase 22) — migrates legacy parentCertificates() /
 * loadParentCertificates() (dashboard.html): a Ward picker plus that
 * child's issued certificates, GET /api/certificates/learner/:childId
 * (same endpoint api/parent.js's fetchCertificates wraps).
 */
export function useParentCertificates() {
  const { refresh } = useAuth();
  const { status: childrenStatus, errorMessage: childrenError, availableWards, reload: reloadChildren } = useParentChildren();
  const [selectedChildId, setSelectedChildId] = useState(null);
  const [status, setStatus] = useState("idle"); // "idle" | "loading" | "ready" | "error"
  const [restricted, setRestricted] = useState(false);
  const [certificates, setCertificates] = useState([]);
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
        const certs = await fetchCertificates(childId);
        setCertificates(certs);
        setStatus("ready");
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await refresh();
          return;
        }
        if (isAccessRestrictedError(err)) {
          setRestricted(true);
          setCertificates([]);
          setStatus("ready");
          return;
        }
        setErrorMessage(err && err.message ? err.message : "Couldn't load certificates.");
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
    certificates,
    errorMessage,
    reload: () => load(selectedChildId),
  };
}
