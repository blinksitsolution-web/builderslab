import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchClasses,
  fetchCampuses,
  fetchAccounts,
  promoteLearners,
  graduateLearners,
  repeatLearners,
  transferClass,
  transferCampus,
  fetchPromotionLog,
  applyManualPromotion,
  applyAutoPromotion,
  reversePromotionLog,
  fetchClassEligibility,
} from "../../api/admin";
import { isForbiddenError, isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Bulk Promotion (final admin migration pass). Migrates legacy
 * adminBulkPromotion()/previewBulkPromotion()/confirmBulkPromotion()/
 * onBpActionChange()/viewPromotionLog() (dashboard.html) — same
 * GET /api/users?role=learner&class=...&campus=... preview query, and the
 * same five actions (promote/graduate/repeat/transfer_class/
 * transfer_campus) against their existing endpoints (see api/admin.js).
 * Every action is written to promotion_log for audit; none of them touch
 * past terms' grades, attendance, or payments.
 */
export function useAdminBulkPromotion() {
  const { refresh } = useAuth();

  const [catalogStatus, setCatalogStatus] = useState("loading"); // loading | ready | error | forbidden
  const [catalogError, setCatalogError] = useState(null);
  const [classes, setClasses] = useState([]);
  const [campuses, setCampuses] = useState([]);

  const [campus, setCampus] = useState("");
  const [classId, setClassId] = useState("");

  // "idle" (no search yet) | "loading" | "ready" | "error"
  const [previewStatus, setPreviewStatus] = useState("idle");
  const [previewError, setPreviewError] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Checkpoint 4 report, Remaining work item 3 — class-level eligibility
  // check (per-learner breakdown is its own on-demand fetch, see
  // PromotionEligibilityModal). "idle" | "loading" | "ready" | "error".
  const [eligibilityStatus, setEligibilityStatus] = useState("idle");
  const [eligibilityByLearner, setEligibilityByLearner] = useState({});

  const [action, setAction] = useState("promote");
  const [targetClassId, setTargetClassId] = useState("");
  const [targetCampus, setTargetCampus] = useState("");
  const [overrideReason, setOverrideReason] = useState("");

  const [applying, setApplying] = useState(false);
  const [resultSummary, setResultSummary] = useState(null);

  const loadCatalogs = useCallback(async () => {
    setCatalogStatus("loading");
    setCatalogError(null);
    try {
      const [classesResult, campusesResult] = await Promise.all([fetchClasses(), fetchCampuses()]);
      setClasses(classesResult);
      setCampuses(campusesResult);
      setClassId((current) => current || (classesResult[0] ? classesResult[0].id : ""));
      setCatalogStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      if (isForbiddenError(e)) {
        setCatalogStatus("forbidden");
        setCatalogError(e.message);
        return;
      }
      setCatalogStatus("error");
      setCatalogError(e.message);
    }
  }, [refresh]);

  useEffect(() => {
    loadCatalogs();
  }, [loadCatalogs]);

  const isFinalClass = useMemo(() => classes.length > 0 && classId === classes[classes.length - 1].id, [classes, classId]);

  async function findLearners() {
    if (!classId) return;
    setPreviewStatus("loading");
    setPreviewError(null);
    setResultSummary(null);
    try {
      const filters = { role: "learner", class: classId };
      if (campus) filters.campus = campus;
      const learners = (await fetchAccounts(filters)).filter((l) => l.status !== "graduated");
      setCandidates(learners);
      setSelectedIds(new Set(learners.map((l) => l.id)));
      setAction("promote");
      setEligibilityStatus("idle");
      setEligibilityByLearner({});
      setPreviewStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setPreviewError(e.message);
      setPreviewStatus("error");
    }
  }

  function toggleSelected(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll(checked) {
    setSelectedIds(checked ? new Set(candidates.map((l) => l.id)) : new Set());
  }

  function backToList() {
    setResultSummary(null);
  }

  // Checkpoint 4 report, Remaining work item 3 — evaluates every learner
  // currently loaded (read-only; GET /api/promotion/eligibility) and
  // stores the results keyed by learnerId so the candidates table can
  // show an Eligible/Not eligible badge per row alongside the existing
  // per-learner breakdown modal.
  async function checkClassEligibility() {
    if (!classId) return;
    setEligibilityStatus("loading");
    try {
      const results = await fetchClassEligibility(classId);
      const byLearner = {};
      results.forEach((r) => {
        byLearner[r.learnerId] = r;
      });
      setEligibilityByLearner(byLearner);
      setEligibilityStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setEligibilityStatus("error");
    }
  }

  async function applyAction() {
    const ids = Array.from(selectedIds);
    if (!ids.length) throw new Error("Select at least one learner.");
    setApplying(true);
    let summary = "";
    try {
      if (action === "promote") {
        const result = await promoteLearners(ids);
        const failed = result.results.filter((r) => !r.ok);
        summary = `${result.results.length - failed.length} promoted successfully.${failed.length ? ` ${failed.length} could not be promoted (already at the highest class).` : ""}`;
      } else if (action === "graduate") {
        const result = await graduateLearners({ learnerIds: ids });
        summary = `${result.count} learner(s) marked as graduated. They're removed from active class rosters and defaulter reports; their records, transcripts, and certificates remain fully intact.`;
      } else if (action === "repeat") {
        const result = await repeatLearners({ learnerIds: ids });
        summary = `${result.count} learner(s) set to repeat — they stay in their current class under the new Academic Year.`;
      } else if (action === "transfer_class") {
        const result = await transferClass({ learnerIds: ids, toClassId: targetClassId });
        summary = `${result.count} learner(s) transferred to ${result.toClass}.`;
      } else if (action === "transfer_campus") {
        const result = await transferCampus({ learnerIds: ids, toCampus: targetCampus });
        summary = `${result.count} learner(s) transferred to ${result.toCampus}. Future certificates for them will use that campus's branding.`;
      } else if (action === "promote_eligible") {
        // Constitutional core (ABRS v2.1 §12): promotes ONLY learners who
        // meet this Programme's configured Promotion Policy — no override.
        const result = await applyAutoPromotion(classId);
        const relevant = result.results.filter((r) => ids.includes(r.learnerId));
        const promoted = relevant.filter((r) => r.promoted).length;
        summary = `${promoted} of ${relevant.length} selected learner(s) met the Promotion Policy and were promoted (Programme Level only — no other record changed).`;
      } else if (action === "promote_override") {
        // Same core, but eligible-or-overridden: a learner failing the
        // policy is still promoted if an override reason is supplied,
        // and that reason is recorded on the audit log either way.
        const result = await applyManualPromotion({ learnerIds: ids, overrideReason: overrideReason || undefined });
        const ok = result.results.filter((r) => r.ok).length;
        const needsReason = result.results.filter((r) => r.requiresOverrideReason).length;
        summary = `${ok} learner(s) promoted.${needsReason ? ` ${needsReason} did not meet the Promotion Policy and were skipped — supply an override reason to promote them anyway.` : ""}`;
      }
    } catch (e) {
      summary = `Some or all of this action failed: ${e.message || "unknown error"}`;
    } finally {
      setApplying(false);
    }
    setResultSummary(summary);
  }

  return {
    catalogStatus,
    catalogError,
    classes,
    campuses,
    reloadCatalogs: loadCatalogs,

    campus,
    setCampus,
    classId,
    setClassId,
    isFinalClass,

    previewStatus,
    previewError,
    candidates,
    selectedIds,
    toggleSelected,
    toggleSelectAll,
    findLearners,

    eligibilityStatus,
    eligibilityByLearner,
    checkClassEligibility,

    action,
    setAction,
    targetClassId,
    setTargetClassId,
    targetCampus,
    setTargetCampus,
    overrideReason,
    setOverrideReason,

    applying,
    resultSummary,
    applyAction,
    backToList,

    loadPromotionLog: fetchPromotionLog,
    reversePromotion: reversePromotionLog,
  };
}
