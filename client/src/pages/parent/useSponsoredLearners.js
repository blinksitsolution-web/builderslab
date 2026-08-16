import { useCallback, useEffect, useState } from "react";
import { fetchChildrenCredentials } from "../../api/parent";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Sponsored Learners (Stage 4B) — the persistent, authorized view of
 * every learner a sponsor/coordinator account created, with credentials
 * where still available (see GET /:parentId/children/credentials,
 * routes/users.js — password comes back null once a learner has logged
 * in for themselves).
 */
export function useSponsoredLearners() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading");
  const [learners, setLearners] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const result = await fetchChildrenCredentials(authUser.id);
      setLearners(result);
      setStatus("ready");
    } catch (err) {
      if (isUnauthorizedError(err)) {
        await refresh();
        return;
      }
      setErrorMessage(err && err.message ? err.message : "Couldn't load your sponsored learners.");
      setStatus("error");
    }
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  return { status, learners, errorMessage, reload: load };
}
