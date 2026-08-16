import { useCallback, useEffect, useState } from "react";
import { fetchCorporateClients, createCorporateClient, updateCorporateClient, setCorporateClientActive, uploadCorporateClientLogo } from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Corporate Clients (Phase 33). Migrates legacy adminCorporateClients()/
 * loadCorporateClientsList()/openCorporateClientModal()/
 * saveCorporateClient()/toggleCorporateClientActive() (dashboard.html) —
 * same /api/learning-offerings/corporate-clients... contract.
 *
 * A Corporate Client is a company whose employees enrol under a Corporate
 * Training programme (e.g. "MTN Ghana"). Full CRUD + logo upload; this
 * list is also what the Programmes screen's Corporate Client dropdown,
 * the Participants form, and Corporate Coordinator admin-template
 * assignment all draw from (fetchCorporateClients() is reused there).
 */
export function useAdminCorporateClients() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // loading | ready | error | forbidden
  const [error, setError] = useState(null);
  const [clients, setClients] = useState([]);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      // Same DTL.corporateClients(true) as legacy — includes inactive
      // clients too, so the admin can see and reactivate them.
      const result = await fetchCorporateClients();
      setClients(result);
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

  async function saveClient(id, payload, logoFile) {
    const saved = id ? await updateCorporateClient(id, payload) : await createCorporateClient(payload);
    if (logoFile) await uploadCorporateClientLogo(saved.id, logoFile);
    await load();
    return saved;
  }

  async function toggleActive(id, isActive) {
    await setCorporateClientActive(id, !isActive);
    await load();
  }

  return { status, error, clients, reload: load, saveClient, toggleActive };
}
