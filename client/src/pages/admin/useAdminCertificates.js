import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAccounts, fetchOfferingTypes, fetchProgrammes, fetchLearningInstances, fetchModules, fetchCertificateTemplates, issueCertificate } from "../../api/admin";
import { isUnauthorizedError, isForbiddenError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Data/state for the Admin Certificate Generator screen (Phase 26).
 * Migrates legacy adminCertificates()/refreshCertificateScope()/
 * generateOneCertificate()/generateBulkCertificates() (dashboard.html):
 * the same Offering Type/Programme/Learning Instance scope cascade
 * useAccountManagement.js already implements (see that hook's header
 * comment for the "forbidden ≠ empty" convention on the Learning Instance
 * catalog), narrowing the Learner/Module pickers, plus a required
 * certificate-template selector and single/bulk issuance against the
 * existing POST /api/certificates/issue Certificate Engine — no new
 * backend behavior.
 */
export function useAdminCertificates() {
  const { refresh } = useAuth();

  const [catalogStatus, setCatalogStatus] = useState("loading"); // "loading" | "ready" | "error"
  const [offeringTypes, setOfferingTypes] = useState([]);
  const [programmes, setProgrammes] = useState([]);
  const [instances, setInstances] = useState([]);
  const [instancesForbidden, setInstancesForbidden] = useState(false);
  const [modules, setModules] = useState([]);
  const [templates, setTemplates] = useState([]);

  const [offeringTypeId, setOfferingTypeIdRaw] = useState("");
  const [programmeId, setProgrammeIdRaw] = useState("");
  const [instanceSelection, setInstanceSelection] = useState("");

  const [learners, setLearners] = useState([]);
  const [learnersStatus, setLearnersStatus] = useState("loading");

  const [templateId, setTemplateId] = useState("");
  const [learnerId, setLearnerId] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [bulkModuleId, setBulkModuleId] = useState("");

  const [issuedCertificates, setIssuedCertificates] = useState([]);
  const [issueStatus, setIssueStatus] = useState("idle"); // "idle" | "loading" | "ready" | "error"
  const [issueError, setIssueError] = useState(null);
  const [issueNotice, setIssueNotice] = useState(null); // skipped/"nothing issued" message, not a hard error

  const loadCatalogs = useCallback(async () => {
    setCatalogStatus("loading");
    const [otResult, progResult, instResult, modResult, tmplResult] = await Promise.allSettled([
      fetchOfferingTypes(),
      fetchProgrammes(),
      fetchLearningInstances(),
      fetchModules(),
      fetchCertificateTemplates({ type: "module_completion", activeOnly: "true" }),
    ]);
    const coreResults = [otResult, progResult, modResult, tmplResult];
    const coreErrors = coreResults.filter((r) => r.status === "rejected").map((r) => r.reason);
    if (coreErrors.length > 0 && coreErrors.every(isUnauthorizedError)) {
      await refresh();
      return;
    }
    setOfferingTypes(otResult.status === "fulfilled" ? otResult.value : []);
    setProgrammes(progResult.status === "fulfilled" ? progResult.value : []);
    setModules(modResult.status === "fulfilled" ? modResult.value : []);
    setTemplates(tmplResult.status === "fulfilled" ? tmplResult.value : []);
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
  // Same cascade legacy applies to the Module dropdowns (hiding, not
  // removing, non-matching options) via refreshCertificateScope().
  const visibleModules = useMemo(
    () =>
      modules.filter((m) => {
        if (offeringTypeId && m.offeringTypeId !== offeringTypeId) return false;
        if (programmeId && m.programmeId !== programmeId) return false;
        return true;
      }),
    [modules, offeringTypeId, programmeId]
  );

  function setOfferingTypeId(value) {
    setOfferingTypeIdRaw(value);
    if (value && programmeId && !programmes.some((p) => p.id === programmeId && p.offeringTypeId === value)) setProgrammeIdRaw("");
  }
  function setProgrammeId(value) {
    setProgrammeIdRaw(value);
  }

  // ABRS v2.2 §22 Certification compliance remediation: certificate
  // eligibility must derive from the learner's historical enrollment and
  // completion records (Programme, Programme Run, Completed Activated
  // Courses, Programme Level where applicable) — never from a Programme
  // Run's CURRENT configuration/status. Defaulting this scope to "active
  // runs only" silently hid every learner whose Programme Run had since
  // moved to completed/archived, even though their completion record is
  // exactly the kind of historical fact §22 says certificates must be
  // able to draw on — a learner doesn't lose certificate eligibility
  // because the admin screen happened to be looking at "current" runs.
  // The default is therefore now unrestricted (every Learning Instance,
  // active or historical) for both the single-learner and bulk pickers;
  // "Active runs only" remains available as an explicit, admin-chosen
  // narrowing — the same as picking one specific run — never the silent
  // default.
  const learningScopeParams = useMemo(() => {
    const params = {};
    if (offeringTypeId) params.offeringTypeId = offeringTypeId;
    if (programmeId) params.programmeId = programmeId;
    if (instanceSelection === "ACTIVE_ONLY") {
      params.learningInstanceScope = "active";
    } else if (instanceSelection && instanceSelection !== "ALL") {
      params.learningInstanceId = instanceSelection;
    }
    // instanceSelection === "" or "ALL": no instance-scoping param — every
    // Learning Instance (active or historical) is in scope, per §22.
    return params;
  }, [offeringTypeId, programmeId, instanceSelection]);

  const loadLearners = useCallback(async () => {
    setLearnersStatus("loading");
    try {
      const rows = await fetchAccounts({ role: "learner", ...learningScopeParams });
      setLearners(rows);
      setLearnersStatus("ready");
      setLearnerId((prev) => (prev && rows.some((l) => l.id === prev) ? prev : rows[0]?.id || ""));
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

  useEffect(() => {
    if (visibleModules.length && !visibleModules.some((m) => m.id === moduleId)) setModuleId(visibleModules[0]?.id || "");
    if (visibleModules.length && !visibleModules.some((m) => m.id === bulkModuleId)) setBulkModuleId(visibleModules[0]?.id || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleModules]);

  // Generate for one learner — requires a template, matching legacy's
  // "certificate generation requires selecting a certificate template
  // before generation" enforcement in generateOneCertificate().
  async function generateOne() {
    if (!templateId) {
      setIssueError("Select a certificate template first.");
      return;
    }
    setIssueStatus("loading");
    setIssueError(null);
    setIssueNotice(null);
    try {
      const result = await issueCertificate({ templateId, courseId: moduleId, learnerIds: [learnerId] });
      if (result.certificates.length) {
        setIssuedCertificates(result.certificates);
        setIssueNotice(null);
      } else {
        setIssuedCertificates([]);
        setIssueNotice((result.skipped[0] && result.skipped[0].reason) || "Nothing issued.");
      }
      setIssueStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setIssueError(e && e.message ? e.message : "Couldn't generate this certificate.");
      setIssueStatus("error");
    }
  }

  // Generate for every learner currently in scope AND enrolled in the
  // chosen module — same explicit re-fetch-then-pass-ids approach
  // generateBulkCertificates() uses, so the backend never has to guess
  // membership itself.
  async function generateBulk() {
    if (!templateId) {
      setIssueError("Select a certificate template first.");
      return;
    }
    if (!bulkModuleId) {
      setIssueError("Select a module first.");
      return;
    }
    setIssueStatus("loading");
    setIssueError(null);
    setIssueNotice(null);
    try {
      const eligible = await fetchAccounts({ role: "learner", courseId: bulkModuleId, ...learningScopeParams });
      if (!eligible.length) {
        setIssuedCertificates([]);
        setIssueNotice("No learners match this Scope and Course — nothing to issue.");
        setIssueStatus("ready");
        return;
      }
      const result = await issueCertificate({ templateId, courseId: bulkModuleId, learnerIds: eligible.map((l) => l.id) });
      if (result.certificates.length) {
        setIssuedCertificates(result.certificates);
        setIssueNotice(null);
      } else {
        setIssuedCertificates([]);
        setIssueNotice("No learners enrolled, or certificates already issued to everyone in this module.");
      }
      setIssueStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setIssueError(e && e.message ? e.message : "Couldn't generate these certificates.");
      setIssueStatus("error");
    }
  }

  return {
    catalogStatus,
    offeringTypes,
    visibleProgrammes,
    visibleInstances,
    instancesForbidden,
    visibleModules,
    templates,

    offeringTypeId,
    setOfferingTypeId,
    programmeId,
    setProgrammeId,
    instanceSelection,
    setInstanceSelection,

    learners,
    learnersStatus,
    templateId,
    setTemplateId,
    learnerId,
    setLearnerId,
    moduleId,
    setModuleId,
    bulkModuleId,
    setBulkModuleId,

    issuedCertificates,
    issueStatus,
    issueError,
    issueNotice,
    generateOne,
    generateBulk,
  };
}
