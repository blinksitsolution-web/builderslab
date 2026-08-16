import { useCallback, useEffect, useState } from "react";
import {
  fetchAccounts,
  fetchCampuses,
  fetchOfferingTypes,
  fetchClasses,
  fetchModules,
  fetchUser,
  setLearnerClass,
  setLearnerCampus,
  setLearnerModules,
  fetchInstructorsForLearner,
  createParticipant,
  fetchPaymentSummary,
  setPaymentStatus,
} from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Participants / Adult Learners (final admin migration pass). Migrates
 * legacy adminAdultLearners() (dashboard.html) — same
 * GET /api/users?role=learner&isAdult=1 contract (see api/admin.js and
 * server/src/routes/users.js), plus every row action legacy exposes
 * (Class, Campus, Modules, Instructors, Payment).
 *
 * "Participants" (role=learner, is_adult=1) cover Adult Professional,
 * Corporate Training and Bootcamp learners — they manage/pay for their own
 * access with no parent account required. Their class/campus are set here
 * independently of the child-learner Bulk Promotion workflow.
 */
export function useAdminAdultLearners() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // loading | ready | error | forbidden
  const [error, setError] = useState(null);
  const [learners, setLearners] = useState([]);

  const [catalogsReady, setCatalogsReady] = useState(false);
  const [campuses, setCampuses] = useState([]);
  const [offeringTypes, setOfferingTypes] = useState([]);
  const [classes, setClasses] = useState([]);
  const [modules, setModules] = useState([]);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const result = await fetchAccounts({ role: "learner", isAdult: 1 });
      setLearners(result);
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

  const loadCatalogs = useCallback(async () => {
    const [campusesResult, offeringTypesResult, classesResult, modulesResult] = await Promise.allSettled([fetchCampuses(), fetchOfferingTypes(), fetchClasses(), fetchModules()]);
    setCampuses(campusesResult.status === "fulfilled" ? campusesResult.value : []);
    setOfferingTypes(offeringTypesResult.status === "fulfilled" ? offeringTypesResult.value : []);
    setClasses(classesResult.status === "fulfilled" ? classesResult.value : []);
    setModules(modulesResult.status === "fulfilled" ? modulesResult.value : []);
    setCatalogsReady(true);
  }, []);

  useEffect(() => {
    load();
    loadCatalogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveLearnerClass(account, classId) {
    await setLearnerClass(account.id, classId || null);
    await load();
  }

  async function saveLearnerCampus(account, campus) {
    await setLearnerCampus(account.id, campus || null);
    await load();
  }

  async function saveLearnerModules(account, moduleIds) {
    await setLearnerModules(account.id, moduleIds);
    await load();
  }

  async function loadInstructorsFor(learnerId) {
    return fetchInstructorsForLearner(learnerId).catch(() => []);
  }

  // Legacy editLearnerClass/editLearnerCampus modals prefill from a fresh
  // GET /api/users/:id (not the list row) — same here, so the modal always
  // shows the true current value even if the list row is momentarily stale.
  async function loadLearnerDetail(learnerId) {
    return fetchUser(learnerId);
  }

  async function createParticipantAccount(payload) {
    const result = await createParticipant(payload);
    await load();
    return result;
  }

  async function savePaymentStatusFor(userId, payload) {
    await setPaymentStatus(userId, payload);
    await load();
  }

  return {
    status,
    error,
    learners,
    reload: load,
    catalogsReady,
    campuses,
    offeringTypes,
    classes,
    modules,
    saveLearnerClass,
    saveLearnerCampus,
    saveLearnerModules,
    loadInstructorsFor,
    loadLearnerDetail,
    createParticipantAccount,
    loadPaymentSummary: fetchPaymentSummary,
    savePaymentStatus: savePaymentStatusFor,
  };
}
