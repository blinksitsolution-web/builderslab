import { useEffect, useState } from "react";
import { Modal, Button, FormField, Input, Select, Badge, Alert } from "../../components/ui";
import ProgrammeRunWorkflowStatus from "./ProgrammeRunWorkflowStatus";
import LearningInstanceCourseLibrary from "./LearningInstanceCourseLibrary";
import { useToast } from "../../context/ToastContext";
import { fetchEligibleInstructors, fetchAcademicYears, fetchAcademicTerms, updateAcademicPeriod } from "../../api/admin";

const LI_STATUS_LABEL = { upcoming: "Upcoming", active: "Active", completed: "Completed", archived: "Archived", cancelled: "Cancelled" };
const LI_STATUS_TONE = { upcoming: "neutral", active: "success", completed: "warning", archived: "neutral", cancelled: "danger" };
// Mirrors ALLOWED_TRANSITIONS in server/src/utils/learningInstances.js —
// kept here purely to decide which action buttons to show; the server is
// the actual source of truth and re-checks every transition itself.
const LI_TRANSITIONS = { upcoming: ["active", "cancelled"], active: ["completed", "cancelled"], completed: ["archived"], cancelled: ["archived"], archived: [] };
const LI_ACTION_LABEL = { active: "Activate", completed: "Mark Complete", archived: "Archive", cancelled: "Cancel" };
const LI_ACTION_FN = { active: "activate", completed: "complete", archived: "archive", cancelled: "cancel" };

// Phase 4 — a run's Semester/Term breakdown is locked once it leaves
// "upcoming" (mirrors the server's own rule in setAcademicStructure), so
// the picker below is only ever shown/editable while status === upcoming.
const STRUCTURE_LABEL = { none: "No structure (single run)", semester: "Semester (2 periods)", term: "Term (3 periods)" };

// datetime-local <input> wants "YYYY-MM-DDTHH:mm"; the backend gives back a
// full ISO string — same convention as ProgrammeModal.jsx used to use for
// its (now-removed) Registration Window fields.
function toDatetimeLocal(iso) {
  return iso ? iso.slice(0, 16) : "";
}

/**
 * Add / Edit Learning Instance (Phase 32). Migrates legacy
 * openLearningInstanceModal()/renderLearningInstanceModal()/
 * saveLearningInstance()/transitionLearningInstance() — same
 * POST/PATCH /api/learning-instances... request shape and the same
 * one-Active-run-per-Programme/Module 409 handling.
 *
 * The Offering Type and Programme/Module are immutable after creation
 * (backend rejects any attempt to change them — "cancel and create a new
 * instance instead"), same as legacy: those fields render disabled once
 * `existingInstance` is set.
 *
 * Phases 4–6 add: setting the run's academic structure (Semester/Term)
 * while it's still upcoming; per-period active-target configuration; and
 * per-period payment requirement (full fee or deposit amount) configuration
 * — reusing this same modal rather than a separate screen.
 */
