import { useCallback, useEffect, useState } from "react";
import { useParentChildren } from "./useParentChildren";
import { fetchEnrolments } from "../../api/parent";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * My Programmes (Phase 22, completed Phase 33) — migrates the read side
 * of legacy parentProgrammes() / renderMyProgrammesPanel()
 * (dashboard.html): a Ward picker plus that child's current enrolments,
 * GET /api/enrolments/mine?targetUserId=<childId>.
 *
 * The "Enrol in another programme" wizard and its "Pay to activate" step
 * (toggleEnrolForm/onEnrolOfferingChange/submitAdditionalEnrolment in
 * dashboard.html) now live in EnrolAdditionalProgrammeModal.jsx /
 * PayEnrolmentModal.jsx, reusing the same public cascading-picker
 * endpoints self-registration uses (api/public.js) plus the
 * enrolment-specific endpoints below. See ParentProgrammesPage.jsx.
 */
export function useParentProgrammes() {
  const { refresh } = useAuth();
  const { status: childrenStatus, errorMessage: childrenError, availableWards, reload: reloadChildren } = useParentChildren();
  const [selectedChildId, setSelectedChildId] = useState(null);
  const [status, setStatus] = useState("idle");
  const [enrolments, setEnrolments] = useState([]);
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
        const rows = await fetchEnrolments(childId);
        setEnrolments(rows);
        setStatus("ready");
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await refresh();
          return;
        }
        setErrorMessage(err && err.message ? err.message : "Couldn't load programmes.");
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
    enrolments,
    errorMessage,
    reload: () => load(selectedChildId),
  };
}
