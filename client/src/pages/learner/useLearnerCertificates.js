import { useCallback, useEffect, useState } from "react";
import { fetchCertificates } from "../../api/parent";
import { isAccessRestrictedError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Certificates — self-view for a learner logged in directly (adult
 * learner). A non-adult learner's certificates are reached through their
 * parent's portal instead (see ParentCertificatesPage.jsx); this is the
 * same GET /api/certificates/learner/:userId endpoint, just called with
 * the caller's own id (already authorized by requireSelfParentOrStaff +
 * requireActiveAccess — see api/parent.js).
 */
export function useLearnerCertificates() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading");
  const [restricted, setRestricted] = useState(false);
  const [certificates, setCertificates] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setRestricted(false);
    setErrorMessage(null);
    try {
      const certs = await fetchCertificates(authUser.id);
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
  }, [authUser, refresh]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  return { status, restricted, certificates, errorMessage, reload: load };
}
