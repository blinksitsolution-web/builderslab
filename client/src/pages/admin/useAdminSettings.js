import { useCallback, useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { fetchPublicSettings } from "../../api/public";
import {
  fetchCampuses,
  fetchOfferingTypes,
  fetchProgrammes,
  fetchModules,
  updateFees,
  addPaymentAccount,
  deletePaymentAccount,
  uploadLogo,
  uploadSignature,
  updateBranding,
  createCampus,
  updateCampus,
  setCampusOfferings,
  deleteCampus,
  createModule,
  updateModule,
  deleteModule,
  fetchCourseGroups,
  createCourseGroup,
  updateCourseGroup,
  deleteCourseGroup,
  fetchAcademicYears,
  createAcademicYear,
  activateAcademicYear,
  fetchAcademicTerms,
  createAcademicTerm,
  activateAcademicTerm,
  fetchCalendarPeriods,
  createCalendarPeriod,
  deleteCalendarPeriod,
  fetchCertificateOrgSettings,
  updateCertificateOrgSettings,
  uploadCertificateSignature,
  fetchCertificateTemplates,
  createCertificateTemplate,
  updateCertificateTemplate,
  duplicateCertificateTemplate,
  setCertificateTemplateActive,
  fetchCampusBrandingProfiles,
  createCampusBranding,
  updateCampusBranding,
  uploadCampusBrandingImage,
  fetchApiKeys,
  updateApiKeys,
  testAiConnection,
} from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { usePermissions } from "../../context/PermissionContext";

export const SETTINGS_TABS = [
  { key: "fees", label: "Fees & Payment Accounts" },
  { key: "branding", label: "Branding" },
  { key: "campuses", label: "Campuses" },
  { key: "modules", label: "Courses & Seasons" },
  { key: "courseGroups", label: "Course Groups" },
  { key: "calendar", label: "Academic Calendar" },
  { key: "certificates", label: "Certificate Settings" },
  { key: "campusBranding", label: "Campus Branding" },
  { key: "apiKeys", label: "API Keys" },
];

/**
 * Data/state for the Site Settings screen (Phase 27). Migrates legacy
 * adminSettings()/switchSettingsTab() (dashboard.html): one tab loads its
 * data lazily the first time it's opened (matching legacy's per-tab
 * renderer functions), then caches it in state until an action mutates it.
 *
 * Each tab's read endpoint has its own backend gate (see
 * server/src/routes/settings.js, modules.js, academicCalendar.js,
 * certificateTemplates.js, campusBranding.js):
 *   - fees/branding read from GET /api/settings/public — genuinely
 *     unauthenticated, never 403s.
 *   - campuses/modules lists (GET /api/modules/...) — also unauthenticated.
 *   - academic calendar / certificate templates / campus branding reads —
 *     requireAuth only (any signed-in user); this page is already behind
 *     the admin RoleRoute so these never 403 in practice, but the same
 *     forbidden-state handling is still wired for consistency.
 *   - API Keys (read AND write) — requireSuperAdmin. The tab itself is
 *     hidden for non-Super-Administrators (matching legacy's
 *     `user.isSuperAdmin ? ... : ""` tab-bar conditional) via
 *     `isSuperAdmin` below, but a stale client-side flag still gets a
 *     real, handled 403 from the backend if reached.
 *
 * Every mutation here still goes through the backend's own permission/role
 * gate regardless of what this hook or the tab UI shows — hiding a control
 * client-side is never treated as the actual authorization boundary.
 */
export function useAdminSettings() {
  const { refresh } = useAuth();
  const { isSuperAdmin } = usePermissions();
  // Optional deep-link state set by callers like ProgrammeGroupsModal's
  // "Configure campus offerings" action (navigate("/app/admin/settings",
  // { state: { initialTab: "campuses", focusCampusId } })) — read once on
  // mount only, same as any other router `state` payload; a plain reload
  // or direct visit to /admin/settings has no state and behaves exactly
  // as before (defaults to the "fees" tab).
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const tabFromQuery = searchParams.get("tab");
  const initialTab = location.state?.initialTab || tabFromQuery;
  const focusCampusId = location.state?.focusCampusId || null;

  const [activeTab, setActiveTab] = useState(() =>
    initialTab && SETTINGS_TABS.some((t) => t.key === initialTab) ? initialTab : "fees"
  );

  // React to deep-link navigation (e.g. Programme Definition "Manage Modules"
  // or Learning Instance "Manage Course Library") even when this page is
  // already mounted — reading initialTab only once on mount left repeat
  // navigations stuck on the default Fees tab.
  useEffect(() => {
    const tab = location.state?.initialTab || searchParams.get("tab");
    if (tab && SETTINGS_TABS.some((t) => t.key === tab)) {
      setActiveTab(tab);
    }
  }, [location.state?.initialTab, searchParams]);

  // One entry per tab: { status: "idle"|"loading"|"ready"|"error"|"forbidden", data, error }
  const [tabs, setTabsState] = useState(() =>
    Object.fromEntries(SETTINGS_TABS.map((t) => [t.key, { status: "idle", data: null, error: null }]))
  );

  const setTab = useCallback((key, patch) => {
    setTabsState((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }, []);

  const loaders = {
    fees: async () => {
      const s = await fetchPublicSettings();
      return { fees: s.fees || {}, paymentAccounts: s.paymentAccounts || [] };
    },
    branding: async () => {
      const s = await fetchPublicSettings();
      return { branding: s.branding || {} };
    },
    campuses: async () => {
      const [campuses, offeringTypes] = await Promise.all([fetchCampuses(), fetchOfferingTypes()]);
      return { campuses, offeringTypes };
    },
    modules: async () => {
      const modules = await fetchModules();
      return { modules };
    },
    courseGroups: async () => {
      const [courseGroups, offeringTypes, programmes] = await Promise.all([fetchCourseGroups(), fetchOfferingTypes(), fetchProgrammes()]);
      // Programmes are scoped to Kids STEM by default here since Course
      // Groups are a Builders' Lab (Kids STEM) concept per the spec, but
      // any programme's course groups can be loaded (fetchCourseGroups
      // (programmeId) is available to callers that need it) — this tab
      // starts unscoped so an admin managing multiple offering types
      // still sees everything.
      return { courseGroups, offeringTypes, programmes };
    },
    calendar: async () => {
      const { years, active } = await fetchAcademicYears();
      return { years, activeYear: active, selectedYearId: null, terms: [], activeTerm: null, selectedTermId: null, periods: [] };
    },
    certificates: async () => {
      const [org, templates] = await Promise.all([fetchCertificateOrgSettings(), fetchCertificateTemplates()]);
      return { org, templates };
    },
    campusBranding: async () => {
      const [campuses, profiles] = await Promise.all([fetchCampuses(), fetchCampusBrandingProfiles()]);
      return { campuses, profiles };
    },
    apiKeys: async () => {
      const apiKeys = await fetchApiKeys();
      return { apiKeys };
    },
  };

  const load = useCallback(
    async (key) => {
      setTab(key, { status: "loading", error: null });
      try {
        const data = await loaders[key]();
        setTab(key, { status: "ready", data });
      } catch (e) {
        if (isUnauthorizedError(e)) {
          await refresh();
          return;
        }
        if (isForbiddenError(e)) {
          setTab(key, { status: "forbidden", error: e.message });
          return;
        }
        setTab(key, { status: "error", error: e.message });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setTab, refresh]
  );

  // Load the active tab the first time it's selected.
  useEffect(() => {
    if (activeTab === "apiKeys" && !isSuperAdmin) return; // tab hidden — nothing to load
    if (tabs[activeTab] && tabs[activeTab].status === "idle") load(activeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isSuperAdmin]);

  function reload(key) {
    return load(key);
  }

  /* ---------------------------------------------------------------------
     Fees & Payment Accounts
     --------------------------------------------------------------------- */
  async function saveFees(payload) {
    await updateFees(payload);
    await load("fees");
  }
  async function createPaymentAccount(payload) {
    await addPaymentAccount(payload);
    await load("fees");
  }
  async function removePaymentAccount(id) {
    await deletePaymentAccount(id);
    await load("fees");
  }

  /* ---------------------------------------------------------------------
     Branding
     --------------------------------------------------------------------- */
  async function saveLogo(file) {
    await uploadLogo(file);
    await load("branding");
  }
  async function saveSignature({ file, adminSignatureName }) {
    if (file) await uploadSignature(file);
    await updateBranding({ adminSignatureName });
    await load("branding");
  }

  /* ---------------------------------------------------------------------
     Campuses
     --------------------------------------------------------------------- */
  async function addCampus(payload) {
    await createCampus(payload);
    await load("campuses");
  }
  async function toggleCampusPartner(id, isPartner) {
    await updateCampus(id, { isPartner });
    await load("campuses");
  }
  async function saveCampusProfile(id, payload, offeringTypeIds) {
    await updateCampus(id, payload);
    await setCampusOfferings(id, offeringTypeIds);
    await load("campuses");
  }
  async function removeCampus(id) {
    await deleteCampus(id);
    await load("campuses");
  }

  /* ---------------------------------------------------------------------
     Courses & Seasons
     --------------------------------------------------------------------- */
  async function addModule(payload) {
    await createModule(payload);
    await load("modules");
  }
  async function toggleModuleOpen(moduleId, isOpen) {
    await updateModule(moduleId, { isOpen });
    await load("modules");
  }
  async function removeModule(moduleId) {
    await deleteModule(moduleId);
    await load("modules");
  }

  /* ---------------------------------------------------------------------
     Course Groups — optional cross-level grouping/tag over Modules
     --------------------------------------------------------------------- */
  async function addCourseGroup(payload) {
    await createCourseGroup(payload);
    await load("courseGroups");
  }
  async function saveCourseGroup(courseGroupId, payload) {
    await updateCourseGroup(courseGroupId, payload);
    await load("courseGroups");
  }
  async function removeCourseGroup(courseGroupId) {
    await deleteCourseGroup(courseGroupId);
    await load("courseGroups");
  }
  // Not cached on the tab (per-course-group/per-class curriculum detail is
  // only needed while a specific course group's mapping editor is open) —
  // callers fetch on demand via fetchCourseGroup()/setCourseGroupClassModules()
  // directly.

  /* ---------------------------------------------------------------------
     Academic Calendar — years, terms, periods. Selection state (which
     year/term is being managed) lives inside the "calendar" tab's cached
     data, same as legacy's module-level _selectedCalYearId/_selectedCalTermId.
     --------------------------------------------------------------------- */
  async function selectYear(yearId) {
    const { terms, active } = await fetchAcademicTerms(yearId);
    const selectedTermId = (tabs.calendar.data?.selectedYearId === yearId && tabs.calendar.data?.selectedTermId) || (active ? active.id : terms[0] && terms[0].id) || null;
    setTab("calendar", { data: { ...tabs.calendar.data, selectedYearId: yearId, terms, activeTerm: active, selectedTermId, periods: [] } });
    if (selectedTermId) await selectTerm(selectedTermId, { ...tabs.calendar.data, selectedYearId: yearId, terms, activeTerm: active });
  }
  async function selectTerm(termId, baseData) {
    const periods = await fetchCalendarPeriods({ termId });
    setTab("calendar", { data: { ...(baseData || tabs.calendar.data), selectedTermId: termId, periods } });
  }
  async function addAcademicYear(payload) {
    const year = await createAcademicYear(payload);
    await load("calendar");
    return year;
  }
  async function makeYearActive(id) {
    await activateAcademicYear(id);
    await load("calendar");
  }
  async function addAcademicTerm(payload) {
    await createAcademicTerm(payload);
    await selectYear(payload.academicYearId);
  }
  async function makeTermActive(id, yearId) {
    await activateAcademicTerm(id);
    await selectYear(yearId);
  }
  async function addCalendarPeriod(payload) {
    await createCalendarPeriod(payload);
    await selectTerm(payload.termId);
  }
  async function removeCalendarPeriod(id, termId) {
    await deleteCalendarPeriod(id);
    await selectTerm(termId);
  }

  /* ---------------------------------------------------------------------
     Certificate Settings
     --------------------------------------------------------------------- */
  async function saveCertOrgSettings(payload) {
    await updateCertificateOrgSettings(payload);
    await load("certificates");
  }
  async function saveCertSignatures({ signature1File, signature2File, ...payload }) {
    if (signature1File) await uploadCertificateSignature(1, signature1File);
    if (signature2File) await uploadCertificateSignature(2, signature2File);
    await updateCertificateOrgSettings(payload);
    await load("certificates");
  }
  async function saveCertTemplate(id, payload) {
    if (id) await updateCertificateTemplate(id, payload);
    else await createCertificateTemplate(payload);
    await load("certificates");
  }
  async function duplicateTemplate(id) {
    await duplicateCertificateTemplate(id);
    await load("certificates");
  }
  async function toggleTemplateActive(id, active) {
    await setCertificateTemplateActive(id, active);
    await load("certificates");
  }

  /* ---------------------------------------------------------------------
     Campus Branding
     --------------------------------------------------------------------- */
  async function saveCampusBranding(campusName, exists, payload, uploads) {
    if (exists) await updateCampusBranding(campusName, payload);
    else await createCampusBranding({ campusName, ...payload });
    for (const [slot, file] of uploads) {
      if (file) await uploadCampusBrandingImage(campusName, slot, file);
    }
    await load("campusBranding");
  }

  /* ---------------------------------------------------------------------
     API Keys
     --------------------------------------------------------------------- */
  async function saveApiKeys(payload) {
    await updateApiKeys(payload);
    await load("apiKeys");
  }
  async function testConnection(provider) {
    return testAiConnection(provider);
  }

  return {
    tabs,
    activeTab,
    setActiveTab,
    reload,
    isSuperAdmin,
    visibleTabs: SETTINGS_TABS.filter((t) => t.key !== "apiKeys" || isSuperAdmin),
    focusCampusId,

    saveFees,
    createPaymentAccount,
    removePaymentAccount,

    saveLogo,
    saveSignature,

    addCampus,
    toggleCampusPartner,
    saveCampusProfile,
    removeCampus,

    addModule,
    toggleModuleOpen,
    removeModule,

    addCourseGroup,
    saveCourseGroup,
    removeCourseGroup,

    selectYear,
    selectTerm,
    addAcademicYear,
    makeYearActive,
    addAcademicTerm,
    makeTermActive,
    addCalendarPeriod,
    removeCalendarPeriod,

    saveCertOrgSettings,
    saveCertSignatures,
    saveCertTemplate,
    duplicateTemplate,
    toggleTemplateActive,

    saveCampusBranding,

    saveApiKeys,
    testConnection,
  };
}
