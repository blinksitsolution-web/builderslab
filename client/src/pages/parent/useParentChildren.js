import { useCallback, useEffect, useState } from "react";
import { fetchUser } from "../../api/users";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Shared "which children does this parent have" loader (Phase 22) —
 * factors out the fetch-parent-then-fetch-each-child pattern every
 * legacy parent screen repeats (parentOverview/parentCertificates/
 * parentContinuousAssessment/parentTranscripts/parentProgress/
 * parentPayments/parentProgrammes/parentMessages all open the same way
 * in dashboard.html: `const u = await DTL.getUser(user.id); const
 * children = await Promise.all((u.childIds||[]).map(id => DTL.getUser(id)))`).
 * Every Phase 22 parent screen uses this instead of duplicating it;
 * useParentDashboard (Phase 6) now consumes it too.
 *
 * Each child fetch is isolated (Promise.allSettled) so one
 * failing/removed-mid-session child can't blank every other screen.
 */
export function useParentChildren() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [errorMessage, setErrorMessage] = useState(null);
  const [parent, setParent] = useState(null);
  const [wards, setWards] = useState([]);

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const freshParent = await fetchUser(authUser.id);
      const childIds = freshParent.childIds || [];

      const results = await Promise.allSettled(childIds.map((id) => fetchUser(id)));
      const nextWards = results.map((result, i) => {
        if (result.status === "fulfilled") {
          return { id: childIds[i], data: result.value, unavailable: false };
        }
        return { id: childIds[i], data: null, unavailable: true, error: result.reason?.message };
      });

      setParent(freshParent);
      setWards(nextWards);
      setStatus("ready");
    } catch (err) {
      if (isUnauthorizedError(err)) {
        // Session expired mid-visit — ProtectedRoute redirects to
        // /app/login once AuthContext reflects the unauthenticated state.
        await refresh();
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Something went wrong loading your account.");
      setStatus("error");
    }
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  // Convenience view: only the children that actually loaded, in the
  // shape most feature screens want (id + name alongside the full record).
  const availableWards = wards.filter((w) => !w.unavailable).map((w) => ({ id: w.id, name: w.data.name, data: w.data }));

  return { status, errorMessage, parent, wards, availableWards, reload: load };
}
