import { useCallback, useState } from "react";
import { useParentChildren } from "./useParentChildren";
import { removeChild } from "../../api/parent";
import { useAuth } from "../../context/AuthContext";

/**
 * Ward overview + remove-child (Phase 6). Reproduces legacy
 * parentOverview() (dashboard.html) — the parent's own record plus one
 * fetch per linked child, now sourced from the shared useParentChildren()
 * (Phase 22) rather than duplicating that fetch here.
 */
export function useParentDashboard() {
  const { user: authUser } = useAuth();
  const { status, errorMessage, parent, wards, reload: load } = useParentChildren();
  const [actionError, setActionError] = useState(null);

  const removeWard = useCallback(
    async (childId) => {
      setActionError(null);
      try {
        await removeChild(authUser.id, childId);
        await load();
      } catch (err) {
        setActionError(err && err.message ? err.message : "Couldn't remove this child.");
        throw err;
      }
    },
    [authUser, load]
  );

  return { status, errorMessage, parent, wards, reload: load, removeWard, actionError, clearActionError: () => setActionError(null) };
}
