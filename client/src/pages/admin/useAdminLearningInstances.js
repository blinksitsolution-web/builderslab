import { useCallback, useEffect, useState } from "react";
import {
  fetchLearningInstances,
  fetchOfferingTypes,
  fetchProgrammes,
  fetchModules,
  fetchCampuses,
  fetchLearningInstance,
  createLearningInstance,
  updateLearningInstance,
  activateLearningInstance,
  completeLearningInstance,
  archiveLearningInstance,
  cancelLearningInstance,
  addLearningInstanceTarget,
  removeLearningInstanceTarget,
  setAcademicStructure,
  setOperationalConfig,
  setPeriodTargets,
  setPeriodPaymentRequirement,
  updateActivatedCourse as updateActivatedCourseApi,
  assignCourseToLearningInstance as assignCourseToLearningInstanceApi,
  removeCourseFromLearningInstance as removeCourseFromLearningInstanceApi,
  fetchOperationalGroups,
  createOperationalGroup as createOperationalGroupApi,
  updateOperationalGroup as updateOperationalGroupApi,
  deleteOperationalGroup as deleteOperationalGroupApi,
} from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Learning Instances (Phase 32). Migrates legacy adminLearningInstances()/
 * loadLearningInstancesList()/openLearningInstanceModal()/
 * saveLearningInstance()/transitionLearningInstance() (dashboard.html) —
 * same /api/learning-instances... contract. Third and final step in the
 * Learning Offering Types → Programmes → Learning Instances chain.
 *
 * A Learning Instance is one scheduled "run" of a Programme or a Module —
 * e.g. "Robotics & IoT — Jan 2026 Cohort" — with its own start/end dates
 * and lifecycle status (upcoming/active/completed/archived/cancelled).
 * A Programme/Module may have more than one Active run at a time (ABRS
 * v2.2 amendment — concurrent Programme Runs, e.g. separate cohorts for
 * different schools/batches, each with its own Academic Calendar and
 * registration window).
 */
export function useAdminLearningInstances() {
  const { refresh } = useAuth();

  const [status, setStatus] = useState("loading"); // loading | ready | error | forbidden
  const [error, setError] = useState(null);
  const [instances, setInstances] = useState([]);
  const [offeringTypes, setOfferingTypes] = useState([]);
  const [programmes, setProgrammes] = useState([]);
  const [modules, setModules] = useState([]);
  const [campuses, setCampuses] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(
    async (filterOverride) => {
      setStatus("loading");
      setError(null);
      const effectiveFilter = filterOverride !== undefined ? filterOverride : statusFilter;
      try {
        const [instancesResult, offeringTypesResult, programmesResult, modulesResult, campusesResult] = await Promise.all([
          fetchLearningInstances(effectiveFilter ? { status: effectiveFilter } : {}),
          fetchOfferingTypes(),
          fetchProgrammes(),
          fetchModules(),
          fetchCampuses(),
        ]);
        setInstances(instancesResult);
        setOfferingTypes(offeringTypesResult);
        setProgrammes(programmesResult);
        setModules(modulesResult);
        setCampuses(campusesResult);
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
    },
    [refresh, statusFilter]
  );

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeStatusFilter(next) {
    setStatusFilter(next);
    load(next);
  }

  async function getInstance(id) {
    return fetchLearningInstance(id);
  }

  async function saveInstance(id, payload) {
    const saved = id ? await updateLearningInstance(id, payload) : await createLearningInstance(payload);
    await load();
    return saved;
  }

  async function transitionInstance(id, action) {
    if (action === "activate") await activateLearningInstance(id);
    else if (action === "complete") await completeLearningInstance(id);
    else if (action === "archive") await archiveLearningInstance(id);
    else if (action === "cancel") await cancelLearningInstance(id);
    await load();
  }

  // Multi-target Learning Instances (Stage 4C/4E) — add/remove an
  // additional Programme/Module on an existing run. Both return the fresh
  // instance (with its updated `targets` array) so the modal can update
  // itself immediately without closing; the background list reload keeps
  // the underlying table row (which also shows target count) current too.
  async function addTarget(id, payload) {
    const fresh = await addLearningInstanceTarget(id, payload);
    await load();
    return fresh;
  }

  async function removeTarget(id, targetId) {
    const fresh = await removeLearningInstanceTarget(id, targetId);
    await load();
    return fresh;
  }

  // Academic structure & period-specific targets/payment (Phases 4–6).
  // Same "return the fresh instance/period, let the modal update itself
  // immediately, background-reload the list" pattern as addTarget/
  // removeTarget above.
  async function setStructure(id, structure) {
    const fresh = await setAcademicStructure(id, structure);
    await load();
    return fresh;
  }

  // v31 — Programme Run operational ownership (Delivery Modes, Campuses,
  // Fee, Installments, Capacity, Instructor). Same "return the fresh
  // instance so the modal updates immediately, background-reload the
  // list" pattern as setStructure above.
  async function setOperationalConfigFor(id, payload) {
    const fresh = await setOperationalConfig(id, payload);
    await load();
    return fresh;
  }

  async function setTargetsForPeriod(id, periodId, targetIds) {
    const fresh = await setPeriodTargets(id, periodId, targetIds);
    await load();
    return fresh;
  }

  async function setPaymentRequirementForPeriod(id, periodId, payload) {
    return setPeriodPaymentRequirement(id, periodId, payload);
  }

  // ABRS v2.1 Phase 5 prerequisite 2 — review/edit one Activated Course
  // row for a Run. Returns just that row (the modal replaces it in its
  // own local `activatedCourses` state), matching
  // setPaymentRequirementForPeriod's "don't reload the whole instance for
  // a single nested edit" pattern above.
  async function updateActivatedCourse(id, activatedCourseId, payload) {
    return updateActivatedCourseApi(id, activatedCourseId, payload);
  }

  async function assignCourseToInstance(id, courseId) {
    const fresh = await assignCourseToLearningInstanceApi(id, courseId);
    await load();
    return fresh;
  }

  async function removeCourseFromInstance(id, activatedCourseId) {
    const fresh = await removeCourseFromLearningInstanceApi(id, activatedCourseId);
    await load();
    return fresh;
  }

  // Operational Groups (v39, ABRS v2.2 §11 / Appendix A-9). Loaded/managed
  // per-Programme-Run from inside the modal, the same "single-thing-
  // changed, caller manages its own local list" pattern as
  // updateActivatedCourse above — no need to reload the whole instances
  // list for a group add/edit/remove.
  async function loadOperationalGroups(id, opts) {
    return fetchOperationalGroups(id, opts);
  }
  async function addOperationalGroup(id, payload) {
    return createOperationalGroupApi(id, payload);
  }
  async function editOperationalGroup(id, groupId, payload) {
    return updateOperationalGroupApi(id, groupId, payload);
  }
  async function removeOperationalGroup(id, groupId) {
    return deleteOperationalGroupApi(id, groupId);
  }

  return {
    status,
    error,
    instances,
    offeringTypes,
    programmes,
    modules,
    campuses,
    statusFilter,
    changeStatusFilter,
    reload: load,
    getInstance,
    saveInstance,
    transitionInstance,
    addTarget,
    removeTarget,
    setStructure,
    setOperationalConfigFor,
    setTargetsForPeriod,
    setPaymentRequirementForPeriod,
    updateActivatedCourse,
    assignCourseToInstance,
    removeCourseFromInstance,
    loadOperationalGroups,
    addOperationalGroup,
    editOperationalGroup,
    removeOperationalGroup,
  };
}
