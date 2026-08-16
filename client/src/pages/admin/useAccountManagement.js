import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchAccounts,
  fetchCampuses,
  fetchOfferingTypes,
  fetchProgrammes,
  fetchLearningInstances,
  fetchClasses,
  fetchModules,
  setAccountStatus,
  deleteAdminAccount,
  promoteLearners,
  setLearnerClass,
  setLearnerModules,
  updateInstructorAssignments,
  fetchInstructorAssignments,
  fetchInstructorAssignmentOptions,
} from "../../api/admin";
import { isUnauthorizedError, isForbiddenError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { usePermissions } from "../../context/PermissionContext";

const PAGE_SIZE = 15;

/**
 * Data/state for the Account Management screen (Phase 17). Mirrors legacy
 * adminAccounts()/renderAcctTable() (dashboard.html): role tab + search +
 * campus + Offering Type/Programme/Learning Instance cascade, filtered
 * server-side via the same GET /api/users query params (see
 * server/src/routes/users.js), plus the same row actions.
 *
 * Catalogs (campuses/offering types/programmes/classes/modules) are loaded
 * once, the same "load a catalog, keep it in memory" approach
 * loadLearningScopeCatalog() used — except the Learning Instance list is
 * requirePermission("learningInstances.view")-gated for admins (unlike the
 * other catalogs, which only require being signed in), so it's tracked with
 * its own status distinct from "loaded empty": a 403 there hides that one
 * filter tier rather than blocking the whole page, the same "forbidden ≠
 * empty" principle useAdminDashboard.js already applies to dashboard-stats.
 */
export function useAccountManagement() {
  const { user: authUser, refresh } = useAuth();
  const { isSuperAdmin } = usePermissions();

  const [catalogStatus, setCatalogStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [campuses, setCampuses] = useState([]);
  const [offeringTypes, setOfferingTypes] = useState([]);
  const [programmes, setProgrammes] = useState([]);
  const [classes, setClasses] = useState([]);
  const [modules, setModules] = useState([]);
  const [instances, setInstances] = useState([]);
  const [instancesForbidden, setInstancesForbidden] = useState(false);

  const [roleTab, setRoleTab] = useState(""); // "" = All, matches acctRoleFilter
  const [search, setSearch] = useState("");
  const [campus, setCampus] = useState("");
  const [offeringTypeId, setOfferingTypeId] = useState("");
  const [programmeId, setProgrammeId] = useState("");
  // "" = active runs only (learningInstanceScope=active), "ALL" = consolidated
  // (no scope param), otherwise a specific Learning Instance id — same three
  // states as legacy learningScopeFilterParams().
  const [instanceSelection, setInstanceSelection] = useState("");
  const [page, setPage] = useState(1);

  const [listStatus, setListStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [accounts, setAccounts] = useState([]);
  const [listError, setListError] = useState(null);

  const loadCatalogs = useCallback(async () => {
    setCatalogStatus("loading");
    const [campusesResult, offeringTypesResult, programmesResult, classesResult, modulesResult, instancesResult] = await Promise.allSettled([
      fetchCampuses(),
      fetchOfferingTypes(),
      fetchProgrammes(),
      fetchClasses(),
      fetchModules(),
      fetchLearningInstances(),
    ]);

    const coreResults = [campusesResult, offeringTypesResult, programmesResult, classesResult, modulesResult];
    const coreErrors = coreResults.filter((r) => r.status === "rejected").map((r) => r.reason);
    if (coreErrors.length > 0 && coreErrors.every(isUnauthorizedError)) {
      await refresh();
      return;
    }

    setCampuses(campusesResult.status === "fulfilled" ? campusesResult.value : []);
    setOfferingTypes(offeringTypesResult.status === "fulfilled" ? offeringTypesResult.value : []);
    setProgrammes(programmesResult.status === "fulfilled" ? programmesResult.value : []);
    setClasses(classesResult.status === "fulfilled" ? classesResult.value : []);
    setModules(modulesResult.status === "fulfilled" ? modulesResult.value : []);

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

  // Narrow the Programme list to the selected Offering Type, same as
  // onLearningScopeCascade()'s progSel.options hiding — done client-side
  // here since the whole catalog is already in memory.
  const visibleProgrammes = useMemo(() => {
    if (!offeringTypeId) return programmes;
    return programmes.filter((p) => p.offeringTypeId === offeringTypeId);
  }, [programmes, offeringTypeId]);

  // Same narrowing for the Learning Instance options: filtered to the
  // selected Offering Type/Programme, "Active runs only" and "All
  // (consolidated)" always present — see populateInstanceOptions().
  const visibleInstances = useMemo(() => {
    return instances.filter((li) => {
      if (offeringTypeId && li.offeringTypeId !== offeringTypeId) return false;
      if (programmeId && li.programmeId !== programmeId) return false;
      return true;
    });
  }, [instances, offeringTypeId, programmeId]);

  function handleOfferingTypeChange(value) {
    setOfferingTypeId(value);
    // If the currently selected Programme no longer belongs to the newly
    // chosen Offering Type, clear it — mirrors the legacy cascade's
    // progSel.value = "" reset.
    if (value && programmeId) {
      const stillValid = programmes.some((p) => p.id === programmeId && p.offeringTypeId === value);
      if (!stillValid) setProgrammeId("");
    }
    setPage(1);
  }

  const learningScopeParams = useMemo(() => {
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
    setListStatus("loading");
    setListError(null);
    try {
      const filters = { ...learningScopeParams };
      if (roleTab) filters.role = roleTab;
      if (search.trim()) filters.search = search.trim();
      if (campus) filters.campus = campus;
      const users = await fetchAccounts(filters);
      setAccounts(users);
      setListStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setListError(e.message);
      setListStatus("error");
    }
  }, [roleTab, search, campus, learningScopeParams, refresh]);

  useEffect(() => {
    if (catalogStatus === "loading") return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogStatus, roleTab, search, campus, learningScopeParams]);

  useEffect(() => {
    setPage(1);
  }, [roleTab, search, campus, learningScopeParams]);

  const totalPages = Math.max(1, Math.ceil(accounts.length / PAGE_SIZE));
  const pageAccounts = useMemo(() => accounts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [accounts, page]);

  const classNameById = useMemo(() => new Map(classes.map((c) => [c.id, c.name])), [classes]);
  const moduleTitleById = useMemo(() => new Map(modules.map((m) => [m.id, m.title])), [modules]);

  // ---- row actions --------------------------------------------------------
  // Every mutation below is a thin wrapper around an existing endpoint (see
  // api/admin.js) followed by a reload — same "act, then re-render from the
  // server's own response" pattern renderAcctTable()'s callers use, rather
  // than optimistically guessing the new row shape.

  async function suspendOrReactivate(account) {
    const nextStatus = account.status !== "suspended" ? "suspended" : "active";
    await setAccountStatus(account.id, nextStatus);
    await load();
  }

  async function removeAdmin(account) {
    await deleteAdminAccount(account.id);
    await load();
  }

  async function promote(account, toClassId) {
    const result = await promoteLearners([account.id], toClassId || undefined);
    const outcome = result.results && result.results[0];
    if (outcome && !outcome.ok) throw new Error(outcome.error || "Couldn't promote this learner.");
    await load();
  }

  async function saveLearnerClass(account, classId) {
    await setLearnerClass(account.id, classId || null);
    await load();
  }

  async function saveLearnerModules(account, moduleIds) {
    await setLearnerModules(account.id, moduleIds);
    await load();
  }

  async function saveInstructorAssignments(account, assignments) {
    await updateInstructorAssignments(account.id, assignments);
    await load();
  }

  return {
    isSuperAdmin,
    catalogStatus,
    campuses,
    offeringTypes,
    visibleProgrammes,
    visibleInstances,
    instances,
    classes,
    modules,
    instancesForbidden,
    classNameById,
    moduleTitleById,

    roleTab,
    setRoleTab: (v) => { setRoleTab(v); setPage(1); },
    search,
    setSearch,
    campus,
    setCampus: (v) => { setCampus(v); setPage(1); },
    offeringTypeId,
    setOfferingTypeId: handleOfferingTypeChange,
    programmeId,
    setProgrammeId: (v) => { setProgrammeId(v); setPage(1); },
    instanceSelection,
    setInstanceSelection: (v) => { setInstanceSelection(v); setPage(1); },

    page,
    setPage,
    totalPages,

    listStatus,
    listError,
    accounts: pageAccounts,
    totalAccounts: accounts.length,
    reload: load,

    suspendOrReactivate,
    removeAdmin,
    promote,
    saveLearnerClass,
    saveLearnerModules,
    saveInstructorAssignments,
    fetchInstructorAssignments,
    fetchInstructorAssignmentOptions,
  };
}
