import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchDashboardStats, fetchOfferingTypes, fetchProgrammes, fetchLearningInstances } from "../../api/admin";
import { isUnauthorizedError, isForbiddenError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

const EMPTY_SECTION = { status: "loading", value: null, error: null };

/**
 * §21 Reporting: sourced entirely from GET /api/learning-instances/
 * dashboard-stats — the single, server-side, campus/Corporate-Client-
 * scoped aggregation over Programme Run/Enrollment/Payments (the
 * constitutional owners). Gated by requirePermission("dashboard.view"),
 * so it can legitimately 403 for an admin whose role template doesn't
 * grant it; that case is tracked as its own "forbidden" status, distinct
 * from "error" (something went wrong) and "ready" (no data yet) — see
 * Phase 8 section 10.
 *
 * The dashboard-stats figures are scoped by the same Offering
 * Type/Programme/Learning Instance cascade legacy's ovLS selects applied
 * (onLearningScopeCascade('ovLS', renderOverviewStats), dashboard.html) —
 * same three-state instance selection as useAccountManagement.js
 * ("" = active runs only, "ALL" = consolidated, otherwise one specific
 * run), defaulting to active-only exactly as legacy's Overview always did.
 */
export function useAdminDashboard() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [stats, setStats] = useState(EMPTY_SECTION);

  const [catalogStatus, setCatalogStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [offeringTypes, setOfferingTypes] = useState([]);
  const [programmes, setProgrammes] = useState([]);
  const [instances, setInstances] = useState([]);
  const [instancesForbidden, setInstancesForbidden] = useState(false);

  const [offeringTypeId, setOfferingTypeIdRaw] = useState("");
  const [programmeId, setProgrammeIdRaw] = useState("");
  const [instanceSelection, setInstanceSelection] = useState("");

  const loadCatalogs = useCallback(async () => {
    setCatalogStatus("loading");
    const [offeringTypesResult, programmesResult, instancesResult] = await Promise.allSettled([fetchOfferingTypes(), fetchProgrammes(), fetchLearningInstances()]);

    const coreResults = [offeringTypesResult, programmesResult];
    const coreErrors = coreResults.filter((r) => r.status === "rejected").map((r) => r.reason);
    if (coreErrors.length > 0 && coreErrors.every(isUnauthorizedError)) {
      await refresh();
      return;
    }

    setOfferingTypes(offeringTypesResult.status === "fulfilled" ? offeringTypesResult.value : []);
    setProgrammes(programmesResult.status === "fulfilled" ? programmesResult.value : []);

    if (instancesResult.status === "fulfilled") {
      setInstances(instancesResult.value);
      setInstancesForbidden(false);
    } else {
      setInstances([]);
      setInstancesForbidden(isForbiddenError(instancesResult.reason) || isUnauthorizedError(instancesResult.reason));
    }

    setCatalogStatus(coreErrors.length > 0 ? "error" : "ready");
  }, [refresh]);

  useEffect(() => {
    loadCatalogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  // Narrow Programme/Learning Instance options to the selected Offering
  // Type (and Learning Instance further to the selected Programme too) —
  // same client-side narrowing as useAccountManagement.js's
  // visibleProgrammes/visibleInstances, mirroring onLearningScopeCascade().
  const visibleProgrammes = useMemo(() => {
    if (!offeringTypeId) return programmes;
    return programmes.filter((p) => p.offeringTypeId === offeringTypeId);
  }, [programmes, offeringTypeId]);

  const visibleInstances = useMemo(() => {
    return instances.filter((li) => {
      if (offeringTypeId && li.offeringTypeId !== offeringTypeId) return false;
      if (programmeId && li.programmeId !== programmeId) return false;
      return true;
    });
  }, [instances, offeringTypeId, programmeId]);

  function setOfferingTypeId(value) {
    setOfferingTypeIdRaw(value);
    if (value && programmeId) {
      const stillValid = programmes.some((p) => p.id === programmeId && p.offeringTypeId === value);
      if (!stillValid) setProgrammeIdRaw("");
    }
  }

  const scopeParams = useMemo(() => {
    const params = {};
    if (offeringTypeId) params.offeringTypeId = offeringTypeId;
    if (programmeId) params.programmeId = programmeId;
    if (instanceSelection === "ALL") {
      // consolidated — no instance-scoping param at all
    } else if (instanceSelection) {
      params.learningInstanceId = instanceSelection;
    } else {
      params.learningInstanceScope = "active";
    }
    return params;
  }, [offeringTypeId, programmeId, instanceSelection]);

  const load = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setStats(EMPTY_SECTION);

    const [statsResult] = await Promise.allSettled([fetchDashboardStats(scopeParams)]);

    // A session that expired mid-visit 401s everything at once — treat as
    // a session problem, not a per-section error. ProtectedRoute redirects
    // once AuthContext reflects unauthenticated.
    if (statsResult.status === "rejected" && isUnauthorizedError(statsResult.reason)) {
      await refresh();
      return;
    }

    if (statsResult.status === "fulfilled") {
      setStats({ status: "ready", value: statsResult.value, error: null });
    } else if (isForbiddenError(statsResult.reason)) {
      setStats({ status: "forbidden", value: null, error: null });
    } else if (isUnauthorizedError(statsResult.reason)) {
      setStats({ status: "forbidden", value: null, error: null });
    } else {
      setStats({ status: "error", value: null, error: statsResult.reason?.message });
    }

    // stats owns its own ready/forbidden/error inline rendering in
    // AdminDashboard.jsx — the page-level status only ever reaches
    // "loading" or "ready" now that it's the sole data source.
    setStatus("ready");
  }, [authUser, refresh, scopeParams]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id, scopeParams]);

  return {
    status,
    stats,
    reload: load,
    catalogStatus,
    offeringTypes,
    visibleProgrammes,
    visibleInstances,
    offeringTypeId,
    setOfferingTypeId,
    programmeId,
    setProgrammeId: setProgrammeIdRaw,
    instanceSelection,
    setInstanceSelection,
    instancesForbidden,
  };
}