export default function LearningInstanceModal({
  open,
  existingInstance,
  offeringTypes,
  programmes,
  modules,
  campuses,
  onClose,
  onSave,
  onTransition,
  onAddTarget,
  onRemoveTarget,
  onSetStructure,
  onSetOperationalConfig,
  onSetPeriodTargets,
  onSetPeriodPaymentRequirement,
  onUpdateActivatedCourse,
  onAssignCourse,
  onRemoveCourse,
  onLoadOperationalGroups,
  onAddOperationalGroup,
  onEditOperationalGroup,
  onRemoveOperationalGroup,
}) {
  const toast = useToast();
  const isEdit = !!existingInstance;

  const [offeringTypeId, setOfferingTypeId] = useState("");
  const [kind, setKind] = useState("programme"); // "programme" | "module" — new instances only
  const [programmeId, setProgrammeId] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // Builders' Lab participation structure (v29) — which of the three
  // participation models (structured school-club journey / structured
  // journey via another delivery arrangement / individual course) this
  // run is configured for. Optional/editable at any time, unlike
  // offeringType/programme/module which are fixed at creation.
  const [participationStructure, setParticipationStructure] = useState("");

  const [saving, setSaving] = useState(false);
  const [transitionBusy, setTransitionBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  // Label for this instance's `classes` rows — "Programme Level" only
  // makes sense for Structured Builders' Lab (Foundation/Framework/
  // Skyline). Adult Professional/Corporate Training/Bootcamp reuse the
  // same `classes` table for Batch/Cohort/Section, so any display that
  // shows a class name must use the offering type's (or the programme's
  // own override of the) configured learningGroupLabel rather than
  // hardcoding "Programme Level" — otherwise an Adult Professional Batch
  // shows up mislabeled as a structured Level in the admin UI.
  const currentGroupLabel = isEdit
    ? (programmes.find((p) => p.id === existingInstance.programmeId)?.learningGroupLabel ||
        offeringTypes.find((t) => t.id === existingInstance.offeringTypeId)?.learningGroupLabel ||
        "Class")
    : "Class";

  // Multi-target Learning Instances (Stage 4C/4E). Local copy of the
  // run's targets so adding/removing one updates the modal immediately,
  // without waiting for the parent list to refetch. Re-synced from
  // existingInstance whenever the modal (re)opens or the parent hands it
  // a freshly-fetched instance.
  const [targets, setTargets] = useState([]);
  const [addKind, setAddKind] = useState("programme");
  const [addProgrammeId, setAddProgrammeId] = useState("");
  const [addModuleId, setAddModuleId] = useState("");
  const [targetBusy, setTargetBusy] = useState(false);
  const [targetError, setTargetError] = useState(null);

  // ABRS v2.1 Phase 5 prerequisite 2 — Activated Courses (§8/§9) admin
  // review/edit. Same "local list, per-row busy/error, replace-in-place
  // on success" pattern as targets above, since edits here are per-row,
  // not a single form submit.
  const [activatedCourses, setActivatedCourses] = useState([]);
  const [acBusy, setAcBusy] = useState({});
  const [acError, setAcError] = useState({});
  const [acInstructorOptions, setAcInstructorOptions] = useState([]);
  const [courseLibraryBusy, setCourseLibraryBusy] = useState(false);
  const [courseLibraryError, setCourseLibraryError] = useState(null);

  // Academic structure & period-specific targets/payment (Phases 4–6).
  const [academicPeriods, setAcademicPeriods] = useState([]);
  const [structureChoice, setStructureChoice] = useState("none");
  const [structureBusy, setStructureBusy] = useState(false);
  const [structureError, setStructureError] = useState(null);

  // Part 1 — Academic Period <-> Academic Term linking. The Institution
  // Academic Calendar (academic_years/academic_terms) is loaded once per
  // modal open; periodTermDrafts holds each period's in-progress
  // name/term/date edits, keyed by period id, seeded from the period's
  // currently-assigned Academic Term (if any).
  const [academicYears, setAcademicYears] = useState([]);
  const [academicTermsList, setAcademicTermsList] = useState([]);
  const [academicCalendarError, setAcademicCalendarError] = useState(null);
  const [periodTermDrafts, setPeriodTermDrafts] = useState({});
  const [periodTermBusy, setPeriodTermBusy] = useState({});
  const [periodTermError, setPeriodTermError] = useState({});

  // v31 — Programme Run operational ownership: Delivery Modes, Campuses,
  // Fee, Installments, Capacity, Instructor.
  const [opDeliveryModes, setOpDeliveryModes] = useState([]);
  const [opCampusIds, setOpCampusIds] = useState([]);
  // §15.2 Registration Fee — the Run's own one-time registration charge.
  // The Run's own recurring Tuition/Period Fee field was removed from this
  // modal since every Learning Instance now uses period-based payments
  // (see the "Academic Periods" section below, which owns each period's
  // own required amount) — but the backend PATCH /:id/operational-config
  // endpoint still accepts and preserves an existing feeGHS value for any
  // instance that already has one (omit = unchanged), so nothing reads or
  // depends on this modal ever clearing it. Until this field existed,
  // this column could never be set by an admin and every learner saw the
  // legacy site-wide default forever (see routes/learningInstances.js's
  // PATCH /:id/operational-config).
  const [opRegistrationFeeGHS, setOpRegistrationFeeGHS] = useState("");
  // Combined Registration + First Period Payment — only meaningful once
  // this Run has an academic structure (Semester/Term) with at least one
  // period's own payment requirement configured; see the helper text
  // rendered alongside the checkbox below for the full explanation shown
  // to the admin.
  const [opCombineRegistrationWithFirstPeriod, setOpCombineRegistrationWithFirstPeriod] = useState(false);
  const [opInstallmentsEnabled, setOpInstallmentsEnabled] = useState(""); // "" = inherit, "yes" | "no" = explicit override
  const [opCapacity, setOpCapacity] = useState("");
  const [opInstructorId, setOpInstructorId] = useState("");
  const [opInstructorName, setOpInstructorName] = useState(""); // display label for the currently-assigned instructor
  // Part 2 — Registration Window ownership belongs exclusively to the
  // Programme Run now (moved out of ProgrammeModal). Datetime-local
  // inputs use "" for unconfigured (NULL); the two force flags default
  // unchecked.
  const [opRegistrationOpensAt, setOpRegistrationOpensAt] = useState("");
  const [opRegistrationDeadline, setOpRegistrationDeadline] = useState("");
  const [opRegistrationForceOpen, setOpRegistrationForceOpen] = useState(false);
  const [opRegistrationForceClosed, setOpRegistrationForceClosed] = useState(false);
  const [opBusy, setOpBusy] = useState(false);
  const [opError, setOpError] = useState(null);
  // Instructor search — only instructors eligible for this run's Offering
  // Type/Programme are ever offered (see GET /api/users' additive
  // eligibility filter, server/src/routes/users.js). Debounced so typing
  // doesn't fire a request per keystroke.
  const [instructorSearch, setInstructorSearch] = useState("");
  const [instructorOptions, setInstructorOptions] = useState([]);
  const [instructorSearchBusy, setInstructorSearchBusy] = useState(false);
  const [instructorSearchError, setInstructorSearchError] = useState(null);
  const [instructorPickerOpen, setInstructorPickerOpen] = useState(false);

  // Operational Groups (v39, ABRS v2.2 §11 / Appendix A-9) — loaded
  // separately from the instance DTO (not embedded on it, unlike
  // activatedCourses/academicPeriods above), since a Run may have zero,
  // a handful, or dozens of these, and Reporting's enrolledCount per
  // group is cheap to compute but no reason to compute it on every
  // fetchLearningInstance() call that doesn't need it.
  const [opGroups, setOpGroups] = useState([]);
  const [opGroupsBusy, setOpGroupsBusy] = useState(false);
  const [opGroupsError, setOpGroupsError] = useState(null);
  const [ogDraft, setOgDraft] = useState(null); // null = not adding/editing; {} = new; {id,...} = editing existing
  const [ogSaving, setOgSaving] = useState(false);
  const [ogError, setOgError] = useState(null);
  // Per-period working state, keyed by period id — the checked target ids
  // and the payment-requirement fields being edited, plus per-period busy/
  // error so saving one period's config doesn't disable another's.
  const [periodTargetSelections, setPeriodTargetSelections] = useState({});
  const [periodPaymentDrafts, setPeriodPaymentDrafts] = useState({});
  const [periodBusy, setPeriodBusy] = useState({});
  const [periodError, setPeriodError] = useState({});
  // Mirrors `existingInstance`, but updated locally whenever a save
  // handler below receives a fresh, full instance back from the server
  // (every PATCH/POST route in this modal returns getLearningInstanceById()
  // — the complete, current DTO, not a partial patch). `existingInstance`
  // itself is a prop set once when the modal opens (AdminLearningInstancesPage's
  // `editorInstance` state) and is never touched again by this modal's own
  // saves — only a full close+reopen re-fetches it. Anything this modal
  // displays that should reflect what was *just* saved without requiring
  // that close+reopen (workflowStatus's Configure Pricing/Assign
  // Instructors badges, the read-only Assigned Instructors list) must read
  // `liveInstance`, not `existingInstance`, or it silently shows
  // one-save-stale state — exactly Issues 2/3/6's symptom of "I just did
  // this, why does it still say I haven't".
  const [liveInstance, setLiveInstance] = useState(existingInstance);

  useEffect(() => {
    if (!open) return;
    const li = existingInstance;
    setLiveInstance(li);
    const initialOfferingTypeId = li ? li.offeringTypeId : (offeringTypes[0] && offeringTypes[0].id) || "";
    setOfferingTypeId(initialOfferingTypeId);
    setKind(li ? (li.programmeId ? "programme" : "module") : "programme");
    setProgrammeId(li?.programmeId || "");
    setModuleId(li?.courseId || "");
    setName(li?.name || "");
    setStartDate(li?.startDate ? li.startDate.slice(0, 10) : "");
    setEndDate(li?.endDate ? li.endDate.slice(0, 10) : "");
    setParticipationStructure(li?.participationStructure || "");
    setFormError(null);

    // v31 — operational config init.
    setOpDeliveryModes(li?.deliveryModes || []);
    setOpCampusIds(li?.campusIds || []);
    setOpRegistrationFeeGHS(li?.registrationFeeGHS != null ? String(li.registrationFeeGHS) : "");
    setOpCombineRegistrationWithFirstPeriod(!!li?.combineRegistrationWithFirstPeriod);
    setOpInstallmentsEnabled(li?.installmentsEnabled == null ? "" : li.installmentsEnabled ? "yes" : "no");
    setOpCapacity(li?.capacity != null ? String(li.capacity) : "");
    setOpInstructorId(li?.instructorId || "");
    setOpInstructorName(li?.instructorName || "");
    setOpRegistrationOpensAt(toDatetimeLocal(li?.registrationOpensAt));
    setOpRegistrationDeadline(toDatetimeLocal(li?.registrationDeadline));
    setOpRegistrationForceOpen(!!li?.registrationForceOpen);
    setOpRegistrationForceClosed(!!li?.registrationForceClosed);
    setOpError(null);
    setInstructorSearch("");
    setInstructorOptions([]);
    setInstructorSearchError(null);
    setInstructorPickerOpen(false);

    setTargets(li?.targets || []);
    setAddKind("programme");
    setAddProgrammeId("");
    setAddModuleId("");
    setTargetError(null);

    setActivatedCourses(li?.activatedCourses || []);
    setAcBusy({});
    setAcError({});
    setAcInstructorOptions([]);

    const periods = li?.academicPeriods || [];
    setAcademicPeriods(periods);
    setStructureChoice(li?.academicStructure || "none");
    setStructureError(null);
    const nextSelections = {};
    const nextDrafts = {};
    const nextTermDrafts = {};
    periods.forEach((p) => {
      nextSelections[p.id] = (p.targets || []).map((t) => t.id);
      nextDrafts[p.id] = { mode: p.paymentMode || "", requiredAmountGHS: p.requiredAmountGHS != null ? String(p.requiredAmountGHS) : "" };
      nextTermDrafts[p.id] = { name: p.name || "", academicTermId: p.academicTermId || "", startDate: p.startDate || "", endDate: p.endDate || "" };
    });
    setPeriodTargetSelections(nextSelections);
    setPeriodPaymentDrafts(nextDrafts);
    setPeriodTermDrafts(nextTermDrafts);
    setPeriodTermBusy({});
    setPeriodTermError({});
    setPeriodBusy({});
    setPeriodError({});

    setOpGroups([]);
    setOpGroupsError(null);
    setOgDraft(null);
    setOgError(null);
  }, [open, existingInstance, offeringTypes]);

  // Operational Groups load on their own, only once there's a real Run to
  // scope them to (a brand-new, not-yet-saved instance has no id yet).
  useEffect(() => {
    if (!open || !isEdit || !onLoadOperationalGroups) return;
    let cancelled = false;
    setOpGroupsBusy(true);
    setOpGroupsError(null);
    onLoadOperationalGroups(existingInstance.id, { includeInactive: true })
      .then((groups) => {
        if (!cancelled) setOpGroups(groups);
      })
      .catch((e) => {
        if (!cancelled) setOpGroupsError(e.message);
      })
      .finally(() => {
        if (!cancelled) setOpGroupsBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isEdit, existingInstance, onLoadOperationalGroups]);

  // Part 1 — load the Institution Academic Calendar (years + terms) once
  // per modal open, so every period's Academic Term <select> below has
  // options. Loaded regardless of whether this Run has an academic
  // structure yet, since an admin might set the structure and configure
  // terms in the same sitting.
  useEffect(() => {
    if (!open || !isEdit) return;
    let cancelled = false;
    setAcademicCalendarError(null);
    Promise.all([fetchAcademicYears(), fetchAcademicTerms()])
      .then(([yearsResp, termsResp]) => {
        if (cancelled) return;
        setAcademicYears((yearsResp && yearsResp.years) || []);
        setAcademicTermsList((termsResp && termsResp.terms) || []);
      })
      .catch((e) => {
        if (!cancelled) setAcademicCalendarError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isEdit]);

  function academicTermLabel(termId) {
    const term = academicTermsList.find((t) => t.id === termId);
    if (!term) return "";
    const year = academicYears.find((y) => y.id === term.academic_year_id);
    return year ? `${year.name} — ${term.name}` : term.name;
  }

  // Saves one period's name/Academic Term/dates through the existing
  // PATCH /academic-periods/:periodId endpoint. The backend rejects the
  // save outright if academicTermId would end up null (§18/§2.1 — an
  // Academic Period may not exist independently of the Institution
  // Academic Calendar), so the same requirement is enforced here first
  // for immediate feedback rather than waiting on a round-trip.
  async function handleSaveAcademicPeriodTerm(periodId) {
    const draft = periodTermDrafts[periodId] || {};
    if (!draft.academicTermId) {
      setPeriodTermError((prev) => ({ ...prev, [periodId]: "Select an Academic Term from the Institution Academic Calendar before saving." }));
      return;
    }
    setPeriodTermBusy((prev) => ({ ...prev, [periodId]: true }));
    setPeriodTermError((prev) => ({ ...prev, [periodId]: null }));
    try {
      const { period } = await updateAcademicPeriod(existingInstance.id, periodId, {
        name: draft.name || undefined,
        academicTermId: draft.academicTermId,
        startDate: draft.startDate || "",
        endDate: draft.endDate || "",
      });
      setAcademicPeriods((prev) => prev.map((p) => (p.id === periodId ? period : p)));
      setPeriodTermDrafts((prev) => ({
        ...prev,
        [periodId]: { name: period.name || "", academicTermId: period.academicTermId || "", startDate: period.startDate || "", endDate: period.endDate || "" },
      }));
      toast.success("Academic Period updated.");
    } catch (e) {
      setPeriodTermError((prev) => ({ ...prev, [periodId]: e.message }));
    } finally {
      setPeriodTermBusy((prev) => ({ ...prev, [periodId]: false }));
    }
  }


  function startAddOperationalGroup() {
    setOgDraft({ name: "", displayLabel: "", feeGHS: "", capacity: "", instructorId: "", deliveryMode: "", campusId: "", registrationDeadline: "" });
    setOgError(null);
  }
  function startEditOperationalGroup(group) {
    setOgDraft({
      id: group.id,
      name: group.name,
      displayLabel: group.displayLabel || "",
      feeGHS: group.overrides.feeGHS != null ? String(group.overrides.feeGHS) : "",
      capacity: group.overrides.capacity != null ? String(group.overrides.capacity) : "",
      instructorId: group.overrides.instructorId || "",
      deliveryMode: group.overrides.deliveryMode || "",
      campusId: group.overrides.campusId || "",
      registrationDeadline: group.overrides.registrationDeadline || "",
    });
    setOgError(null);
  }
  function cancelOperationalGroupDraft() {
    setOgDraft(null);
    setOgError(null);
  }

  async function saveOperationalGroupDraft() {
    if (!ogDraft) return;
    setOgSaving(true);
    setOgError(null);
    const payload = {
      name: ogDraft.name.trim(),
      displayLabel: ogDraft.displayLabel.trim() || null,
      feeGHS: ogDraft.feeGHS === "" ? null : Number(ogDraft.feeGHS),
      capacity: ogDraft.capacity === "" ? null : Number(ogDraft.capacity),
      instructorId: ogDraft.instructorId || null,
      deliveryMode: ogDraft.deliveryMode || null,
      campusId: ogDraft.campusId || null,
      registrationDeadline: ogDraft.registrationDeadline || null,
    };
    if (!payload.name) {
      setOgError("Name is required.");
      setOgSaving(false);
      return;
    }
    try {
      const saved = ogDraft.id
        ? await onEditOperationalGroup(existingInstance.id, ogDraft.id, payload)
        : await onAddOperationalGroup(existingInstance.id, payload);
      setOpGroups((prev) => {
        const withCount = { ...saved, enrolledCount: ogDraft.id ? (prev.find((g) => g.id === saved.id) || {}).enrolledCount || 0 : 0 };
        const exists = prev.some((g) => g.id === saved.id);
        return exists ? prev.map((g) => (g.id === saved.id ? withCount : g)) : [...prev, withCount];
      });
      setOgDraft(null);
      toast.success(ogDraft.id ? "Operational Group updated." : "Operational Group created.");
    } catch (e) {
      setOgError(e.message);
    } finally {
      setOgSaving(false);
    }
  }

  async function handleRemoveOperationalGroup(group) {
    setOpGroupsBusy(true);
    setOpGroupsError(null);
    try {
      const result = await onRemoveOperationalGroup(existingInstance.id, group.id);
      if (result.deleted) {
        setOpGroups((prev) => prev.filter((g) => g.id !== group.id));
      } else {
        setOpGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, isActive: false } : g)));
        toast.info(`"${group.name}" has ${result.enrollmentCount} enrolment(s) and was retired instead of deleted.`);
      }
    } catch (e) {
      setOpGroupsError(e.message);
    } finally {
      setOpGroupsBusy(false);
    }
  }

  // Same "— select a Programme —" / "— no Programmes under this Offering
  // Type —" filtering legacy's liFilteredProgrammes()/liFilteredModules() do.
  const filteredProgrammes = programmes.filter((p) => p.offeringTypeId === offeringTypeId);
  const filteredModules = modules.filter((m) => m.offeringTypeId === offeringTypeId);
  // BOOTCAMP — INDIVIDUAL COURSE SAVE ERROR / INVALID STRUCTURE ALLOWED
  // fix: Bootcamp does not use Participation Structures at all (see
  // server/src/utils/learningInstances.js's isParticipationStructureAllowedForOfferingType
  // Bootcamp branch) — its model is Learning Instance -> Operational Group
  // -> Batch/Cohort -> Campus -> Registration Fee instead. The selector
  // below is removed entirely (not merely disabled) for Bootcamp so an
  // admin can never submit a value the backend will only reject, and so
  // the UI doesn't imply Bootcamp has this concept at all. Resolved from
  // the currently-selected offeringTypeId (new instance) or the existing
  // instance's own offeringTypeId (edit), same source `currentGroupLabel`
  // above already uses.
  const selectedOfferingTypeSlug = isEdit
    ? offeringTypes.find((t) => t.id === existingInstance.offeringTypeId)?.slug
    : offeringTypes.find((t) => t.id === offeringTypeId)?.slug;
  const showsParticipationStructure = selectedOfferingTypeSlug !== "bootcamp";
  // ROOT ARCHITECTURAL RULE: Bootcamp must never have Academic Periods.
  // Bootcamp is a short-course/run-based offering (one-time Registration
  // Fee, no Semester/Term breakdown) — the Academic Structure/Academic
  // Periods configuration below is removed entirely (not merely disabled)
  // for Bootcamp so an admin can never configure something the backend
  // will only reject (see utils/learningInstances.js's setAcademicStructure
  // Bootcamp guard), and so the UI doesn't imply Bootcamp has this concept
  // at all — same pattern as showsParticipationStructure above.
  const isBootcampOffering = selectedOfferingTypeSlug === "bootcamp";

  function handleOfferingTypeChange(nextId) {
    setOfferingTypeId(nextId);
    setProgrammeId("");
    setModuleId("");
    // Clear any previously-picked Participation Structure when switching to
    // Bootcamp so a stale selection from a prior Offering Type can never
    // be silently carried into a Save payload for an Offering Type that
    // doesn't support it at all.
    const nextSlug = offeringTypes.find((t) => t.id === nextId)?.slug;
    if (nextSlug === "bootcamp") setParticipationStructure("");
  }

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    try {
      if (!isEdit) {
        const payload = {
          offeringTypeId,
          programmeId: kind === "programme" ? programmeId || null : null,
          courseId: kind === "module" ? moduleId || null : null,
          name: name.trim() || null,
          startDate: startDate || null,
          endDate: endDate || null,
          participationStructure: showsParticipationStructure ? participationStructure || null : null,
        };
        if (!payload.programmeId && !payload.courseId) {
          setFormError("Select a Programme or a Course.");
          setSaving(false);
          return;
        }
        await onSave(null, payload);
        toast.success("Learning Instance created.");
      } else {
        await onSave(existingInstance.id, {
          name: name.trim() || null,
          startDate: startDate || null,
          endDate: endDate || null,
          participationStructure: showsParticipationStructure ? participationStructure || null : null,
        });
        toast.success("Learning Instance updated.");
      }
      onClose();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTransition(targetStatus) {
    setTransitionBusy(true);
    setFormError(null);
    try {
      await onTransition(existingInstance.id, LI_ACTION_FN[targetStatus]);
      onClose();
    } catch (e) {
      // A 409 conflict from the publish-readiness/other server-side checks
      // is shown inline here instead of interrupting the modal with an
      // alert. A 400 from the publish-readiness gate (Admin Workflow
      // Redesign) additionally carries `missingSteps` — append it so the
      // message matches what the checklist panel above already shows,
      // rather than just repeating the generic "isn't ready to publish
      // yet" text.
      const detail = Array.isArray(e.missingSteps) && e.missingSteps.length ? ` Missing: ${e.missingSteps.join(", ")}.` : "";
      setFormError(e.message + detail);
    } finally {
      setTransitionBusy(false);
    }
  }

  const nextTransitions = isEdit ? LI_TRANSITIONS[existingInstance.status] || [] : [];

  // Eligible additional targets: same Offering Type as this run, and not
  // already attached (primary or secondary) — mirrors what the server
  // would reject anyway, so the dropdown never offers a doomed choice.
  const attachedProgrammeIds = new Set(targets.filter((t) => t.programmeId).map((t) => t.programmeId));
  const attachedModuleIds = new Set(targets.filter((t) => t.courseId).map((t) => t.courseId));
  const addableProgrammes = programmes.filter((p) => p.offeringTypeId === offeringTypeId && !attachedProgrammeIds.has(p.id));
  const addableModules = modules.filter((m) => m.offeringTypeId === offeringTypeId && !attachedModuleIds.has(m.id));

  async function handleAddTarget() {
    const payload = addKind === "programme" ? { programmeId: addProgrammeId } : { courseId: addModuleId };
    if (!payload.programmeId && !payload.courseId) {
      setTargetError("Select a Programme or a Course to add.");
      return;
    }
    setTargetBusy(true);
    setTargetError(null);
    try {
      const fresh = await onAddTarget(existingInstance.id, payload);
      setTargets(fresh.targets || []);
      setActivatedCourses(fresh.activatedCourses || []);
      setLiveInstance(fresh);
      setAddProgrammeId("");
      setAddModuleId("");
      toast.success("Added to this Learning Instance.");
    } catch (e) {
      setTargetError(e.message);
    } finally {
      setTargetBusy(false);
    }
  }

  async function handleRemoveTarget(target) {
    setTargetBusy(true);
    setTargetError(null);
    try {
      const fresh = await onRemoveTarget(existingInstance.id, target.id);
      setTargets(fresh.targets || []);
      setActivatedCourses(fresh.activatedCourses || []);
      setLiveInstance(fresh);
      toast.success("Removed from this Learning Instance.");
    } catch (e) {
      setTargetError(e.message);
    } finally {
      setTargetBusy(false);
    }
  }

  // ABRS v2.1 Phase 5 prerequisite 2 — Activated Courses (§8/§9) review/
  // edit. Loads the full set of instructors eligible for this Run's
  // Programme once, the first time the section actually has a row to
  // show (no point querying for a Run with no Course targets yet) —
  // reused across every row's instructor dropdown rather than each row
  // running its own search, since an admin curating a whole Run's Course
  // list is a materially different task from assigning one lead
  // instructor (operational-config's picker above).
  useEffect(() => {
    if (!isEdit || !programmeId || !activatedCourses.length || acInstructorOptions.length) return;
    let cancelled = false;
    fetchEligibleInstructors({ programmeId })
      .then((results) => {
        if (!cancelled) setAcInstructorOptions(results || []);
      })
      .catch(() => {
        // Non-fatal — the instructor dropdown just falls back to "no
        // options" (the current value, if any, is still shown as read text
        // via instructorName on the row itself); every other Activated
        // Course field remains fully editable.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, programmeId, activatedCourses.length]);

  async function handleUpdateActivatedCourse(row, patch) {
    setAcBusy((prev) => ({ ...prev, [row.id]: true }));
    setAcError((prev) => ({ ...prev, [row.id]: null }));
    try {
      const updated = await onUpdateActivatedCourse(existingInstance.id, row.id, patch);
      setActivatedCourses((prev) => prev.map((r) => (r.id === row.id ? updated : r)));
      toast.success(`${row.courseTitle || "Course"} updated.`);
    } catch (e) {
      setAcError((prev) => ({ ...prev, [row.id]: e.message }));
    } finally {
      setAcBusy((prev) => ({ ...prev, [row.id]: false }));
    }
  }

  async function handleAssignCourse(courseId) {
    if (!onAssignCourse) return;
    setCourseLibraryBusy(true);
    setCourseLibraryError(null);
    try {
      const fresh = await onAssignCourse(existingInstance.id, courseId);
      setActivatedCourses(fresh.activatedCourses || []);
      setLiveInstance(fresh);
      toast.success("Course assigned to this Learning Instance.");
    } catch (e) {
      setCourseLibraryError(e.message);
    } finally {
      setCourseLibraryBusy(false);
    }
  }

  async function handleRemoveCourse(assignment) {
    if (!onRemoveCourse || !assignment) return;
    setCourseLibraryBusy(true);
    setCourseLibraryError(null);
    try {
      const fresh = await onRemoveCourse(existingInstance.id, assignment.id);
      setActivatedCourses(fresh.activatedCourses || []);
      setLiveInstance(fresh);
      toast.success("Course removed from this Learning Instance.");
    } catch (e) {
      setCourseLibraryError(e.message);
    } finally {
      setCourseLibraryBusy(false);
    }
  }

  // Phase 4 — set (or leave as "none") the run's Semester/Term breakdown.
  // Only offered while status === "upcoming"; the server rejects it
  // otherwise, but the picker is hidden past that point rather than
  // relying solely on the server's own rejection.
  async function handleSaveStructure() {
    if (structureChoice === "none") return;
    setStructureBusy(true);
    setStructureError(null);
    try {
      const fresh = await onSetStructure(existingInstance.id, structureChoice);
      setAcademicPeriods(fresh.academicPeriods || []);
      setLiveInstance(fresh);
      const nextSelections = {};
      const nextDrafts = {};
      const nextTermDrafts = {};
      (fresh.academicPeriods || []).forEach((p) => {
        nextSelections[p.id] = (p.targets || []).map((t) => t.id);
        nextDrafts[p.id] = { mode: p.paymentMode || "", requiredAmountGHS: p.requiredAmountGHS != null ? String(p.requiredAmountGHS) : "" };
        nextTermDrafts[p.id] = { name: p.name || "", academicTermId: p.academicTermId || "", startDate: p.startDate || "", endDate: p.endDate || "" };
      });
      setPeriodTargetSelections(nextSelections);
      setPeriodPaymentDrafts(nextDrafts);
      setPeriodTermDrafts(nextTermDrafts);
      toast.success("Academic structure set.");
    } catch (e) {
      setStructureError(e.message);
    } finally {
      setStructureBusy(false);
    }
  }

  // Instructor Assignment — a dedicated save (separate from the
  // "Save operational configuration" button below) so assigning/replacing/
  // removing the lead instructor is a single immediate action, the same
  // pattern this modal already uses for period targets/payment
  // requirements. Reuses the same PATCH /operational-config endpoint
  // (instructorId is one of its independent, optional fields).
  async function saveInstructor(nextInstructorId) {
    setOpBusy(true);
    setOpError(null);
    try {
      const fresh = await onSetOperationalConfig(existingInstance.id, { instructorId: nextInstructorId || null });
      setOpInstructorId(fresh.instructorId || "");
      setOpInstructorName(fresh.instructorName || "");
      setLiveInstance(fresh);
      setInstructorPickerOpen(false);
      setInstructorSearch("");
      setInstructorOptions([]);
      toast.success(nextInstructorId ? "Instructor assigned." : "Instructor removed.");
    } catch (e) {
      setOpError(e.message);
    } finally {
      setOpBusy(false);
    }
  }
  function handleAssignInstructor(instructor) {
    saveInstructor(instructor.id);
  }
  function handleRemoveInstructor() {
    saveInstructor(null);
  }

  // Debounced eligible-instructor search — only fires while the picker is
  // open. Eligibility (only instructors already assigned to this run's
  // Programme, or to any Programme of its Offering Type) is enforced
  // server-side by GET /api/users' additive role=instructor +
  // programmeId/offeringTypeId filter (server/src/routes/users.js) — this
  // just supplies those scope params on every search.
  useEffect(() => {
    if (!isEdit || !instructorPickerOpen) return;
    let cancelled = false;
    setInstructorSearchBusy(true);
    setInstructorSearchError(null);
    const timer = setTimeout(async () => {
      try {
        const results = await fetchEligibleInstructors({
          search: instructorSearch,
          programmeId: existingInstance.programmeId || undefined,
          offeringTypeId: existingInstance.offeringTypeId || undefined,
        });
        if (!cancelled) setInstructorOptions(results || []);
      } catch (e) {
        if (!cancelled) setInstructorSearchError(e.message);
      } finally {
        if (!cancelled) setInstructorSearchBusy(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instructorSearch, instructorPickerOpen, isEdit]);

  // v31 — Programme Run operational config (Delivery Modes, Campuses,
  // Fee, Installments, Capacity). Same "save, then trust the fresh
  // instance the backend returns" pattern as handleSaveStructure above.
  function toggleOpDeliveryMode(mode) {
    setOpDeliveryModes((prev) => (prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]));
  }
  function toggleOpCampus(campusId) {
    setOpCampusIds((prev) => (prev.includes(campusId) ? prev.filter((id) => id !== campusId) : [...prev, campusId]));
  }
  async function handleSaveOperationalConfig() {
    setOpBusy(true);
    setOpError(null);
    try {
      const fresh = await onSetOperationalConfig(existingInstance.id, {
        deliveryModes: opDeliveryModes,
        campusIds: opCampusIds,
        // feeGHS intentionally omitted — the field was removed from this
        // modal (see opRegistrationFeeGHS declaration above for why), and
        // the backend treats an omitted key as "leave unchanged", so any
        // pre-existing value on this instance is left exactly as-is.
        registrationFeeGHS: opRegistrationFeeGHS === "" ? null : Number(opRegistrationFeeGHS),
        combineRegistrationWithFirstPeriod: opCombineRegistrationWithFirstPeriod,
        installmentsEnabled: opInstallmentsEnabled === "" ? null : opInstallmentsEnabled === "yes",
        capacity: opCapacity === "" ? null : Number(opCapacity),
        registrationOpensAt: opRegistrationOpensAt || null,
        registrationDeadline: opRegistrationDeadline || null,
        registrationForceOpen: opRegistrationForceOpen,
        registrationForceClosed: opRegistrationForceClosed,
      });
      setOpDeliveryModes(fresh.deliveryModes || []);
      setOpCampusIds(fresh.campusIds || []);
      setOpRegistrationFeeGHS(fresh.registrationFeeGHS != null ? String(fresh.registrationFeeGHS) : "");
      setOpCombineRegistrationWithFirstPeriod(!!fresh.combineRegistrationWithFirstPeriod);
      setOpInstallmentsEnabled(fresh.installmentsEnabled == null ? "" : fresh.installmentsEnabled ? "yes" : "no");
      setOpCapacity(fresh.capacity != null ? String(fresh.capacity) : "");
      setOpRegistrationOpensAt(toDatetimeLocal(fresh.registrationOpensAt));
      setOpRegistrationDeadline(toDatetimeLocal(fresh.registrationDeadline));
      setOpRegistrationForceOpen(!!fresh.registrationForceOpen);
      setOpRegistrationForceClosed(!!fresh.registrationForceClosed);
      setLiveInstance(fresh);
      toast.success("Operational configuration saved.");
    } catch (e) {
      setOpError(e.message);
    } finally {
      setOpBusy(false);
    }
  }


  function toggleTargetForPeriod(periodId, targetId) {
    setPeriodTargetSelections((prev) => {
      const current = prev[periodId] || [];
      const next = current.includes(targetId) ? current.filter((id) => id !== targetId) : [...current, targetId];
      return { ...prev, [periodId]: next };
    });
  }

  // Phase 5 — full-replacement save: whatever's currently checked becomes
  // this period's entire active-target list (unchecking everything is
  // valid — it just means "not configured yet", the back-compat default).
  // PUT .../targets returns only { targets: [...] } for this one period
  // (not the whole instance), so the local academicPeriods copy is
  // patched in place rather than replaced wholesale.
  async function handleSavePeriodTargets(periodId) {
    setPeriodBusy((prev) => ({ ...prev, [periodId]: true }));
    setPeriodError((prev) => ({ ...prev, [periodId]: null }));
    try {
      const result = await onSetPeriodTargets(existingInstance.id, periodId, periodTargetSelections[periodId] || []);
      setAcademicPeriods((prev) => prev.map((p) => (p.id === periodId ? { ...p, targets: result.targets } : p)));
      toast.success("Period targets saved.");
    } catch (e) {
      setPeriodError((prev) => ({ ...prev, [periodId]: e.message }));
    } finally {
      setPeriodBusy((prev) => ({ ...prev, [periodId]: false }));
    }
  }

  // Phase 6 — configure (mode = "full"/"deposit") or clear (mode = "")
  // this period's payment requirement.
  async function handleSavePeriodPayment(periodId) {
    const draft = periodPaymentDrafts[periodId] || { mode: "", requiredAmountGHS: "" };
    setPeriodBusy((prev) => ({ ...prev, [periodId]: true }));
    setPeriodError((prev) => ({ ...prev, [periodId]: null }));
    try {
      const result = await onSetPeriodPaymentRequirement(existingInstance.id, periodId, {
        mode: draft.mode || null,
        requiredAmountGHS: draft.mode ? Number(draft.requiredAmountGHS) : null,
      });
      setAcademicPeriods((prev) => prev.map((p) => (p.id === periodId ? result.period : p)));
      toast.success("Period payment requirement saved.");
    } catch (e) {
      setPeriodError((prev) => ({ ...prev, [periodId]: e.message }));
    } finally {
      setPeriodBusy((prev) => ({ ...prev, [periodId]: false }));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit Learning Instance" : "New Learning Instance"}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving || transitionBusy}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={transitionBusy}>
            {isEdit ? "Save changes" : "Create Learning Instance"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ color: "var(--text-muted, #6b7280)", margin: 0 }}>
          One scheduled run of a Programme or a Course, with its own dates and status. A Programme/Course may have more than one Active run at a time (e.g. concurrent cohorts for different schools/batches) — each keeps its own Academic Calendar, registration window, and Operational Groups.
          The Offering Type and Programme/Course can't be changed after creation — cancel and create a new instance instead.
        </p>

        {isEdit && (
          <ProgrammeRunWorkflowStatus workflowStatus={liveInstance?.workflowStatus} status={liveInstance?.status} />
        )}

        <FormField label="Learning Offering Type">
          <Select value={offeringTypeId} onChange={(e) => handleOfferingTypeChange(e.target.value)} disabled={isEdit}>
            {offeringTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.icon || ""} {t.name}
              </option>
            ))}
          </Select>
        </FormField>

        {!isEdit && (
          <FormField label="Applies to">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="programme">A Programme</option>
              <option value="module">A Course</option>
            </Select>
          </FormField>
        )}

        {kind === "programme" && (
          <FormField label="Programme">
            <Select value={programmeId} onChange={(e) => setProgrammeId(e.target.value)} disabled={isEdit}>
              <option value="">{filteredProgrammes.length ? "— select a Programme —" : "— no Programmes under this Offering Type —"}</option>
              {filteredProgrammes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}

        {kind === "module" && (
          <FormField label="Course">
            <Select value={moduleId} onChange={(e) => setModuleId(e.target.value)} disabled={isEdit}>
              <option value="">{filteredModules.length ? "— select a Course —" : "— no Courses under this Offering Type —"}</option>
              {filteredModules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </Select>
          </FormField>
        )}

        <FormField label="Name / Title" helperText="Optional">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jan 2026 Cohort" />
        </FormField>

        {showsParticipationStructure && (
          <FormField
            label="Participation structure"
            helperText="Which Builders' Lab participation model this run is for — used by registration to show only appropriate active runs. Optional; leave unset for offering types this doesn't apply to."
          >
            <Select value={participationStructure} onChange={(e) => setParticipationStructure(e.target.value)}>
              <option value="">Unspecified / not applicable</option>
              <option value="structured_school_club">Structured journey — School Club</option>
              <option value="structured_other">Structured journey — other delivery arrangement</option>
              <option value="individual_course">Individual course</option>
            </Select>
          </FormField>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormField label="Start date">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </FormField>
          <FormField label="End date">
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </FormField>
        </div>

        {isEdit && (
          <FormField
            label="Additional Programmes / Courses"
            helperText="This run's primary target is set above and can't be changed. Attach more Programmes/Courses here so one run can cover several at once — each is still subject to the one-Active-run-per-Programme/Course rule."
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {targets.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {targets.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "6px 10px",
                        border: "1px solid var(--border, #e5e7eb)",
                        borderRadius: 8,
                      }}
                    >
                      <span>
                        {t.programmeId ? `Programme: ${t.programmeName || "—"}` : `Course: ${t.courseTitle || "—"}`}
                        {t.isPrimary && (
                          <span style={{ marginLeft: 8 }}>
                            <Badge tone="neutral">Primary</Badge>
                          </span>
                        )}
                      </span>
                      {!t.isPrimary && (
                        <Button variant="ghost" size="sm" loading={targetBusy} onClick={() => handleRemoveTarget(t)}>
                          Remove
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--text-muted, #6b7280)", margin: 0 }}>No targets yet.</p>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <Select value={addKind} onChange={(e) => { setAddKind(e.target.value); setAddProgrammeId(""); setAddModuleId(""); }} style={{ maxWidth: 160 }}>
                  <option value="programme">Programme</option>
                  <option value="module">Course</option>
                </Select>
                {addKind === "programme" ? (
                  <Select value={addProgrammeId} onChange={(e) => setAddProgrammeId(e.target.value)} style={{ flex: 1, minWidth: 160 }}>
                    <option value="">{addableProgrammes.length ? "— select a Programme to add —" : "— nothing left to add —"}</option>
                    {addableProgrammes.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Select value={addModuleId} onChange={(e) => setAddModuleId(e.target.value)} style={{ flex: 1, minWidth: 160 }}>
                    <option value="">{addableModules.length ? "— select a Course to add —" : "— nothing left to add —"}</option>
                    {addableModules.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title}
                      </option>
                    ))}
                  </Select>
                )}
                <Button variant="secondary" size="sm" loading={targetBusy} onClick={handleAddTarget}>
                  + Add
                </Button>
              </div>

              {targetError && <Alert variant="danger">{targetError}</Alert>}
            </div>
          </FormField>
        )}

        {isEdit && (
          <LearningInstanceCourseLibrary
            instanceName={liveInstance?.name || existingInstance?.name}
            modules={modules}
            activatedCourses={activatedCourses}
            onAssign={handleAssignCourse}
            onRemove={handleRemoveCourse}
            busy={courseLibraryBusy}
            error={courseLibraryError}
          />
        )}

        {isEdit && activatedCourses.filter((r) => r.status === "active").length > 0 && (
          <FormField
            label="Activated Courses"
            helperText='Every Course targeted on this run gets a row here automatically (defaulted to Active, not Hidden, Optional, order 0, no instructor). Nothing reads these values for registration yet unless this offering type has "Participation Structures / Activated Courses v2" switched on — reviewing and curating them here is what makes switching that on for a real offering type a deliberate choice instead of accepting whatever was auto-created.'
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {activatedCourses.filter((row) => row.status === "active").map((row) => (
                <div
                  key={row.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: "10px 12px",
                    border: "1px solid var(--border, #e5e7eb)",
                    borderRadius: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <b>{row.courseTitle || "(untitled course)"}</b>
                    <Badge tone={row.status === "active" ? "success" : "neutral"}>{row.status === "active" ? "Active" : "Inactive"}</Badge>
                  </div>

                  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <Select
                      value={row.status}
                      disabled={!!acBusy[row.id]}
                      onChange={(e) => handleUpdateActivatedCourse(row, { status: e.target.value })}
                      style={{ maxWidth: 130 }}
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </Select>

                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={row.isHidden}
                        disabled={!!acBusy[row.id]}
                        onChange={(e) => handleUpdateActivatedCourse(row, { isHidden: e.target.checked })}
                      />
                      Hidden
                    </label>

                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={row.isCompulsory}
                        disabled={!!acBusy[row.id]}
                        onChange={(e) => handleUpdateActivatedCourse(row, { isCompulsory: e.target.checked })}
                      />
                      Compulsory
                    </label>

                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                      Order
                      <Input
                        type="number"
                        value={row.sortOrder}
                        disabled={!!acBusy[row.id]}
                        onChange={(e) => handleUpdateActivatedCourse(row, { sortOrder: e.target.value === "" ? 0 : Number(e.target.value) })}
                        style={{ width: 64 }}
                      />
                    </label>

                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, flex: 1, minWidth: 180 }}>
                      Instructor
                      <Select
                        value={row.instructorId || ""}
                        disabled={!!acBusy[row.id]}
                        onChange={(e) => handleUpdateActivatedCourse(row, { instructorId: e.target.value || null })}
                        style={{ flex: 1 }}
                      >
                        <option value="">— none (Run-level) —</option>
                        {acInstructorOptions.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                        {row.instructorId && !acInstructorOptions.some((i) => i.id === row.instructorId) && (
                          <option value={row.instructorId}>{row.instructorName || "Currently assigned"}</option>
                        )}
                      </Select>
                    </label>
                  </div>

                  {acError[row.id] && <Alert variant="danger">{acError[row.id]}</Alert>}
                </div>
              ))}
            </div>
          </FormField>
        )}

        {isEdit && (
          <FormField
            label="Operational Configuration"
            helperText="Delivery Modes, Campuses, Fee, Installments and Capacity for this run — the source of truth registration now derives from. A Class under this Programme still overrides any of these it sets explicitly (e.g. a Weekend batch with its own fee); this is only the default/available set for the run as a whole."
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Delivery Modes</div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {["ON_CAMPUS", "ONLINE", "HYBRID"].map((mode) => (
                    <label key={mode} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                      <input type="checkbox" checked={opDeliveryModes.includes(mode)} onChange={() => toggleOpDeliveryMode(mode)} />
                      {mode === "ON_CAMPUS" ? "On-Campus" : mode === "ONLINE" ? "Online" : "Hybrid"}
                    </label>
                  ))}
                </div>
              </div>

              {(opDeliveryModes.includes("ON_CAMPUS") || opDeliveryModes.includes("HYBRID")) && (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Campuses</div>
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                    {(campuses || []).map((c) => (
                      <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                        <input type="checkbox" checked={opCampusIds.includes(c.id)} onChange={() => toggleOpCampus(c.id)} />
                        {c.name}
                      </label>
                    ))}
                    {!(campuses || []).length && <span style={{ color: "var(--text-muted, #6b7280)", fontSize: 13 }}>No campuses configured yet.</span>}
                  </div>
                </div>
              )}

              {/* Phase 2 — when this run has academic periods, warn that monthly billing is blocked */}
              {academicPeriods.length > 0 && (
                <Alert variant="info">
                  This run uses period-based billing (term / semester). Monthly billing is blocked for learners in this run — use the Academic Periods section below to configure per-period payment requirements.
                </Alert>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {/* Tuition/Period Fee field removed — every Learning Instance now
                    uses period-based payments, configured per-period in the
                    "Academic Periods" section below instead of here. */}
                <FormField label="Registration Fee (GHS)" helperText="One-time fee shown to parents/learners at registration for this run. Blank = fall back to Offering Type/global default.">
                  <Input type="number" min="0" value={opRegistrationFeeGHS} onChange={(e) => setOpRegistrationFeeGHS(e.target.value)} placeholder="e.g. 200" />
                </FormField>
                <FormField label="Capacity" helperText="Blank = uncapped.">
                  <Input type="number" min="0" value={opCapacity} onChange={(e) => setOpCapacity(e.target.value)} placeholder="e.g. 30" />
                </FormField>
              </div>

              <FormField label="Installments" helperText="Whether learners registering into this run can pay in installments.">
                <Select value={opInstallmentsEnabled} onChange={(e) => setOpInstallmentsEnabled(e.target.value)}>
                  <option value="">Inherit from Offering Type default</option>
                  <option value="yes">Enabled for this run</option>
                  <option value="no">Disabled for this run</option>
                </Select>
              </FormField>

              <FormField
                label="Registration Window"
                helperText="Registration Configuration belongs exclusively to this Programme Run. Blank open/deadline dates mean no restriction on that side; the force-open/force-closed overrides win over the dates whenever checked."
              >
                <div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <FormField label="Registration opens" helperText="Blank = open immediately.">
                      <Input type="datetime-local" value={opRegistrationOpensAt} onChange={(e) => setOpRegistrationOpensAt(e.target.value)} />
                    </FormField>
                    <FormField label="Registration deadline" helperText="Blank = no deadline.">
                      <Input type="datetime-local" value={opRegistrationDeadline} onChange={(e) => setOpRegistrationDeadline(e.target.value)} />
                    </FormField>
                  </div>
                  <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={opRegistrationForceOpen}
                        onChange={(e) => {
                          setOpRegistrationForceOpen(e.target.checked);
                          if (e.target.checked) setOpRegistrationForceClosed(false);
                        }}
                      />
                      Force open (overrides dates)
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={opRegistrationForceClosed}
                        onChange={(e) => {
                          setOpRegistrationForceClosed(e.target.checked);
                          if (e.target.checked) setOpRegistrationForceOpen(false);
                        }}
                      />
                      Force closed (overrides dates)
                    </label>
                  </div>
                </div>
              </FormField>

              {academicPeriods.length > 0 && (
                <FormField
                  label="Combined Registration + First Period Payment"
                  helperText={
                    "When checked, the Registration Fee above automatically becomes the payment requirement for the first academic period (Term 1 / Semester 1) — that period's own payment mode/amount is no longer independently configurable below; it's shown there as inherited/read-only. Paying the Registration Fee then satisfies both registration and the first period in one payment, unlocking that period's content immediately. When unchecked (default), registration works as it always has: the Registration Fee above activates the account, and the first period's own payment (configured independently below, under \"Academic Periods\") is a separate charge collected later. Later periods (Term 2, Term 3, Semester 2, …) are never affected by this setting."
                  }
                >
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={opCombineRegistrationWithFirstPeriod}
                      onChange={(e) => setOpCombineRegistrationWithFirstPeriod(e.target.checked)}
                    />
                    Combine registration with the first period's payment for this run
                  </label>
                </FormField>
              )}

              <div>
                <Button variant="secondary" size="sm" loading={opBusy} onClick={handleSaveOperationalConfig}>
                  Save operational configuration
                </Button>
              </div>
              {opError && <Alert variant="danger">{opError}</Alert>}
            </div>
          </FormField>
        )}

        {isEdit && (
          <FormField
            label="Assigned Instructors"
            helperText="Every instructor granted access to this Programme Run via Manage Accounts → Instructor Assignment (§8.2). Edit grants there — this is a read-only view of that same data."
          >
            {(liveInstance?.assignedInstructors || []).length === 0 ? (
              <p className="text-helper">No instructors assigned yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {liveInstance.assignedInstructors.map((a) => (
                  <div
                    key={a.id}
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      border: "1px solid var(--border, #e5e7eb)",
                      borderRadius: 8,
                      fontSize: 13,
                    }}
                  >
                    <strong>{a.instructorName}</strong>
                    <span style={{ color: "var(--text-muted, #6b7280)" }}>
                      Course: {a.courseTitle || "Any"} · {currentGroupLabel}: {a.className || "Any"} · Campus: {a.campusName || "Any"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </FormField>
        )}

        {isEdit && (
          <FormField
            label="Instructor Assignment"
            helperText="This run's lead instructor. Only instructors already assigned (via Manage Accounts) to this Programme, or to any Programme of this Offering Type, are eligible to be selected here."
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {opInstructorId && !instructorPickerOpen ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "6px 10px",
                    border: "1px solid var(--border, #e5e7eb)",
                    borderRadius: 8,
                  }}
                >
                  <span>{opInstructorName || "(assigned instructor)"}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button variant="ghost" size="sm" loading={opBusy} onClick={() => setInstructorPickerOpen(true)}>
                      Replace
                    </Button>
                    <Button variant="ghost" size="sm" loading={opBusy} onClick={handleRemoveInstructor}>
                      Remove
                    </Button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <Input
                    value={instructorSearch}
                    onChange={(e) => {
                      setInstructorPickerOpen(true);
                      setInstructorSearch(e.target.value);
                    }}
                    onFocus={() => setInstructorPickerOpen(true)}
                    placeholder="Search eligible instructors by name or email…"
                  />
                  {instructorPickerOpen && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {instructorSearchBusy && <span style={{ fontSize: 13, color: "var(--text-muted, #6b7280)" }}>Searching…</span>}
                      {!instructorSearchBusy && instructorOptions.length === 0 && (
                        <span style={{ fontSize: 13, color: "var(--text-muted, #6b7280)" }}>
                          No eligible instructors found{instructorSearch ? " for that search" : ""} — assign this instructor to the Programme/Offering Type first via Manage Accounts.
                        </span>
                      )}
                      {instructorOptions.map((inst) => (
                        <div
                          key={inst.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                            padding: "6px 10px",
                            border: "1px solid var(--border, #e5e7eb)",
                            borderRadius: 8,
                          }}
                        >
                          <span>
                            {inst.name}
                            <span style={{ color: "var(--text-muted, #6b7280)", marginLeft: 6, fontSize: 13 }}>{inst.email}</span>
                          </span>
                          <Button variant="ghost" size="sm" loading={opBusy} onClick={() => handleAssignInstructor(inst)}>
                            Assign
                          </Button>
                        </div>
                      ))}
                      {opInstructorId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setInstructorPickerOpen(false);
                            setInstructorSearch("");
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  )}
                  {instructorSearchError && <Alert variant="danger">{instructorSearchError}</Alert>}
                </div>
              )}
            </div>
          </FormField>
        )}

        {isEdit && (
          <FormField
            label="Operational Groups"
            helperText={`Batches/cohorts/sections that exist purely to organize this run's delivery — e.g. "Weekend Batch" or "July Cohort". Not a Programme Level and never affects one: a learner's Level is changed only via Promotion, on the Manage Accounts page, entirely separately from anything here. Each override below is optional and falls back to this run's own Operational Configuration (above) when left blank.`}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {opGroupsError && <Alert variant="danger">{opGroupsError}</Alert>}

              {opGroups.length === 0 && !opGroupsBusy && <span style={{ color: "var(--text-muted, #6b7280)", fontSize: 13 }}>No Operational Groups yet.</span>}

              {opGroups.map((g) => (
                <div
                  key={g.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "8px 10px",
                    border: "1px solid var(--border, #e5e7eb)",
                    borderRadius: 8,
                    opacity: g.isActive ? 1 : 0.55,
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontWeight: 600 }}>
                      {g.displayLabel || g.name} {!g.isActive && <Badge tone="neutral">Retired</Badge>}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-muted, #6b7280)" }}>
                      {[
                        g.overrides.deliveryMode,
                        g.overrides.campusId ? "campus set" : null,
                        g.overrides.feeGHS != null ? `GHS ${g.overrides.feeGHS}` : null,
                        g.overrides.capacity != null ? `capacity ${g.overrides.capacity}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "No overrides — inherits everything from this run"}
                      {` · ${g.enrolledCount || 0} enrolled`}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <Button variant="ghost" size="sm" onClick={() => startEditOperationalGroup(g)}>
                      Edit
                    </Button>
                    {g.isActive && (
                      <Button variant="ghost" size="sm" loading={opGroupsBusy} onClick={() => handleRemoveOperationalGroup(g)}>
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              ))}

              {ogDraft ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 10, border: "1px solid var(--border, #e5e7eb)", borderRadius: 8 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <FormField label="Name">
                      <Input value={ogDraft.name} onChange={(e) => setOgDraft({ ...ogDraft, name: e.target.value })} placeholder="e.g. Weekend Batch" />
                    </FormField>
                    <FormField label="Display Label" helperText="Optional — shown to learners instead of Name if set.">
                      <Input value={ogDraft.displayLabel} onChange={(e) => setOgDraft({ ...ogDraft, displayLabel: e.target.value })} />
                    </FormField>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <FormField label="Fee override (GHS)" helperText="Blank = inherit this run's fee.">
                      <Input type="number" min="0" value={ogDraft.feeGHS} onChange={(e) => setOgDraft({ ...ogDraft, feeGHS: e.target.value })} />
                    </FormField>
                    <FormField label="Capacity override" helperText="Blank = inherit this run's capacity.">
                      <Input type="number" min="0" value={ogDraft.capacity} onChange={(e) => setOgDraft({ ...ogDraft, capacity: e.target.value })} />
                    </FormField>
                  </div>
                  <FormField label="Delivery Mode override" helperText="Must be one of this run's own configured Delivery Modes above. Blank = inherit.">
                    <Select value={ogDraft.deliveryMode} onChange={(e) => setOgDraft({ ...ogDraft, deliveryMode: e.target.value })}>
                      <option value="">Inherit from this run</option>
                      {opDeliveryModes.map((m) => (
                        <option key={m} value={m}>
                          {m === "ON_CAMPUS" ? "On-Campus" : m === "ONLINE" ? "Online" : "Hybrid"}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  {(ogDraft.deliveryMode === "ON_CAMPUS" || ogDraft.deliveryMode === "HYBRID") && (
                    <FormField label="Campus override" helperText="Must be one of this run's own configured Campuses above.">
                      <Select value={ogDraft.campusId} onChange={(e) => setOgDraft({ ...ogDraft, campusId: e.target.value })}>
                        <option value="">Inherit from this run</option>
                        {opCampusIds.map((cid) => {
                          const c = (campuses || []).find((cc) => cc.id === cid);
                          return (
                            <option key={cid} value={cid}>
                              {c ? c.name : cid}
                            </option>
                          );
                        })}
                      </Select>
                    </FormField>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button variant="primary" size="sm" loading={ogSaving} onClick={saveOperationalGroupDraft}>
                      {ogDraft.id ? "Save changes" : "Create group"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={cancelOperationalGroupDraft}>
                      Cancel
                    </Button>
                  </div>
                  {ogError && <Alert variant="danger">{ogError}</Alert>}
                </div>
              ) : (
                <div>
                  <Button variant="secondary" size="sm" onClick={startAddOperationalGroup}>
                    + Add Operational Group
                  </Button>
                </div>
              )}
            </div>
          </FormField>
        )}

        {isEdit && !isBootcampOffering && (
          <FormField
            label="Academic Structure"
            helperText={
              existingInstance.status === "upcoming"
                ? "Splits this run into Semester (2) or Term (3) periods — locked once the run is Activated."
                : "Locked — this run has left \"Upcoming\", so its academic structure can no longer be changed."
            }
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {existingInstance.status === "upcoming" && !academicPeriods.length ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Select value={structureChoice} onChange={(e) => setStructureChoice(e.target.value)} style={{ maxWidth: 240 }}>
                    {Object.entries(STRUCTURE_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                  <Button variant="secondary" size="sm" loading={structureBusy} disabled={structureChoice === "none"} onClick={handleSaveStructure}>
                    Set structure
                  </Button>
                </div>
              ) : (
                <Badge tone="neutral">{STRUCTURE_LABEL[existingInstance.academicStructure || "none"]}</Badge>
              )}
              {structureError && <Alert variant="danger">{structureError}</Alert>}
            </div>
          </FormField>
        )}

        {isEdit && !isBootcampOffering && academicPeriods.length > 0 && (
          <FormField
            label="Academic Periods"
            helperText="For each period: which of this run's Programmes/Courses are active, and whether full payment or a deposit is required before learners get access. Leaving a period's targets unchecked (or its payment mode as 'None') means it isn't gated yet — the same as before this run had a structure."
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {academicPeriods.map((period, periodIdx) => {
                const draft = periodPaymentDrafts[period.id] || { mode: "", requiredAmountGHS: "" };
                const selected = periodTargetSelections[period.id] || [];
                const termDraft = periodTermDrafts[period.id] || { name: period.name || "", academicTermId: period.academicTermId || "", startDate: period.startDate || "", endDate: period.endDate || "" };
                // Combined Registration + First Period Payment: the first
                // academic period (sequence 1, or list position 0 as a
                // fallback for periods still missing that field) has its
                // payment requirement inherited from the Registration Fee
                // whenever combine is on — it must render read-only here,
                // never as an independently editable amount, so admins
                // can't create the two-competing-definitions state the
                // backend now rejects anyway.
                const isFirstPeriod = (period.sequence != null ? period.sequence === 1 : periodIdx === 0);
                const isInheritedPeriod = opCombineRegistrationWithFirstPeriod && isFirstPeriod;
                const inheritedAmount = opRegistrationFeeGHS === "" ? null : Number(opRegistrationFeeGHS);
                return (
                  <div key={period.id} style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <b>{period.name}</b>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {period.academicTermId ? (
                          <Badge tone="neutral">{period.academicTermName || academicTermLabel(period.academicTermId)}</Badge>
                        ) : (
                          <Badge tone="danger">No Academic Term linked</Badge>
                        )}
                        {isInheritedPeriod ? (
                          <Badge tone="warning">Full payment: GHS {inheritedAmount != null ? inheritedAmount : "—"} (inherited)</Badge>
                        ) : (
                          period.paymentMode && (
                            <Badge tone="warning">
                              {period.paymentMode === "full" ? "Full payment" : "Deposit"}: GHS {period.requiredAmountGHS}
                            </Badge>
                          )
                        )}
                      </div>
                    </div>

                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-muted, #6b7280)", marginBottom: 4 }}>
                        Academic Term (Institution Academic Calendar) — required
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <Input
                          placeholder="Period name"
                          value={termDraft.name}
                          onChange={(e) => setPeriodTermDrafts((prev) => ({ ...prev, [period.id]: { ...termDraft, name: e.target.value } }))}
                          style={{ maxWidth: 180 }}
                        />
                        <Select
                          value={termDraft.academicTermId}
                          onChange={(e) => setPeriodTermDrafts((prev) => ({ ...prev, [period.id]: { ...termDraft, academicTermId: e.target.value } }))}
                          style={{ minWidth: 220 }}
                        >
                          <option value="">Select an Academic Term…</option>
                          {academicYears.map((year) => (
                            <optgroup key={year.id} label={year.name}>
                              {academicTermsList
                                .filter((t) => t.academic_year_id === year.id)
                                .map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name}
                                  </option>
                                ))}
                            </optgroup>
                          ))}
                        </Select>
                        <Input
                          type="date"
                          value={termDraft.startDate}
                          onChange={(e) => setPeriodTermDrafts((prev) => ({ ...prev, [period.id]: { ...termDraft, startDate: e.target.value } }))}
                          style={{ maxWidth: 150 }}
                        />
                        <Input
                          type="date"
                          value={termDraft.endDate}
                          onChange={(e) => setPeriodTermDrafts((prev) => ({ ...prev, [period.id]: { ...termDraft, endDate: e.target.value } }))}
                          style={{ maxWidth: 150 }}
                        />
                        <Button variant="ghost" size="sm" loading={!!periodTermBusy[period.id]} onClick={() => handleSaveAcademicPeriodTerm(period.id)}>
                          Save
                        </Button>
                      </div>
                      {academicCalendarError && <Alert variant="danger">{academicCalendarError}</Alert>}
                      {periodTermError[period.id] && <Alert variant="danger">{periodTermError[period.id]}</Alert>}
                    </div>

                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-muted, #6b7280)", marginBottom: 4 }}>Active targets for this period</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {targets.map((t) => (
                          <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                            <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggleTargetForPeriod(period.id, t.id)} />
                            {t.programmeId ? `Programme: ${t.programmeName || "—"}` : `Course: ${t.courseTitle || "—"}`}
                          </label>
                        ))}
                      </div>
                      <Button variant="ghost" size="sm" loading={!!periodBusy[period.id]} onClick={() => handleSavePeriodTargets(period.id)} style={{ marginTop: 6 }}>
                        Save targets
                      </Button>
                    </div>

                    <div>
                      <div style={{ fontSize: 13, color: "var(--text-muted, #6b7280)", marginBottom: 4 }}>Payment requirement</div>
                      {isInheritedPeriod ? (
                        <div style={{ fontSize: 14, color: "var(--text-muted, #6b7280)" }}>
                          Inherited from Registration Fee: <b>GHS {inheritedAmount != null ? inheritedAmount : "—"}</b>. Turn off "Combine registration with the
                          first period's payment" above, or edit the Registration Fee, to change this.
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <Select
                            value={draft.mode}
                            onChange={(e) => setPeriodPaymentDrafts((prev) => ({ ...prev, [period.id]: { ...draft, mode: e.target.value } }))}
                            style={{ maxWidth: 180 }}
                          >
                            <option value="">None (no requirement)</option>
                            <option value="full">Full payment required</option>
                            <option value="deposit">Deposit / installment</option>
                          </Select>
                          {draft.mode && (
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="Amount (GHS)"
                              value={draft.requiredAmountGHS}
                              onChange={(e) => setPeriodPaymentDrafts((prev) => ({ ...prev, [period.id]: { ...draft, requiredAmountGHS: e.target.value } }))}
                              style={{ maxWidth: 140 }}
                            />
                          )}
                          <Button variant="ghost" size="sm" loading={!!periodBusy[period.id]} onClick={() => handleSavePeriodPayment(period.id)}>
                            Save requirement
                          </Button>
                        </div>
                      )}
                    </div>

                    {periodError[period.id] && <Alert variant="danger">{periodError[period.id]}</Alert>}
                  </div>
                );
              })}
            </div>
          </FormField>
        )}

        {isEdit && (
          <FormField label="Status">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <Badge tone={LI_STATUS_TONE[existingInstance.status]}>{LI_STATUS_LABEL[existingInstance.status] || existingInstance.status}</Badge>
              </div>
              {nextTransitions.length ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {nextTransitions.map((target) => (
                    <Button key={target} variant="ghost" size="sm" loading={transitionBusy} onClick={() => handleTransition(target)}>
                      {LI_ACTION_LABEL[target]}
                    </Button>
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--text-muted, #6b7280)", margin: 0 }}>No further status changes — this is a terminal status.</p>
              )}
            </div>
          </FormField>
        )}

        {formError && <Alert variant="danger">{formError}</Alert>}
      </div>
    </Modal>
  );
}
