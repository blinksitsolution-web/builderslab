import { useCallback, useEffect, useState } from "react";
import {
  fetchPaymentsOverview,
  fetchPaymentsLedger,
  fetchDefaulters,
  fetchPaymentSummary,
  setPaymentStatus,
  setAccessOverride,
  lookupByStudentCode,
  fetchClasses,
  fetchCampuses,
} from "../../api/admin";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

const LEDGER_TYPES = ["registration", "monthly", "termly", "course", "workshop", "bootcamp"];

/**
 * Data/state for the Admin Payments screen (Phase 18). Mirrors legacy
 * adminPayments() (dashboard.html): the payment-status overview table, the
 * full payment ledger, and the Defaulters KPIs, against the same backend
 * endpoints (see api/admin.js and server/src/routes/payments.js).
 *
 * Each section defaults to "Active runs only" (learningInstanceScope=
 * "active"), matching the legacy default exactly — toggled per-section to
 * "All Learning Instances (consolidated)" the same way Manage Accounts'
 * Learning Instance filter does, but simplified to a single toggle here
 * rather than the full Offering Type/Programme/Learning Instance cascade
 * (Phase 18 keeps the payments screen's own filters — search/class/
 * campus/type/month — the ones legacy adminPayments() actually renders;
 * see PaymentsPage.jsx for the scope note).
 */
export function usePaymentsManagement() {
  const { user: authUser, refresh } = useAuth();

  const [catalogStatus, setCatalogStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [classes, setClasses] = useState([]);
  const [campuses, setCampuses] = useState([]);

  // ---- overview (payment status per learner) --------------------------
  const [overviewStatus, setOverviewStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [overviewError, setOverviewError] = useState(null);
  const [overview, setOverview] = useState([]);
  const [overviewSearch, setOverviewSearch] = useState("");
  const [overviewClassId, setOverviewClassId] = useState("");
  const [overviewCampus, setOverviewCampus] = useState("");
  const [overviewConsolidated, setOverviewConsolidated] = useState(false);

  // ---- ledger (full payment history) -----------------------------------
  const [ledgerStatus, setLedgerStatus] = useState("loading");
  const [ledgerError, setLedgerError] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [ledgerClassId, setLedgerClassId] = useState("");
  const [ledgerCampus, setLedgerCampus] = useState("");
  const [ledgerType, setLedgerType] = useState("");
  const [ledgerMonth, setLedgerMonth] = useState("");
  const [ledgerConsolidated, setLedgerConsolidated] = useState(false);

  // ---- defaulters ---------------------------------------------------------
  const [defaultersStatus, setDefaultersStatus] = useState("loading");
  const [defaultersError, setDefaultersError] = useState(null);
  const [defaulters, setDefaulters] = useState(null);

  // ---- student-ID lookup ---------------------------------------------
  const [lookupCode, setLookupCode] = useState("");
  const [lookupResult, setLookupResult] = useState(null);
  const [lookupError, setLookupError] = useState(null);

  const loadCatalogs = useCallback(async () => {
    setCatalogStatus("loading");
    try {
      const [classesResult, campusesResult] = await Promise.all([fetchClasses(), fetchCampuses()]);
      setClasses(classesResult);
      setCampuses(campusesResult);
      setCatalogStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setCatalogStatus("error");
    }
  }, [refresh]);

  const overviewFilters = {
    ...(overviewClassId ? { classId: overviewClassId } : {}),
    ...(overviewCampus ? { campus: overviewCampus } : {}),
    ...(overviewConsolidated ? {} : { learningInstanceScope: "active" }),
  };

  const loadOverview = useCallback(async () => {
    setOverviewStatus("loading");
    setOverviewError(null);
    try {
      const learners = await fetchPaymentsOverview(overviewFilters);
      setOverview(learners);
      setOverviewStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setOverviewError(e.message);
      setOverviewStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overviewClassId, overviewCampus, overviewConsolidated, refresh]);

  const ledgerFilters = {
    ...(ledgerClassId ? { classId: ledgerClassId } : {}),
    ...(ledgerCampus ? { campus: ledgerCampus } : {}),
    ...(ledgerType ? { type: ledgerType } : {}),
    ...(ledgerMonth ? { month: ledgerMonth } : {}),
    ...(ledgerConsolidated ? {} : { learningInstanceScope: "active" }),
  };

  const loadLedger = useCallback(async () => {
    setLedgerStatus("loading");
    setLedgerError(null);
    try {
      const payments = await fetchPaymentsLedger(ledgerFilters);
      setLedger(payments);
      setLedgerStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setLedgerError(e.message);
      setLedgerStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerClassId, ledgerCampus, ledgerType, ledgerMonth, ledgerConsolidated, refresh]);

  const loadDefaulters = useCallback(async () => {
    setDefaultersStatus("loading");
    setDefaultersError(null);
    try {
      const data = await fetchDefaulters();
      setDefaulters(data);
      setDefaultersStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setDefaultersError(e.message);
      setDefaultersStatus("error");
    }
  }, [refresh]);

  useEffect(() => {
    loadCatalogs();
    loadDefaulters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  useEffect(() => {
    loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overviewClassId, overviewCampus, overviewConsolidated]);

  useEffect(() => {
    loadLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerClassId, ledgerCampus, ledgerType, ledgerMonth, ledgerConsolidated]);

  const filteredOverview = overviewSearch.trim()
    ? overview.filter(
        (l) =>
          l.name.toLowerCase().includes(overviewSearch.trim().toLowerCase()) ||
          (l.student_code || "").toLowerCase().includes(overviewSearch.trim().toLowerCase())
      )
    : overview;

  // ---- actions --------------------------------------------------------

  async function loadSummary(userId) {
    return fetchPaymentSummary(userId);
  }

  async function updatePaymentStatus(userId, payload) {
    await setPaymentStatus(userId, payload);
    await Promise.all([loadOverview(), loadLedger(), loadDefaulters()]);
  }

  async function grantOrRevokeAccessOverride(userId, payload) {
    await setAccessOverride(userId, payload);
    await loadOverview();
  }

  async function runLookup() {
    setLookupError(null);
    if (!lookupCode.trim()) {
      setLookupResult(null);
      return;
    }
    try {
      const result = await lookupByStudentCode(lookupCode.trim());
      setLookupResult(result);
    } catch (e) {
      setLookupResult(null);
      setLookupError(e.message);
    }
  }

  return {
    catalogStatus,
    classes,
    campuses,

    overviewStatus,
    overviewError,
    overview: filteredOverview,
    overviewSearch,
    setOverviewSearch,
    overviewClassId,
    setOverviewClassId,
    overviewCampus,
    setOverviewCampus,
    overviewConsolidated,
    setOverviewConsolidated,
    reloadOverview: loadOverview,

    ledgerStatus,
    ledgerError,
    ledger,
    ledgerClassId,
    setLedgerClassId,
    ledgerCampus,
    setLedgerCampus,
    ledgerType,
    setLedgerType,
    ledgerMonth,
    setLedgerMonth,
    ledgerConsolidated,
    setLedgerConsolidated,
    ledgerTypes: LEDGER_TYPES,
    reloadLedger: loadLedger,

    defaultersStatus,
    defaultersError,
    defaulters,
    reloadDefaulters: loadDefaulters,

    lookupCode,
    setLookupCode,
    lookupResult,
    lookupError,
    runLookup,

    loadSummary,
    updatePaymentStatus,
    grantOrRevokeAccessOverride,
  };
}
