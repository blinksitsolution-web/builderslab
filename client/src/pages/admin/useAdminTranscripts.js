import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAccounts, fetchOfferingTypes, fetchProgrammes, fetchLearningInstances, fetchClasses, fetchCampuses, fetchAdminTranscript } from "../../api/admin";
import { isUnauthorizedError, isForbiddenError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Data/state for the Admin Transcripts screen (Phase 26). Migrates legacy
 * adminTranscripts()/refreshTranscriptScope()/renderAdminTranscript()/
 * onTranscriptScopeChange()/generateBulkTranscripts() (dashboard.html):
 * the same Offering Type/Programme/Learning Instance scope cascade
 * useAccountManagement.js already implements (see that hook's header
 * comment for the shared "forbidden ≠ empty" convention on the Learning
 * Instance catalog), narrowing both an individual-learner picker and a
 * bulk generator (whole class / one campus / everyone in scope).
 *
 * Individual and bulk transcripts both call the same GET
 * /api/grades/:userId/transcript endpoint the parent portal's
 * useParentTranscript.js already wraps (fetchAdminTranscript here) — never
 * `editable`, matching admin's read-only legacy renderTranscript(id, true)
 * call... except legacy actually DOES pass `editable=true` for the
 * individual view (grade-entry inputs). That inline grade editing belongs
 * to the existing Grade Projects / grading workflow elsewhere in the app,
 * not this migration's stated scope (Transcripts, not grade entry) — so
 * this hook/page renders every transcript read-only, same as the parent
 * view. See AdminTranscriptsPage.jsx's scope note.
 */
export function useAdminTranscripts() {
  const { refresh } = useAuth();

  const [catalogStatus, setCatalogStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [offeringTypes, setOfferingTypes] = useState([]);
  const [programmes, setProgrammes] = useState([]);
  const [instances, setInstances] = useState([]);
  const [instancesForbidden, setInstancesForbidden] = useState(false);
  const [classes, setClasses] = useState([]);
  const [campuses, setCampuses] = useState([]);

  const [offeringTypeId, setOfferingTypeIdRaw] = useState("");
  const [programmeId, setProgrammeIdRaw] = useState("");
  const [instanceSelection, setInstanceSelection] = useState(""); // "" = active only, "ALL" = consolidated, else an id
  // Phase 10 — only meaningful when instanceSelection is a specific
  // instance id (not "" or "ALL"); that instance's own academicPeriods
  // (already embedded on every fetchLearningInstances() row) populate the
  // picker. "" = default (non-period-scoped) transcript for that instance.
  const [academicPeriodId, setAcademicPeriodIdRaw] = useState("");

  const [learners, setLearners] = useState([]);
  const [learnersStatus, setLearnersStatus] = useState("loading");
  const [selectedLearnerId, setSelectedLearnerId] = useState("");

  const [transcript, setTranscript] = useState(null);
  const [transcriptStatus, setTranscriptStatus] = useState("idle"); // "idle" | "loading" | "ready" | "error"
  const [transcriptError, setTranscriptError] = useState(null);

  const [bulkScope, setBulkScope] = useState("class"); // "class" | "campus" | "all-campuses"
  const [bulkClassId, setBulkClassId] = useState("");
  const [bulkCampus, setBulkCampus] = useState("");
  const [bulkTranscripts, setBulkTranscripts] = useState([]);
  const [bulkStatus, setBulkStatus] = useState("idle"); // "idle" | "loading" | "ready" | "error"
  const [bulkError, setBulkError] = useState(null);

  const loadCatalogs = useCallback(async () => {
    setCatalogStatus("loading");
    const [otResult, progResult, instResult, classResult, campusResult] = await Promise.allSettled([
      fetchOfferingTypes(),
      fetchProgrammes(),
      fetchLearningInstances(),
      fetchClasses(),
      fetchCampuses(),
    ]);
    const coreResults = [otResult, progResult, classResult, campusResult];
    const coreErrors = coreResults.filter((r) => r.status === "rejected").map((r) => r.reason);
    if (coreErrors.length > 0 && coreErrors.every(isUnauthorizedError)) {
      await refresh();
      return;
    }
    setOfferingTypes(otResult.status === "fulfilled" ? otResult.value : []);
    setProgrammes(progResult.status === "fulfilled" ? progResult.value : []);
    setClasses(classResult.status === "fulfilled" ? classResult.value : []);
    setCampuses(campusResult.status === "fulfilled" ? campusResult.value : []);
    if (instResult.status === "fulfilled") {
      setInstances(instResult.value);
      setInstancesForbidden(false);
    } else {
      setInstances([]);
      setInstancesForbidden(isForbiddenError(instResult.reason) || isUnauthorizedError(instResult.reason));
    }
    setCatalogStatus(coreErrors.length > 0 ? "error" : "ready");
  }, [refresh]);

  useEffect(() => {
    loadCatalogs();
  }, [loadCatalogs]);

  const visibleProgrammes = useMemo(() => (offeringTypeId ? programmes.filter((p) => p.offeringTypeId === offeringTypeId) : programmes), [programmes, offeringTypeId]);
  const visibleInstances = useMemo(
    () =>
      instances.filter((li) => {
        if (offeringTypeId && li.offeringTypeId !== offeringTypeId) return false;
        if (programmeId && li.programmeId !== programmeId) return false;
        return true;
      }),
    [instances, offeringTypeId, programmeId]
  );

  function setOfferingTypeId(value) {
    setOfferingTypeIdRaw(value);
    if (value && programmeId && !programmes.some((p) => p.id === programmeId && p.offeringTypeId === value)) setProgrammeIdRaw("");
  }
  function setProgrammeId(value) {
    setProgrammeIdRaw(value);
  }
  function setInstanceSelectionAndResetPeriod(value) {
    setInstanceSelection(value);
    setAcademicPeriodIdRaw(""); // a period picked for the previous instance selection is meaningless here
  }
  function setAcademicPeriodId(value) {
    setAcademicPeriodIdRaw(value);
  }
  const selectedInstanceAcademicPeriods = useMemo(() => {
    if (!instanceSelection || instanceSelection === "ALL") return [];
    const instance = instances.find((li) => li.id === instanceSelection);
    return instance?.academicPeriods || [];
  }, [instances, instanceSelection]);

  const learningScopeParams = useMemo(() => {
    const params = {};
    if (offeringTypeId) params.offeringTypeId = offeringTypeId;
    if (programmeId) params.programmeId = programmeId;
    if (instanceSelection === "ALL") {
      // consolidated — no instance-scoping param
    } else if (instanceSelection) {
      params.learningInstanceId = instanceSelection;
    } else {
      params.learningInstanceScope = "active";
    }
    return params;
  }, [offeringTypeId, programmeId, instanceSelection]);

  const loadLearners = useCallback(async () => {
    setLearnersStatus("loading");
    try {
      const rows = await fetchAccounts({ role: "learner", ...learningScopeParams });
      setLearners(rows);
      setLearnersStatus("ready");
      setSelectedLearnerId((prev) => (prev && rows.some((l) => l.id === prev) ? prev : rows[0]?.id || ""));
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setLearnersStatus("error");
    }
  }, [learningScopeParams, refresh]);

  useEffect(() => {
    if (catalogStatus === "loading") return;
    loadLearners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogStatus, learningScopeParams]);

  const loadTranscript = useCallback(
    async (learnerId, periodInstanceId, periodId) => {
      if (!learnerId) {
        setTranscript(null);
        setTranscriptStatus("idle");
        return;
      }
      setTranscriptStatus("loading");
      setTranscriptError(null);
      try {
        const t = await fetchAdminTranscript(learnerId, undefined, periodInstanceId && periodId ? { learningInstanceId: periodInstanceId, academicPeriodId: periodId } : {});
        setTranscript(t);
        setTranscriptStatus("ready");
      } catch (e) {
        if (isUnauthorizedError(e)) {
          await refresh();
          return;
        }
        setTranscriptError(e && e.message ? e.message : "Couldn't load this transcript.");
        setTranscriptStatus("error");
      }
    },
    [refresh]
  );

  useEffect(() => {
    // A specific instance + period must both be selected for a
    // period-scoped fetch; instance selection alone (or "ALL"/active-only)
    // keeps the default (non-period-scoped) transcript, same as before.
    const periodInstanceId = instanceSelection && instanceSelection !== "ALL" ? instanceSelection : "";
    loadTranscript(selectedLearnerId, periodInstanceId, academicPeriodId);
  }, [selectedLearnerId, instanceSelection, academicPeriodId, loadTranscript]);

  // Bulk generation: resolve the target learner ids from the already-scoped
  // `learners` list (mirrors legacy's window.__transcriptLearners re-use),
  // then fetch each one's transcript in turn — same "one printable batch"
  // behavior as generateBulkTranscripts().
  async function generateBulkTranscripts() {
    let targetIds;
    if (bulkScope === "class") {
      targetIds = learners.filter((l) => l.classId === bulkClassId || l.class_id === bulkClassId).map((l) => l.id);
    } else if (bulkScope === "campus") {
      targetIds = learners.filter((l) => l.campus === bulkCampus).map((l) => l.id);
    } else {
      targetIds = learners.map((l) => l.id);
    }
    if (!targetIds.length) {
      setBulkTranscripts([]);
      setBulkStatus("ready");
      setBulkError(null);
      return;
    }
    setBulkStatus("loading");
    setBulkError(null);
    try {
      const results = [];
      for (const id of targetIds) {
        results.push(await fetchAdminTranscript(id));
      }
      setBulkTranscripts(results);
      setBulkStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setBulkError(e && e.message ? e.message : "Couldn't generate transcripts for this scope.");
      setBulkStatus("error");
    }
  }

  return {
    catalogStatus,
    offeringTypes,
    visibleProgrammes,
    visibleInstances,
    instancesForbidden,
    classes,
    campuses,

    offeringTypeId,
    setOfferingTypeId,
    programmeId,
    setProgrammeId,
    instanceSelection,
    setInstanceSelection: setInstanceSelectionAndResetPeriod,
    academicPeriodId,
    setAcademicPeriodId,
    selectedInstanceAcademicPeriods,

    learners,
    learnersStatus,
    selectedLearnerId,
    setSelectedLearnerId,

    transcript,
    transcriptStatus,
    transcriptError,
    reloadTranscript: () => {
      const periodInstanceId = instanceSelection && instanceSelection !== "ALL" ? instanceSelection : "";
      return loadTranscript(selectedLearnerId, periodInstanceId, academicPeriodId);
    },

    bulkScope,
    setBulkScope,
    bulkClassId,
    setBulkClassId,
    bulkCampus,
    setBulkCampus,
    bulkTranscripts,
    bulkStatus,
    bulkError,
    generateBulkTranscripts,
  };
}
