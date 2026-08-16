import { useCallback, useEffect, useState } from "react";
import {
  fetchProgrammes,
  fetchOfferingTypes,
  fetchCorporateClients,
  createProgramme,
  updateProgramme,
  setProgrammeActive,
  uploadProgrammeImage,
} from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Programmes (Phase 31). Migrates legacy adminProgrammes()/
 * loadProgrammesList()/openProgrammeModal()/saveProgramme()/
 * toggleProgrammeActive() (dashboard.html) — same
 * /api/learning-offerings/programmes... contract. Second step in
 * Learning Offering Types → Programmes → Learning Instances.
 */
export function useAdminProgrammes() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // loading | ready | error | forbidden
  const [error, setError] = useState(null);
  const [programmes, setProgrammes] = useState([]);
  const [offeringTypes, setOfferingTypes] = useState([]);
  const [corporateClients, setCorporateClients] = useState([]);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [programmesResult, offeringTypesResult, corporateClientsResult] = await Promise.all([
        fetchProgrammes(),
        fetchOfferingTypes(),
        // Corporate Clients CRUD is out of scope here — only needed for the
        // Programme modal's dropdown, so a 403 (missing corporateClients.view)
        // degrades to an empty list rather than blocking the whole page.
        fetchCorporateClients().catch(() => []),
      ]);
      setProgrammes(programmesResult);
      setOfferingTypes(offeringTypesResult);
      setCorporateClients(corporateClientsResult);
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

  async function saveProgramme(id, payload, imageFile) {
    const saved = id ? await updateProgramme(id, payload) : await createProgramme(payload);
    if (imageFile) await uploadProgrammeImage(saved.id, imageFile);
    await load();
    return saved;
  }

  async function toggleActive(id, isActive) {
    await setProgrammeActive(id, !isActive);
    await load();
  }

  return { status, error, programmes, offeringTypes, corporateClients, reload: load, saveProgramme, toggleActive };
}
