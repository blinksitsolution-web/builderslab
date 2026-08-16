import { useCallback, useEffect, useState } from "react";
import { fetchSponsors, createSponsor, updateSponsor, setSponsorActive, fetchSponsorLearners, setLearnerSponsor } from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Sponsors — NGOs, MPs, corporates, or individuals covering a learner's
 * fees. Structured identically to useAdminCorporateClients.js (same kind
 * of "organization funding some learners" entity) — full CRUD here, plus
 * a per-sponsor learner roster and the actual attach/detach action used
 * from AccountDetailDrawer.jsx.
 */
export function useAdminSponsors() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // loading | ready | error | forbidden
  const [error, setError] = useState(null);
  const [sponsors, setSponsors] = useState([]);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const result = await fetchSponsors();
      setSponsors(result);
      setStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      if (isForbiddenError(e)) {
        setStatus("forbidden");
        setError(e.message);
        return;
      }
      setStatus("error");
      setError(e.message);
    }
  }, [refresh]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveSponsor(id, payload) {
    const saved = id ? await updateSponsor(id, payload) : await createSponsor(payload);
    await load();
    return saved;
  }

  async function toggleActive(id, isActive) {
    await setSponsorActive(id, !isActive);
    await load();
  }

  async function loadLearners(id) {
    return fetchSponsorLearners(id);
  }

  async function attachSponsor(userId, sponsorId) {
    await setLearnerSponsor(userId, sponsorId);
    await load(); // learnerCount per sponsor changed
  }

  return { status, error, sponsors, reload: load, saveSponsor, toggleActive, loadLearners, attachSponsor };
}
