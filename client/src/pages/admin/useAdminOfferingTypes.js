import { useCallback, useEffect, useState } from "react";
import {
  fetchOfferingTypes,
  fetchOfferingTypeSettingsSchema,
  fetchCertificateTemplates,
  createOfferingType,
  updateOfferingType,
  activateOfferingType,
  deactivateOfferingType,
} from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Learning Offering Types (Phase 30). Migrates legacy adminOfferingTypes()/
 * loadOfferingTypesList()/openOfferingTypeModal()/saveOfferingType()/
 * toggleOfferingTypeActive() (dashboard.html) — same
 * /api/learning-offerings/types... contract.
 *
 * Loads the list, the default settings schema (for a brand-new type), and
 * the certificate template list (for the Certificates panel) once, the
 * same three calls legacy's openOfferingTypeModal() makes lazily —
 * fetched together up front here since every one of them is needed the
 * moment the page renders its list (icon/color/labels) or opens the
 * modal.
 */
export function useAdminOfferingTypes() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // loading | ready | error | forbidden
  const [error, setError] = useState(null);
  const [types, setTypes] = useState([]);
  const [settingsSchema, setSettingsSchema] = useState(null);
  const [certificateTemplates, setCertificateTemplates] = useState([]);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const [typesResult, schemaResult, templatesResult] = await Promise.all([
        fetchOfferingTypes(),
        fetchOfferingTypeSettingsSchema(),
        fetchCertificateTemplates().catch(() => []), // optional — Certificates panel degrades to "none yet"
      ]);
      setTypes(typesResult);
      setSettingsSchema(schemaResult);
      setCertificateTemplates(templatesResult);
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

  async function saveType(id, payload) {
    if (id) await updateOfferingType(id, payload);
    else await createOfferingType(payload);
    await load();
  }

  async function toggleActive(id, makeActive) {
    if (makeActive) await activateOfferingType(id);
    else await deactivateOfferingType(id);
    await load();
  }

  return { status, error, types, settingsSchema, certificateTemplates, reload: load, saveType, toggleActive };
}
