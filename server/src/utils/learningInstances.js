// ============================================================
// Learning Instance — service / validation layer
// ============================================================
// A Learning Instance is one concrete "run" of a Programme or a Module
// (see server/src/db/migrate.js for the table itself and the full
// rationale). This file is the single place that knows how to validate,
// read, and mutate that table — routes/learningInstances.js (the HTTP
// layer) calls into it, and it's exported specifically so future work
// (enrolments, payments, attendance, assessments, results, certificates,
// transcripts, dashboards, reports, registration, instructor assignment —
// per the task) can depend on a stable interface here instead of querying
// `learning_instances` directly. Nothing outside this file and
// routes/learningInstances.js touches that table yet.

const db = require("../db/db");
const { v4: uuid } = require("uuid");

// Small, tolerant JSON-array parser for the v31 operational-config columns
// (delivery_modes/campus_ids) — never throws on NULL/malformed data, since
// every existing row predates this feature and stores NULL.
function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const LEARNING_INSTANCE_STATUSES = ["upcoming", "active", "completed", "archived", "cancelled"];

// Builders' Lab participation structures (v29) — see migrate.js for the
// full rationale. Nullable everywhere it's stored: NULL means
// "unspecified/legacy", never a guessed value.
const PARTICIPATION_STRUCTURES = ["structured_school_club", "structured_other", "individual_course"];
function isValidParticipationStructure(value) {
  return value == null || PARTICIPATION_STRUCTURES.includes(value);
}

// Scoped legacy-enum validity check, for callers that haven't (or can't
// yet) opt an offering type into participationStructuresV2Enabled/full
// Programme-owned config. `individual_course` is, in every real Run this
// codebase actually has, a Kids STEM / Builders' Lab-only concept — the
// same signal offeringTypeRequiresCourseSelectionAtRegistration() already
// uses to identify "this offering type's classic flow works the
// Individual-Course way" (today: only kids_stem). Any other offering type
// (Adult Professional, Corporate Training) never legitimately had
// Individual Course as an option, so this rejects it for them while
// leaving structured_school_club/structured_other available exactly as
// before — this only narrows the one value the investigation found
// leaking, not the whole legacy enum.
//
// Bootcamp bug fix (BOOTCAMP — INDIVIDUAL COURSE SAVE ERROR /
// BOOTCAMP — INVALID STRUCTURE ALLOWED): Bootcamp does not use
// Participation Structures at all — its model is Learning Instance ->
// Operational Group (Cohort) -> Batch/Cohort -> Campus -> Registration
// Fee (see server/src/db/migrate.js's bootcamp settings seed and
// usesRunScopedCourseCurriculum below). None of the three legacy
// Participation Structure enum values (structured_school_club,
// structured_other, individual_course — every one of them a Kids STEM /
// Builders' Lab concept) is ever valid for Bootcamp, so a Bootcamp
// Learning Instance/registration must only ever submit
// participationStructure: null. This is checked by offering-type slug
// (rather than folded into the Run-scoped-curriculum set the rest of
// this file uses for Bootcamp/Adult Professional/Corporate Training)
// specifically so Adult Professional and Corporate Training's existing
// behaviour is completely unaffected — only Bootcamp is scoped out here.
function isParticipationStructureAllowedForOfferingType(offeringType, value) {
  if (value == null) return true;
  if (!PARTICIPATION_STRUCTURES.includes(value)) return false;
  if (offeringType && offeringType.slug === "bootcamp") return false;
  if (value !== "individual_course") return true;
  const { offeringTypeRequiresCourseSelectionAtRegistration } = require("./offeringTypeSettings");
  return offeringTypeRequiresCourseSelectionAtRegistration(offeringType);
}

// ============================================================
// ABRS v2.1 Phase 5 prerequisite — Programme-owned Participation Structure
// configuration (§10, Appendix A-1), read/written alongside the legacy
// enum column above rather than instead of it. `isValidParticipationStructure`
// and the PARTICIPATION_STRUCTURES constant above remain exactly as they
// were — they're still what every caller falls back to when
// offeringTypeUsesParticipationStructuresV2() is false (the default),
// which keeps every existing behaviour byte-for-byte unless an offering
// type explicitly opts in. These functions are the opt-in path.
// ============================================================

function toParticipationStructureDto(row) {
  return {
    id: row.id,
    programmeId: row.programme_id,
    key: row.key,
    name: row.name,
    usesProgrammeLevels: !!row.uses_programme_levels,
    usesPromotion: !!row.uses_promotion,
    requiresCourseSelection: !!row.requires_course_selection,
    registrantRole: row.registrant_role,
    usesLongTermEnrollment: !!row.uses_long_term_enrollment,
    autoAssignsEntryLevel: !!row.auto_assigns_entry_level,
  };
}

// Every active Participation Structure a Programme has defined for itself
// (§10.2), read from programme_participation_structures — the single
// place this query is written (routes/learningOfferings.js's public
// GET /programmes/:id/participation-structures reads through this same
// function rather than keeping its own copy of the SQL).
function getProgrammeParticipationStructures(programmeId) {
  if (!programmeId) return [];
  const rows = db
    .prepare(
      `SELECT * FROM programme_participation_structures
       WHERE programme_id = ? AND is_active = 1 ORDER BY sort_order ASC, name ASC`
    )
    .all(programmeId);
  return rows.map(toParticipationStructureDto);
}

// Resolves a single active Participation Structure config row for a
// Programme + key, or null if that Programme has no active structure with
// that key defined. Never guesses/falls back to another Programme's
// config — a key is only ever meaningful scoped to the Programme that
// owns it (§10.1).
function resolveParticipationStructureConfig(programmeId, key) {
  if (!programmeId || !key) return null;
  return getProgrammeParticipationStructures(programmeId).find((s) => s.key === key) || null;
}

// Read-only variant of getProgrammeParticipationStructures for the
// registration experience (§10.2, §2.2): a Programme's own admin-defined
// Participation Structures when it has any, else — WITHOUT writing
// anything — the same three legacy structures synthesized from
// utils/participationStructureMetadata.js, so a Programme that predates
// the Phase 2 admin-CRUD tooling still offers its full, correct menu.
// Deliberately does NOT call ensureProgrammeParticipationStructure (which
// dual-writes a row): this is read by the public, unauthenticated
// registration-config endpoint, and a GET must never have a side effect.
// Once a Programme gets its own admin-managed rows, those become
// authoritative immediately (Single Ownership Principle, §2.1) and this
// fallback stops being consulted for that Programme.
function getEffectiveProgrammeParticipationStructures(programmeId) {
  const { getOfferingTypeForProgramme } = require("./offeringTypeSettings");
  const offeringType = getOfferingTypeForProgramme(programmeId);
  // Bootcamp does not use Participation Structures at all (see
  // isParticipationStructureAllowedForOfferingType's Bootcamp comment
  // above) — checked ahead of the configured-rows read below so a stale
  // programme_participation_structures row from before this rule existed
  // can never leak Kids STEM's structures into a Bootcamp Programme's
  // registration-config menu either.
  if (offeringType && offeringType.slug === "bootcamp") return [];
  const configured = getProgrammeParticipationStructures(programmeId);
  if (configured.length) return configured;
  const { PARTICIPATION_STRUCTURE_METADATA } = require("./participationStructureMetadata");
  // Scoped fallback: an unconfigured Programme still sees
  // structured_school_club/structured_other (unchanged, historical
  // behaviour), but individual_course is only synthesized for offering
  // types that legitimately use it (today: Kids STEM) — never merely
  // because a Programme happens to have no
  // programme_participation_structures rows yet. Delegates entirely to
  // isParticipationStructureAllowedForOfferingType so this menu can never
  // disagree with what the write-side validation (routes/learningInstances.js,
  // routes/auth.js) actually accepts for this offering type.
  return Object.entries(PARTICIPATION_STRUCTURE_METADATA)
    .filter(([key]) => isParticipationStructureAllowedForOfferingType(offeringType, key))
    .map(([key, meta]) => ({
      id: null,
      programmeId,
      key,
      name: meta.name,
      usesProgrammeLevels: !!meta.usesProgrammeLevels,
      usesPromotion: !!meta.usesPromotion,
      requiresCourseSelection: !!meta.requiresCourseSelection,
      registrantRole: meta.registrantRole,
      usesLongTermEnrollment: !!meta.usesLongTermEnrollment,
      autoAssignsEntryLevel: !!meta.autoAssignsEntryLevel,
    }))
    .sort((a, b) => (PARTICIPATION_STRUCTURE_METADATA[a.key].sortOrder || 0) - (PARTICIPATION_STRUCTURE_METADATA[b.key].sortOrder || 0));
}

// The Programme Level (Class) a newly-registered structured learner would
// be auto-assigned into for this Programme — the lowest sort_order Class,
// exactly what routes/auth.js's resolveEntryClass resolves at actual
// registration time. Read-only/informational: lets the registration
// experience say "you'll begin at Foundation" up front without letting the
// parent choose (§11.2 — "Parents never choose a Programme Level").
function resolveEntryLevelForProgramme(programmeId) {
  if (!programmeId) return null;
  const row = db.prepare("SELECT id, name FROM classes WHERE programme_id = ? ORDER BY sort_order ASC, name ASC LIMIT 1").get(programmeId);
  return row ? { classId: row.id, className: row.name } : null;
}

// Dual-write helper (same posture as ensureActivatedCourse above): ensures
// a Programme has a programme_participation_structures row for a given
// key, auto-creating it from the known legacy metadata
// (utils/participationStructureMetadata.js) the first time that
// Programme actually uses that key, if it doesn't already have one.
// Returns the (possibly newly-created) config DTO, or null if the key
// isn't one of the three known legacy keys and the Programme has no
// admin-defined config row for it either — this function never invents
// metadata for an unrecognized key, matching every other "never guess"
// backfill/dual-write in this codebase.
function ensureProgrammeParticipationStructure(programmeId, key) {
  if (!programmeId || !key) return null;
  const existing = db
    .prepare("SELECT * FROM programme_participation_structures WHERE programme_id = ? AND key = ?")
    .get(programmeId, key);
  if (existing) return toParticipationStructureDto(existing);

  const { PARTICIPATION_STRUCTURE_METADATA } = require("./participationStructureMetadata");
  const meta = PARTICIPATION_STRUCTURE_METADATA[key];
  if (!meta) return null;

  const id = uuid();
  db.prepare(
    `INSERT INTO programme_participation_structures
       (id, programme_id, key, name, uses_programme_levels, uses_promotion, requires_course_selection, registrant_role, uses_long_term_enrollment, auto_assigns_entry_level, sort_order)
     VALUES (@id, @programmeId, @key, @name, @usesProgrammeLevels, @usesPromotion, @requiresCourseSelection, @registrantRole, @usesLongTermEnrollment, @autoAssignsEntryLevel, @sortOrder)`
  ).run({
    id,
    programmeId,
    key,
    name: meta.name,
    usesProgrammeLevels: meta.usesProgrammeLevels ? 1 : 0,
    usesPromotion: meta.usesPromotion ? 1 : 0,
    requiresCourseSelection: meta.requiresCourseSelection ? 1 : 0,
    registrantRole: meta.registrantRole,
    usesLongTermEnrollment: meta.usesLongTermEnrollment ? 1 : 0,
    autoAssignsEntryLevel: meta.autoAssignsEntryLevel ? 1 : 0,
    sortOrder: meta.sortOrder,
  });
  return resolveParticipationStructureConfig(programmeId, key);
}

// Run-level dual-write (unconditional — not behind the flag, same
// rationale as Checkpoint 3a's ensureActivatedCourse): whenever a
// Programme Run's participation_structure enum column is set,
// also ensure the §10.1 "activation" join row exists linking that Run to
// its Programme's config row for that key, auto-creating the config row
// first via ensureProgrammeParticipationStructure if needed. No-op if the
// Run has no programmeId, no key, or the key isn't recognizable.
function ensureLearningInstanceParticipationStructureActivation(learningInstanceId, programmeId, key) {
  if (!learningInstanceId || !programmeId || !key) return;
  const config = ensureProgrammeParticipationStructure(programmeId, key);
  if (!config) return;
  db.prepare(
    "INSERT OR IGNORE INTO learning_instance_participation_structures (id, learning_instance_id, participation_structure_id) VALUES (?, ?, ?)"
  ).run(uuid(), learningInstanceId, config.id);
}

// Phase 4 — Academic Structure per Learning Instance. Exactly one of these
// two structures may be configured per run; the number is the exact count
// of academic_periods a structure of that type always has (never more,
// never fewer — see setAcademicStructure below).
const ACADEMIC_STRUCTURE_PERIOD_COUNTS = { semester: 2, term: 3 };
const ACADEMIC_STRUCTURES = Object.keys(ACADEMIC_STRUCTURE_PERIOD_COUNTS);

function isValidAcademicStructure(structure) {
  return ACADEMIC_STRUCTURES.includes(structure);
}

// The state machine a Learning Instance's status may move through. Each
// dedicated action endpoint (activate/complete/archive/cancel) checks the
// current status against this map before writing the new one, so a run can
// never jump into a nonsensical state (e.g. "archived" straight back to
// "active", or "upcoming" straight to "completed"). `archived` is terminal
// by design — per the task's verb list there's no "unarchive" action; if an
// archived run genuinely needs to resume, that's a new Learning Instance.
const ALLOWED_TRANSITIONS = {
  upcoming: ["active", "cancelled"],
  active: ["completed", "cancelled"],
  completed: ["archived"],
  cancelled: ["archived"],
  archived: [],
};

function isValidStatus(status) {
  return LEARNING_INSTANCE_STATUSES.includes(status);
}

// Every read goes through this SELECT so the row->DTO shape (names resolved
// via joins, not just raw ids) is consistent everywhere, including for
// whatever later feature ends up importing getLearningInstanceById/list.
const LEARNING_INSTANCE_SELECT = `
  SELECT li.*,
         t.name AS offering_type_name, t.slug AS offering_type_slug,
         p.name AS programme_name,
         m.title AS course_title,
         ins.name AS instructor_name
  FROM learning_instances li
  JOIN learning_offering_types t ON t.id = li.offering_type_id
  LEFT JOIN programmes p ON p.id = li.programme_id
  LEFT JOIN courses m ON m.id = li.course_id
  LEFT JOIN users ins ON ins.id = li.instructor_id
`;

// Every target row (primary + secondary) attached to a Learning Instance,
// resolved with display names the same way LEARNING_INSTANCE_SELECT does
// for the primary programme_id/course_id. Ordered primary-first so a
// consumer that only wants "the" target (legacy single-target callers)
// can just take targets[0].
const LEARNING_INSTANCE_TARGET_SELECT = `
  SELECT lit.*, p.name AS programme_name, m.title AS course_title
  FROM learning_instance_targets lit
  LEFT JOIN programmes p ON p.id = lit.programme_id
  LEFT JOIN courses m ON m.id = lit.course_id
  WHERE lit.learning_instance_id = ?
  ORDER BY lit.is_primary DESC, lit.created_at ASC
`;

function toTargetDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    learningInstanceId: row.learning_instance_id,
    targetType: row.target_type,
    programmeId: row.programme_id || null,
    programmeName: row.programme_name || null,
    courseId: row.course_id || null,
    courseTitle: row.course_title || null,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at,
  };
}

// All targets (primary + secondary) for one Learning Instance, as DTOs.
function getInstanceTargets(instanceId) {
  if (!instanceId) return [];
  return db.prepare(LEARNING_INSTANCE_TARGET_SELECT).all(instanceId).map(toTargetDto);
}

// Phase 4 — every academic-period row (Semester 1/2 or Term 1/2/3) that
// belongs to one Learning Instance, ordered by sequence.
const ACADEMIC_PERIOD_SELECT = `
  SELECT lap.*, at.name AS academic_term_name
  FROM learning_instance_academic_periods lap
  LEFT JOIN academic_terms at ON at.id = lap.academic_term_id
  WHERE lap.learning_instance_id = ?
  ORDER BY lap.sequence ASC
`;

function toAcademicPeriodDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    learningInstanceId: row.learning_instance_id,
    sequence: row.sequence,
    name: row.name,
    academicTermId: row.academic_term_id || null,
    academicTermName: row.academic_term_name || null,
    startDate: row.start_date || null,
    endDate: row.end_date || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Phase 5 — which of this run's targets apply to THIS period
    // specifically (never assumed to be all of them, or the same as any
    // other period — see setPeriodTargets).
    targets: getPeriodTargets(row.id),
    // Phase 6 — this period's payment requirement, if an admin has
    // configured one. NULL/null = no requirement configured, which means
    // access is never gated on payment for this period (see
    // setPeriodPaymentRequirement / getPeriodPaymentStatus in
    // utils/periodPayments.js).
    paymentMode: row.payment_mode || null,
    requiredAmountGHS: row.required_amount_ghs != null ? row.required_amount_ghs : null,
  };
}

function getAcademicPeriods(instanceId) {
  if (!instanceId) return [];
  return db.prepare(ACADEMIC_PERIOD_SELECT).all(instanceId).map(toAcademicPeriodDto);
}

// A single academic period by id, scoped to a specific Learning Instance
// (so a periodId can never be used to reach a different run's period) — as
// a DTO, same shape as one entry of getAcademicPeriods.
function getAcademicPeriodById(instanceId, periodId) {
  if (!instanceId || !periodId) return null;
  const row = db
    .prepare(
      `SELECT lap.*, at.name AS academic_term_name
       FROM learning_instance_academic_periods lap
       LEFT JOIN academic_terms at ON at.id = lap.academic_term_id
       WHERE lap.id = ? AND lap.learning_instance_id = ?`
    )
    .get(periodId, instanceId);
  return toAcademicPeriodDto(row);
}

// Admin Workflow Redesign (post-ABRS v2.1 Phase 5 prerequisites) — this
// Run's completion status against the ABRS §15 canonical ordering, from
// "Activate Participation Structures" onward (the steps a Programme Run
// itself owns per §7.2/§16; the earlier, Programme-scoped steps — Course
// Library, Participation Structure/Level *definitions* — are evaluated
// separately, client-side, from data the admin UI already has, since they
// aren't Run-scoped facts this DTO is the right owner of).
//
// This is presentation/workflow-guidance only: it reads existing DTO
// fields and computes derived booleans, adding no new columns, no new
// tables, and no new business entity. Every "complete" check reads a
// fact this document (Section 16) already names a Programme Run as the
// sole owner of — this function never invents a new one.
const LEARNING_INSTANCE_WORKFLOW_STEPS = [
  {
    id: "participationStructure",
    label: "Activate Participation Structures",
    check: (dto) => !!dto.participationStructure,
  },
  {
    id: "activatedCourses",
    label: "Activate Courses",
    check: (dto) => Array.isArray(dto.activatedCourses) && dto.activatedCourses.length > 0,
  },
  {
    id: "registration",
    label: "Configure Registration",
    check: (dto) => !!dto.registrationWindowConfigured,
  },
  {
    id: "delivery",
    label: "Configure Delivery",
    check: (dto) => Array.isArray(dto.deliveryModes) && dto.deliveryModes.length > 0,
  },
  {
    id: "campuses",
    label: "Configure Campuses",
    // Not applicable to a Run delivered entirely online — a campus-less
    // delivery mode set is a legitimate configuration, not a missing one.
    // Compared case-insensitively: routes/learningInstances.js's
    // OPERATIONAL_DELIVERY_MODES (and every value actually persisted via
    // PATCH /:id/operational-config) is uppercase ("ONLINE"), not the
    // lowercase "online" this used to compare against — which meant this
    // check could never match real data and Campuses stayed permanently
    // "applicable" (and therefore permanently incomplete, since an
    // online-only Run legitimately has no campusIds) for every Run ever
    // configured through the real save flow.
    applicable: (dto) =>
      !(
        Array.isArray(dto.deliveryModes) &&
        dto.deliveryModes.length > 0 &&
        dto.deliveryModes.every((m) => String(m).toUpperCase() === "ONLINE")
      ),
    check: (dto) => Array.isArray(dto.campusIds) && dto.campusIds.length > 0,
  },
  {
    id: "pricing",
    label: "Configure Pricing",
    // §15.2 — Base Tuition Fee and Registration Fee are two separate,
    // independently-meaningful fields on the Run; a Run's actual pricing
    // model may set either or both (a flat one-time-charge Run may only
    // ever set registrationFeeGHS and legitimately never set feeGHS).
    // Requiring feeGHS specifically made "Configure Pricing" permanently
    // unsatisfiable for any Run priced that way, no matter what an admin
    // configured. Complete once EITHER has an explicit, persisted value.
    check: (dto) => dto.feeGHS != null || dto.registrationFeeGHS != null,
  },
  {
    id: "academicCalendar",
    label: "Configure Academic Calendar",
    check: (dto) => !!dto.academicStructure,
  },
  {
    id: "academicPeriods",
    label: "Configure Academic Periods",
    // Only meaningful once an Academic Calendar structure has been
    // chosen — periods can't be dated before a structure exists to
    // generate them (Section 11.1: Academic Period and Academic
    // Calendar/structure are distinct concepts).
    applicable: (dto) => !!dto.academicStructure,
    check: (dto) => {
      const expected = ACADEMIC_STRUCTURE_PERIOD_COUNTS[dto.academicStructure];
      return (
        Array.isArray(dto.academicPeriods) &&
        (!expected || dto.academicPeriods.length === expected) &&
        dto.academicPeriods.every((p) => p.startDate && p.endDate)
      );
    },
  },
  {
    id: "instructors",
    label: "Assign Instructors",
    // ABRS v2.2 §8.2 — Instructor Assignment's sole constitutional owner
    // is `instructor_assignments` (server/src/db/migrate.js's v40
    // consolidation: "every authorization check reads
    // instructor_assignments exclusively — those columns are never
    // consulted for access control again"). This step used to check
    // `dto.instructorId` (the Run's own single "lead instructor" display
    // field, learning_instances.instructor_id) and each Activated
    // Course's own instructorId — neither of which Manage Accounts'
    // Instructor Assignment screen (routes/users.js's PUT
    // /:userId/assignments) has ever written to. An admin could fully
    // assign an instructor to this Run through the constitutional flow
    // and this step would still report incomplete, because it was
    // reading two fields that flow never touches. dto.assignedInstructors
    // (below) is sourced directly from instructor_assignments, so this
    // check is now answering the same question the rest of the codebase
    // already answers everywhere else: does this Run have at least one
    // instructor_assignments row.
    check: (dto) => Array.isArray(dto.assignedInstructors) && dto.assignedInstructors.length > 0,
  },
];

// ABRS v2.2 §8.2 — every instructor_assignments row for one Programme
// Run, enriched with display names, for both the "instructors" workflow
// step above and the Learning Instance edit modal's Instructor section
// (which — before this fix — only ever showed the Run's own single
// instructor_id "lead instructor" field and had no way to show what
// Manage Accounts' Instructor Assignment screen had actually granted).
function getAssignedInstructorsForInstance(learningInstanceId) {
  if (!learningInstanceId) return [];
  return db
    .prepare(
      `SELECT ia.id, ia.instructor_id as instructorId, u.name as instructorName,
              ia.course_id as courseId, c.title as courseTitle,
              ia.class_id as classId, cl.name as className,
              ia.campus_id as campusId, cp.name as campusName
       FROM instructor_assignments ia
       JOIN users u ON u.id = ia.instructor_id
       LEFT JOIN courses c ON c.id = ia.course_id
       LEFT JOIN classes cl ON cl.id = ia.class_id
       LEFT JOIN campuses cp ON cp.id = ia.campus_id
       WHERE ia.learning_instance_id = ?
       ORDER BY u.name ASC`
    )
    .all(learningInstanceId);
}

function computeLearningInstanceWorkflowStatus(dto) {
  const steps = LEARNING_INSTANCE_WORKFLOW_STEPS.map((step) => {
    const applicable = step.applicable ? !!step.applicable(dto) : true;
    const complete = applicable ? !!step.check(dto) : true;
    return { id: step.id, label: step.label, applicable, complete };
  });
  const missingSteps = steps.filter((s) => s.applicable && !s.complete).map((s) => s.label);
  return { steps, readyToPublish: missingSteps.length === 0, missingSteps };
}

function toLearningInstanceDto(row) {
  if (!row) return null;
  const dto = {
    id: row.id,
    offeringTypeId: row.offering_type_id,
    offeringTypeName: row.offering_type_name,
    offeringTypeSlug: row.offering_type_slug,
    // Primary target — kept for every existing consumer that only ever
    // knew about a single programme/module per run. Untouched by the
    // multi-target model.
    programmeId: row.programme_id || null,
    programmeName: row.programme_name || null,
    courseId: row.course_id || null,
    courseTitle: row.course_title || null,
    name: row.name || null,
    startDate: row.start_date || null,
    endDate: row.end_date || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Full target list (primary + any additional Programmes/Modules this
    // run also serves). New consumers (registration catalogue, admin
    // multi-select UI) should read this instead of programmeId/courseId.
    targets: getInstanceTargets(row.id),
    // ABRS v2.1 Phase 5 prerequisite (Appendix A-2) — this Run's Activated
    // Course rows (§8/§9), for the admin UI that reviews/edits them before
    // any offering type opts into activatedCoursesV2Enabled. Empty array
    // (not null) for a Run with no Course targets yet or predating
    // Checkpoint 3a's dual-write, same "empty means genuinely none" as
    // targets above.
    activatedCourses: getActivatedCoursesForInstance(row.id),
    // Phase 4 — the run's academic structure (null until an admin
    // configures one) and, once configured, its exact set of academic
    // periods (2 for 'semester', 3 for 'term').
    academicStructure: row.academic_structure || null,
    academicPeriods: getAcademicPeriods(row.id),
    // Builders' Lab participation structure this run is configured for
    // (v29) — null on every run created before this feature, exactly
    // like academicStructure above.
    participationStructure: row.participation_structure || null,
    // v31 — Programme Run operational ownership. See
    // getInstanceOperationalConfig() below for the resolved/joined version
    // (campuses as {id,name}, installments merged with the Offering Type
    // default); these are the raw stored values.
    deliveryModes: parseJsonArray(row.delivery_modes),
    campusIds: parseJsonArray(row.campus_ids),
    feeGHS: row.fee_ghs != null ? row.fee_ghs : null,
    // §15.2 Registration Fee — the Run's own one-time charge, separate
    // from feeGHS (Tuition). See getInstanceOperationalConfig() below and
    // routes/learningInstances.js's PATCH /:id/operational-config.
    registrationFeeGHS: row.registration_fee_ghs != null ? row.registration_fee_ghs : null,
    // Combined Registration + First Period Payment — see migrate.js's
    // comment for the full rationale. false/0 (default) is today's
    // "separate" behaviour; true only changes anything once this Run
    // also has a resolvable first academic period AND a Registration Fee
    // configured — the Registration Fee then automatically becomes that
    // period's own payment requirement (resolveCombinedPeriodCharge
    // below), never the other way around.
    combineRegistrationWithFirstPeriod: !!row.combine_registration_with_first_period,
    installmentsEnabled: row.installments_enabled == null ? null : !!row.installments_enabled,
    capacity: row.capacity != null ? row.capacity : null,
    instructorId: row.instructor_id || null,
    instructorName: row.instructor_name || null,
    // v32 — Registration Window ownership. Raw stored values (null/0 =
    // "not configured at the Run level yet" — see
    // resolveProgrammeRegistrationOpen() for the fallback-to-Programme
    // resolution this feeds into) plus the resolved registrationOpen
    // boolean for this Run alone (ignoring the Programme fallback,
    // since a DTO for a specific instance should describe that instance).
    registrationOpensAt: row.registration_opens_at || null,
    registrationDeadline: row.registration_deadline || null,
    registrationForceClosed: !!row.registration_force_closed,
    registrationForceOpen: !!row.registration_force_open,
    registrationWindowConfigured: isInstanceRegistrationConfigured(row),
    registrationOpen: isInstanceRegistrationOpen(row),
    // ABRS v2.2 §8.2 — every instructor actually granted access to this
    // Run, sourced directly from instructor_assignments (the sole
    // constitutional owner of Instructor Assignment; see the "instructors"
    // workflow step above for why nothing else may be read for this).
    // NULL courseId/classId/campusId on a row means "every value of that
    // dimension in this Run" (utils/instructorScope.js's convention) —
    // surfaced here as null so the UI can render "Any"/"All", the same
    // convention it already renders for e.g. Operational Group overrides.
    assignedInstructors: getAssignedInstructorsForInstance(row.id),
  };
  // Attached last so every check above can read the already-built dto
  // fields (targets/activatedCourses/academicPeriods/etc.) without
  // duplicating any of the logic that produced them.
  dto.workflowStatus = computeLearningInstanceWorkflowStatus(dto);
  return dto;
}

function getLearningInstanceById(id) {
  if (!id) return null;
  const row = db.prepare(`${LEARNING_INSTANCE_SELECT} WHERE li.id = ?`).get(id);
  return toLearningInstanceDto(row);
}

// Phase 10 — self-service discovery for a learner/parent choosing which
// period-scoped transcript/payment status to view. There's no existing
// learner-facing catalog of Learning Instances (GET /api/learning-instances
// is permission-gated to staff), so this scans the tables that already
// carry learning_instance_id for THIS learner specifically — payments,
// their programme enrolments, and any certificates already issued to them
// — rather than exposing the full admin catalog. Only instances that have
// an academic structure configured (academicStructure != null) are
// returned, since a period selector is meaningless without one; every
// other Learning Instance the learner has records in continues to be
// covered by the existing default (non-period-scoped) transcript view.
function getLearnerLearningInstances(learnerId) {
  if (!learnerId) return [];
  const ids = new Set();
  db.prepare("SELECT DISTINCT learning_instance_id FROM payments WHERE user_id = ? AND learning_instance_id IS NOT NULL")
    .all(learnerId)
    .forEach((r) => ids.add(r.learning_instance_id));
  db.prepare("SELECT DISTINCT learning_instance_id FROM programme_enrollments WHERE user_id = ? AND learning_instance_id IS NOT NULL")
    .all(learnerId)
    .forEach((r) => ids.add(r.learning_instance_id));
  db.prepare("SELECT DISTINCT learning_instance_id FROM issued_certificates WHERE learner_id = ? AND learning_instance_id IS NOT NULL")
    .all(learnerId)
    .forEach((r) => ids.add(r.learning_instance_id));
  return [...ids]
    .map((id) => getLearningInstanceById(id))
    .filter((instance) => instance && instance.academicStructure);
}

// Resolves a Module's offering type the same way modules.js's own
// MODULE_SELECT_WITH_OFFERING_TYPE does (via its programme_id), with one
// addition: a module with no programme_id at all is a legacy/global
// Builders Lab module (see the "NULL programme_id = legacy/global Builders
// Lab module" comment in migrate.js) — by that same established
// convention, it's treated as belonging to the Kids STEM offering type
// rather than having no resolvable offering type.
function resolveCourseOfferingTypeId(moduleRow) {
  if (!moduleRow) return null;
  if (moduleRow.programme_id) {
    const programme = db.prepare("SELECT offering_type_id FROM programmes WHERE id = ?").get(moduleRow.programme_id);
    return programme ? programme.offering_type_id : null;
  }
  const kidsStem = db.prepare("SELECT id FROM learning_offering_types WHERE slug = 'kids_stem'").get();
  return kidsStem ? kidsStem.id : null;
}

// The core "never identify by name alone / must actually belong to the
// stated Learning Offering Type" check, resistant to bogus or mismatched
// ids being submitted. Returns a user-facing error string, or null if the
// association is valid.
function validateOfferingTypeAssociation({ offeringTypeId, programmeId, courseId }) {
  if (!offeringTypeId) return "offeringTypeId is required.";
  const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE id = ?").get(offeringTypeId);
  if (!offeringType) return "offeringTypeId does not match a known Learning Offering Type.";

  const hasProgramme = !!programmeId;
  const hasModule = !!courseId;
  if (hasProgramme === hasModule) {
    // Both true (both given) or both false (neither given) — either way,
    // this violates "exactly one of Programme/Module" (also enforced by
    // the learning_instances CHECK constraint; this catches it earlier
    // with a clear message instead of a raw SQLite error).
    return "Provide exactly one of programmeId or courseId — a Learning Instance is one run of either a Programme or a Module, not both and not neither.";
  }

  if (hasProgramme) {
    const programme = db.prepare("SELECT id, offering_type_id FROM programmes WHERE id = ?").get(programmeId);
    if (!programme) return "programmeId does not match a known Programme.";
    if (programme.offering_type_id !== offeringTypeId) {
      return "This Programme belongs to a different Learning Offering Type than the one selected.";
    }
  }

  if (hasModule) {
    const moduleRow = db.prepare("SELECT id, programme_id FROM courses WHERE id = ?").get(courseId);
    if (!moduleRow) return "courseId does not match a known Module.";
    const resolvedOfferingTypeId = resolveCourseOfferingTypeId(moduleRow);
    if (!resolvedOfferingTypeId) {
      return "This Module isn't associated with any Learning Offering Type yet — assign it to a Programme first.";
    }
    if (resolvedOfferingTypeId !== offeringTypeId) {
      return "This Module belongs to a different Learning Offering Type than the one selected.";
    }
  }

  return null;
}

// Business rule: at most one Active Learning Instance may claim a given
// Programme/Module, across ALL of that instance's targets — not just its
// primary one. Returns the conflicting learning_instances row (raw, not a
// DTO) or null. Checks a single {programmeId, courseId} pair (the legacy
// single-target call shape, still used by create/PATCH for the primary
// target) — see findActiveInstanceConflictForTargets below for the
// multi-target form used when adding a secondary target or activating a
// run that already has several.
//
// Also enforced at the DB level by the idx_lit_one_active_per_programme /
// _module partial unique indexes in migrate.js (which cover every target
// row, primary or secondary) — this check exists to turn that into a
// clean 409 with a helpful message instead of a raw SQLite constraint
// error.
function findActiveInstanceConflict({ programmeId, courseId }, excludeId) {
  const column = programmeId ? "programme_id" : "course_id";
  const value = programmeId || courseId;
  if (!value) return null;
  let sql = `
    SELECT li.* FROM learning_instances li
    JOIN learning_instance_targets lit ON lit.learning_instance_id = li.id
    WHERE li.status = 'active' AND lit.${column} = ?
  `;
  const params = [value];
  if (excludeId) {
    sql += " AND li.id != ?";
    params.push(excludeId);
  }
  return db.prepare(sql).get(...params) || null;
}

// Multi-target form: given an instance id, check whether ANY of its
// current targets (primary + secondary) is already claimed by a
// *different* Active Learning Instance. Used before activating an
// instance that may have several targets attached. Returns the
// conflicting learning_instances row, or null.
function findActiveInstanceConflictForTargets(instanceId) {
  const targets = getInstanceTargets(instanceId);
  for (const t of targets) {
    const conflict = findActiveInstanceConflict(
      { programmeId: t.programmeId, courseId: t.courseId },
      instanceId
    );
    if (conflict) return conflict;
  }
  return null;
}

// Keeps learning_instance_targets.instance_status in sync with the parent
// learning_instances.status — must be called (in the same write path)
// every time a run's status changes, since the DB-level "one Active run
// per target" backstop is enforced against this denormalized column, not
// against learning_instances.status directly.
function syncTargetStatuses(instanceId, status) {
  db.prepare("UPDATE learning_instance_targets SET instance_status = ? WHERE learning_instance_id = ?").run(status, instanceId);
}

// Adds a secondary target (exactly one of programmeId/courseId) to an
// existing Learning Instance. Validates the target belongs to the same
// Learning Offering Type as the instance, isn't already attached to this
// instance, and — if the instance is currently Active — doesn't conflict
// with some other Active instance's targets. Returns { error } or
// { target }.
// ABRS v2.1 Phase 3 Checkpoint 3a — dual-write only (Appendix A-2/A-4; see
// migrate.js's v35 comment for the full rationale). Both helpers are
// additive: they never touch the legacy tables/columns callers already
// read, and both are safe to call unconditionally (no feature flag check)
// because nothing reads what they write yet — Checkpoint 3b is what wires
// a flag-gated read path up to this data. Keeping the write unconditional
// now means the tables have real, trustworthy history to read from by the
// time 3b lands, instead of only whatever gets written after some future
// flag flip.

// Ensures a Programme Run has an Activated Course row (§8) for a Course it
// targets. Idempotent (INSERT OR IGNORE against the UNIQUE(learning_instance_id,
// course_id) index) — safe to call every time a Run<->Course association is
// created, never only once. Defaults to Active/Optional/not-Hidden/order 0,
// matching "just targeted, not yet specifically configured" — an admin can
// adjust those in Checkpoint 3b's admin UI once the read side exists.
function ensureActivatedCourse(learningInstanceId, courseId) {
  if (!learningInstanceId || !courseId) return;
  db.prepare(
    "INSERT OR IGNORE INTO learning_instance_courses (id, learning_instance_id, course_id) VALUES (?, ?, ?)"
  ).run(uuid(), learningInstanceId, courseId);
}

// Normalizes an Individual Course enrolment's selected Courses (§10.2) into
// programme_enrollment_courses (Appendix A-4), alongside the legacy JSON
// array this same call site also still writes to
// programme_enrollments.requested_course_ids. Best-effort links each row to
// its Activated Course when one already exists for that Run+Course (see
// ensureActivatedCourse above); NULL when it doesn't (e.g. the Run's
// course-targeting dual-write predates this enrolment, or the Run simply
// hasn't targeted that Course as its own row yet) — never invented.
function recordEnrollmentCourseSelections(enrollmentId, learningInstanceId, courseIds) {
  if (!enrollmentId || !Array.isArray(courseIds) || !courseIds.length) return;
  const findActivated = db.prepare(
    "SELECT id FROM learning_instance_courses WHERE learning_instance_id = ? AND course_id = ?"
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO programme_enrollment_courses (id, programme_enrollment_id, course_id, learning_instance_course_id) VALUES (?, ?, ?, ?)"
  );
  courseIds.forEach((courseId) => {
    if (!courseId) return;
    const activated = learningInstanceId ? findActivated.get(learningInstanceId, courseId) : null;
    insert.run(uuid(), enrollmentId, courseId, activated ? activated.id : null);
  });
}

// syncActivatedCourseInstructor (ABRS v2.1 Phase 3 Checkpoint 3b) removed
// — it mirrored the legacy global instructor_courses assignment onto
// learning_instance_courses.instructor_id. Both the legacy table and that
// call pattern are gone as of the Instructor Assignment remediation (see
// server/src/db/migrate.js and utils/instructorScope.js); instructor
// scope is now read exclusively from instructor_assignments.

// ABRS v2.1 Phase 3 Checkpoint 3b — resolves the Activated Course row (§8)
// for a given Run + Course, if one has been created (via the Checkpoint 3a
// dual-write or an admin action). Returns a plain DTO or null; never
// throws on a missing row — callers treat "no Activated Course row yet"
// as a normal, expected state (e.g. a Run created before Checkpoint 3a).
function getActivatedCourseForInstance(learningInstanceId, courseId) {
  if (!learningInstanceId || !courseId) return null;
  const row = db
    .prepare("SELECT * FROM learning_instance_courses WHERE learning_instance_id = ? AND course_id = ?")
    .get(learningInstanceId, courseId);
  if (!row) return null;
  return {
    id: row.id,
    learningInstanceId: row.learning_instance_id,
    courseId: row.course_id,
    status: row.status,
    isHidden: !!row.is_hidden,
    isCompulsory: !!row.is_compulsory,
    sortOrder: row.sort_order,
    instructorId: row.instructor_id || null,
  };
}

function toActivatedCourseDto(row) {
  return {
    id: row.id,
    learningInstanceId: row.learning_instance_id,
    courseId: row.course_id,
    courseTitle: row.course_title || null,
    status: row.status,
    isHidden: !!row.is_hidden,
    isCompulsory: !!row.is_compulsory,
    sortOrder: row.sort_order,
    instructorId: row.instructor_id || null,
    instructorName: row.instructor_name || null,
  };
}

// ABRS v2.1 Phase 5 prerequisite (Appendix A-2, "what's still missing"
// from Checkpoint 3b's own report) — every Activated Course row for a
// Run, joined with the Course's title and (if Run-scoped instructor_id
// is set) that instructor's name, for the admin review/edit UI. Ordered
// the same way registration would eventually display them once a flag is
// on (sort_order, then title) so what an admin sees here previews what
// learners will.
function getActivatedCoursesForInstance(learningInstanceId) {
  if (!learningInstanceId) return [];
  const rows = db
    .prepare(
      `SELECT lic.*, c.title AS course_title, u.name AS instructor_name
       FROM learning_instance_courses lic
       JOIN courses c ON c.id = lic.course_id
       LEFT JOIN users u ON u.id = lic.instructor_id
       WHERE lic.learning_instance_id = ?
       ORDER BY lic.sort_order ASC, c.title ASC`
    )
    .all(learningInstanceId);
  return rows.map(toActivatedCourseDto);
}

// Admin edit for a single Activated Course row's own configuration (§8:
// status, Hidden, Compulsory, display order, Run-scoped instructor).
// Only touches learning_instance_courses — never instructor_courses (the
// global assignment table stays exactly what every authorization check
// still reads; see Checkpoint 3b's report for why that cutover is
// deliberately separate). Returns the updated DTO, or null if no
// Activated Course row exists with that id for that Run.
function updateActivatedCourse(learningInstanceId, activatedCourseId, patch) {
  const existing = db
    .prepare("SELECT * FROM learning_instance_courses WHERE id = ? AND learning_instance_id = ?")
    .get(activatedCourseId, learningInstanceId);
  if (!existing) return null;

  const next = {
    status: patch.status !== undefined ? patch.status : existing.status,
    isHidden: patch.isHidden !== undefined ? (patch.isHidden ? 1 : 0) : existing.is_hidden,
    isCompulsory: patch.isCompulsory !== undefined ? (patch.isCompulsory ? 1 : 0) : existing.is_compulsory,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : existing.sort_order,
    instructorId: patch.instructorId !== undefined ? (patch.instructorId || null) : existing.instructor_id,
  };

  db.prepare(
    `UPDATE learning_instance_courses
     SET status = ?, is_hidden = ?, is_compulsory = ?, sort_order = ?, instructor_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(next.status, next.isHidden, next.isCompulsory, next.sortOrder, next.instructorId, activatedCourseId);

  const row = db
    .prepare(
      `SELECT lic.*, c.title AS course_title, u.name AS instructor_name
       FROM learning_instance_courses lic
       JOIN courses c ON c.id = lic.course_id
       LEFT JOIN users u ON u.id = lic.instructor_id
       WHERE lic.id = ?`
    )
    .get(activatedCourseId);
  return toActivatedCourseDto(row);
}

// Assign (or reactivate) a reusable Course on a specific Learning Instance.
// Idempotent — re-activates an existing inactive row instead of duplicating.
function assignCourseToInstance(learningInstanceId, courseId) {
  if (!learningInstanceId || !courseId) return { error: "learningInstanceId and courseId are required." };
  const course = db.prepare("SELECT id FROM courses WHERE id = ?").get(courseId);
  if (!course) return { error: "Course not found." };

  const existing = db
    .prepare("SELECT id FROM learning_instance_courses WHERE learning_instance_id = ? AND course_id = ?")
    .get(learningInstanceId, courseId);
  if (existing) {
    const updated = updateActivatedCourse(learningInstanceId, existing.id, { status: "active", isHidden: false });
    return updated ? { activatedCourse: updated } : { error: "Failed to update existing Course assignment." };
  }

  ensureActivatedCourse(learningInstanceId, courseId);
  const row = db
    .prepare(
      `SELECT lic.*, c.title AS course_title, u.name AS instructor_name
       FROM learning_instance_courses lic
       JOIN courses c ON c.id = lic.course_id
       LEFT JOIN users u ON u.id = lic.instructor_id
       WHERE lic.learning_instance_id = ? AND lic.course_id = ?`
    )
    .get(learningInstanceId, courseId);
  return row ? { activatedCourse: toActivatedCourseDto(row) } : { error: "Failed to assign Course to this Learning Instance." };
}

// Remove a Course from a Learning Instance for new learners — sets the
// assignment inactive rather than deleting the row, preserving historical
// programme_enrollment_courses links and audit integrity.
function deactivateCourseFromInstance(learningInstanceId, activatedCourseId) {
  const updated = updateActivatedCourse(learningInstanceId, activatedCourseId, { status: "inactive" });
  if (!updated) return { error: "Activated Course not found on this Learning Instance." };
  return { activatedCourse: updated };
}

function addTarget(instance, { programmeId, courseId }) {
  const associationError = validateOfferingTypeAssociation({
    offeringTypeId: instance.offeringTypeId,
    programmeId,
    courseId,
  });
  if (associationError) return { error: associationError };

  const targetType = programmeId ? "programme" : "course";
  const value = programmeId || courseId;
  const already = getInstanceTargets(instance.id).some(
    (t) => (programmeId && t.programmeId === value) || (courseId && t.courseId === value)
  );
  if (already) return { error: "This Programme/Module is already attached to this Learning Instance." };

  if (instance.status === "active") {
    // ABRS v2.2 amendment (concurrent Programme Runs) — a Programme/Course
    // may now be claimed by more than one Active Learning Instance at
    // once; adding it as a secondary target of another already-Active run
    // is no longer a conflict. See the matching note on
    // findActiveInstanceConflict below.
  }

  const id = uuid();
  try {
    db.prepare(
      `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, course_id, is_primary, instance_status)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).run(id, instance.id, targetType, programmeId || null, courseId || null, instance.status);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e.message)) {
      return { error: "This Programme/Module is already claimed by another Active Learning Instance, or already attached here." };
    }
    throw e;
  }
  // ABRS v2.1 Phase 3 Checkpoint 3a (Appendix A-2) — a Course target is
  // exactly a Run activating that Course (§8); mirror it into the
  // Activated Course table alongside the legacy target row above.
  if (courseId) ensureActivatedCourse(instance.id, courseId);
  return { target: toTargetDto(db.prepare("SELECT lit.*, p.name AS programme_name, m.title AS course_title FROM learning_instance_targets lit LEFT JOIN programmes p ON p.id = lit.programme_id LEFT JOIN courses m ON m.id = lit.course_id WHERE lit.id = ?").get(id)) };
}

// Removes a secondary target. The primary target (is_primary = 1, the one
// mirroring learning_instances.programme_id/course_id) can never be
// removed this way — that's the instance's core identity; to change it,
// cancel this instance and create a new one, same rule PATCH already
// applies to programmeId/courseId. Returns { error } or { removed: true }.
function removeTarget(instance, targetId) {
  const row = db.prepare("SELECT * FROM learning_instance_targets WHERE id = ? AND learning_instance_id = ?").get(targetId, instance.id);
  if (!row) return { error: "Target not found on this Learning Instance." };
  if (row.is_primary) return { error: "Can't remove a Learning Instance's primary target — cancel this instance and create a new one instead." };
  db.prepare("DELETE FROM learning_instance_targets WHERE id = ?").run(targetId);
  return { removed: true };
}

// Phase 4 — configures (or reconfigures) a Learning Instance's academic
// structure, generating exactly the right number of default-named periods
// ("Semester 1"/"Semester 2" or "Term 1"/"Term 2"/"Term 3"). Locked once
// the run has left 'upcoming' — same reasoning as the primary target being
// immutable after creation: by the time a run is Active, period-scoped
// activity (payments, results, transcripts, certificates — Phases 6/7) may
// already be attached to its current periods, and silently swapping the
// structure out from under that data would either orphan it or force a
// guess at which new period it belongs to, both of which this task
// explicitly forbids. Returns { error } or { academicStructure, periods }.
// ROOT ARCHITECTURAL RULE: Bootcamp must never have Academic Periods.
// Bootcamp is a short-course/run-based offering (Learning Instance ->
// one-time Registration Fee -> active enrolment -> content access) and
// must never depend on Academic Period/Term/Semester machinery. This is
// the single server-side gate every path that could *create* an academic
// structure on a Learning Instance goes through — enforced here, not just
// hidden in the admin UI, so no client can bypass it and no Bootcamp
// Learning Instance can ever end up with real (non-legacy) period data
// going forward. Legacy Bootcamp instances that already have stale
// academic_structure data from before this rule existed are handled
// separately, at the enforcement/read side (see periodPayments.js's
// evaluatePeriodAccess) — they're never *acted on*, only ignored.
function isBootcampOfferingType(offeringType) {
  if (!offeringType) return false;
  const slug = typeof offeringType === "string" ? offeringType : offeringType.slug;
  return slug === "bootcamp";
}

function setAcademicStructure(instance, structure) {
  if (!isValidAcademicStructure(structure)) {
    return { error: `structure must be one of: ${ACADEMIC_STRUCTURES.join(", ")}.` };
  }
  if (isBootcampOfferingType(getOfferingTypeSlugForInstance(instance))) {
    return { error: "Bootcamp Learning Instances don't use Academic Periods — Bootcamp is a one-time Registration Fee, run-based offering." };
  }
  if (instance.status !== "upcoming") {
    return { error: "A Learning Instance's academic structure can only be set (or changed) while it's still 'upcoming' — once activity may be attached to it, cancel this instance and create a new one instead." };
  }
  const periodCount = ACADEMIC_STRUCTURE_PERIOD_COUNTS[structure];
  const label = structure === "semester" ? "Semester" : "Term";

  const tx = db.transaction(() => {
    // Replacing an existing structure: safe to wipe and regenerate only
    // because we've just confirmed status === 'upcoming' above, i.e. no
    // period-scoped activity could exist against the old periods yet.
    db.prepare("DELETE FROM learning_instance_academic_periods WHERE learning_instance_id = ?").run(instance.id);
    db.prepare("UPDATE learning_instances SET academic_structure = ?, updated_at = datetime('now') WHERE id = ?").run(structure, instance.id);
    const insertPeriod = db.prepare(
      `INSERT INTO learning_instance_academic_periods (id, learning_instance_id, sequence, name)
       VALUES (?, ?, ?, ?)`
    );
    for (let seq = 1; seq <= periodCount; seq += 1) {
      insertPeriod.run(uuid(), instance.id, seq, `${label} ${seq}`);
    }
  });
  tx();
  return { academicStructure: structure, periods: getAcademicPeriods(instance.id) };
}

// Phase 4 — lets an admin rename a period, or link/adjust its optional
// dates and cross-reference to the school-wide academic_terms calendar.
// Deliberately can't change `sequence` (that's the period's identity/
// ordering within the structure) or move it to a different Learning
// Instance — to change the structure itself, use setAcademicStructure.
// ABRS Admin Configuration Workflow compliance remediation — an Academic
// Period is not considered configured until it is linked to an Academic
// Term. This refuses to leave a period with a null academic_term_id once
// it's been touched through this endpoint: passing academicTermId as
// empty/null is rejected outright. A period created by setAcademicStructure
// and never yet edited keeps its historical NULL until an admin actively
// configures it here — this only forbids *introducing or preserving* an
// unlinked period through an explicit edit; it does not retroactively
// touch periods nobody has opened yet.
function updateAcademicPeriod(instance, periodId, { name, academicTermId, startDate, endDate }) {
  if (isBootcampOfferingType(getOfferingTypeSlugForInstance(instance))) {
    return { error: "Bootcamp Learning Instances don't use Academic Periods." };
  }
  const row = db.prepare("SELECT * FROM learning_instance_academic_periods WHERE id = ? AND learning_instance_id = ?").get(periodId, instance.id);
  if (!row) return { error: "Academic period not found on this Learning Instance." };

  const nextAcademicTermId = academicTermId !== undefined ? (academicTermId || null) : row.academic_term_id;
  if (!nextAcademicTermId) {
    return { error: "An Academic Period must be linked to an Academic Term — select one from the Institution Academic Calendar before saving." };
  }
  const term = db.prepare("SELECT id FROM academic_terms WHERE id = ?").get(nextAcademicTermId);
  if (!term) return { error: "academicTermId does not match a known Academic Term." };

  const nextStart = startDate !== undefined ? (startDate || null) : row.start_date;
  const nextEnd = endDate !== undefined ? (endDate || null) : row.end_date;
  if (nextStart && nextEnd && String(nextEnd) < String(nextStart)) {
    return { error: "endDate can't be before startDate." };
  }
  db.prepare(
    `UPDATE learning_instance_academic_periods SET name = ?, academic_term_id = ?, start_date = ?, end_date = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    name !== undefined ? (name || row.name) : row.name,
    nextAcademicTermId,
    nextStart,
    nextEnd,
    periodId
  );
  return { period: getAcademicPeriods(instance.id).find((p) => p.id === periodId) };
}

// Phase 6 — configures (or clears) a period's payment requirement. Passing
// mode: null clears the requirement entirely (access reverts to
// unrestricted-by-payment for this period — the same state every existing/
// historical period is already in, since the column defaults to NULL).
// 'deposit' mode requires a positive requiredAmountGHS (an admin can't
// enable deposit gating with no actual amount); 'full' mode also requires
// a positive requiredAmountGHS — this is deliberately an explicit
// admin-set figure rather than silently re-derived from the unrelated
// Kids/Adult registration-fee logic in utils/fees.js, so a period's
// payment requirement always means exactly what the admin configured for
// it, nothing inferred.
function setPeriodPaymentRequirement(instance, period, { mode, requiredAmountGHS }) {
  if (mode !== null && mode !== undefined && !["full", "deposit"].includes(mode)) {
    return { error: "mode must be 'full', 'deposit', or null to clear the requirement." };
  }
  if (mode && isBootcampOfferingType(getOfferingTypeSlugForInstance(instance))) {
    return { error: "Bootcamp Learning Instances don't use Academic Periods — Bootcamp is a one-time Registration Fee, run-based offering." };
  }
  // Combined Registration + First Period Payment: when combine is ON, the
  // first academic period's payment requirement is inherited from the
  // Registration Fee and must stay non-editable — an independently
  // configured amount here would create two competing definitions of the
  // same obligation (business rule §5/§9). Clearing (mode: null) is still
  // allowed, since that never conflicts with the inherited requirement.
  if (mode && isCombinedFirstPeriod(instance, period)) {
    return {
      error:
        "This period's payment requirement is inherited from the Registration Fee because Combine Registration with First Period is on. Turn that setting off, or edit the Registration Fee instead.",
    };
  }
  const normalizedMode = mode || null;
  if (normalizedMode && (requiredAmountGHS == null || Number(requiredAmountGHS) <= 0)) {
    return { error: "requiredAmountGHS must be a positive amount when a payment mode is set." };
  }
  const normalizedAmount = normalizedMode ? Number(requiredAmountGHS) : null;
  db.prepare(
    "UPDATE learning_instance_academic_periods SET payment_mode = ?, required_amount_ghs = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(normalizedMode, normalizedAmount, period.id);
  return { period: getAcademicPeriods(instance.id).find((p) => p.id === period.id) };
}

// Phase 6 — resolves which of a Learning Instance's academic periods is
// "current" for enforcement purposes, using each period's optional
// start/end dates:
//   1. the period whose [startDate, endDate] contains today, if any;
//   2. otherwise the most recently started period (highest sequence whose
//      startDate has passed);
//   3. otherwise the first period (sequence 1) — a sane default for a run
//      whose periods have no dates configured yet.
// Returns null if the instance has no academic structure/periods at all
// (nothing to resolve — see the "no academicStructure = no period-based
// enforcement" rule applied wherever this is used).
function getCurrentAcademicPeriod(instance) {
  if (!instance || !instance.academicStructure) return null;
  const periods = instance.academicPeriods || [];
  if (!periods.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const withinRange = periods.find((p) => p.startDate && p.endDate && p.startDate <= today && today <= p.endDate);
  if (withinRange) return withinRange;
  const started = periods.filter((p) => p.startDate && p.startDate <= today).sort((a, b) => b.sequence - a.sequence);
  if (started.length) return started[0];
  return periods.find((p) => p.sequence === 1) || periods[0];
}

// Combined Registration + First Period Payment (see migrate.js's
// combine_registration_with_first_period comment for the full
// rationale, and docs/combine-registration-with-first-period.md for the
// authoritative business rule).
//
// When `instance` is configured for combined mode, the Registration Fee
// itself IS the payment requirement for the first Academic Period
// (sequence 1) — never the reverse. Returns
// { periodId, periodName, requiredAmountGHS } (requiredAmountGHS always
// equal to the instance's own Registration Fee) whenever combine is ON,
// the instance has a resolvable first period, and a Registration Fee is
// actually configured. Returns null when the flag is off, there's no
// academic structure/period to attach the charge to, or no Registration
// Fee is configured yet (nothing to combine — same "nothing configured
// yet = nothing changes" fallback every other period-payment feature in
// this codebase uses).
//
// Deliberately resolves the FIRST period (sequence 1), not
// getCurrentAcademicPeriod's date-based "current" period — combine only
// ever governs Term 1/Semester 1's obligation, regardless of which
// period today's date happens to fall into.
function resolveCombinedPeriodCharge(instance) {
  if (!instance || !instance.combineRegistrationWithFirstPeriod) return null;
  const periods = instance.academicPeriods || [];
  if (!periods.length) return null;
  const period = periods.find((p) => p.sequence === 1) || periods[0];
  if (!period) return null;
  const requiredAmountGHS = instance.registrationFeeGHS != null ? Number(instance.registrationFeeGHS) : null;
  if (!requiredAmountGHS || requiredAmountGHS <= 0) return null;
  return { periodId: period.id, periodName: period.name, requiredAmountGHS };
}

// Whether `period` is the first academic period (sequence 1) of an
// instance that has combine mode ON — the one period whose payment
// requirement is inherited from the Registration Fee rather than
// independently configured. Used both to block contradictory admin
// configuration (setPeriodPaymentRequirement below) and to resolve the
// effective requirement for access/status checks
// (utils/periodPayments.js).
function isCombinedFirstPeriod(instance, period) {
  if (!instance || !period || !instance.combineRegistrationWithFirstPeriod) return false;
  const periods = instance.academicPeriods || [];
  const first = periods.find((p) => p.sequence === 1) || periods[0];
  return !!first && first.id === period.id;
}

// Same invariant the migrate.js "Combined Registration + First Period
// Payment correction backfill" enforces for existing data, applied at the
// one live write path that can otherwise recreate it going forward:
// PATCH .../operational-config turning combineRegistrationWithFirstPeriod
// ON. setPeriodPaymentRequirement already refuses to let an admin SET a
// mode on the first period while combine is ON, but it has no say over a
// first period that was independently configured BEFORE combine was
// switched on — that stale payment_mode/required_amount_ghs would
// otherwise sit there unnoticed, the exact two-competing-definitions
// state (§5/§9) the backfill exists to clear. Called unconditionally
// whenever a Run's combine flag ends up ON (not just on the OFF->ON
// transition) so it's idempotent and self-healing the same way the
// migration backfill's WHERE clause is — safe to call on every save.
function clearStaleFirstPeriodPaymentConfigIfCombined(instanceId) {
  if (!instanceId) return;
  const row = db.prepare("SELECT combine_registration_with_first_period FROM learning_instances WHERE id = ?").get(instanceId);
  if (!row || !row.combine_registration_with_first_period) return;
  const firstPeriod = db
    .prepare(
      `SELECT id, payment_mode, required_amount_ghs FROM learning_instance_academic_periods
       WHERE learning_instance_id = ?
       ORDER BY sequence ASC, created_at ASC
       LIMIT 1`
    )
    .get(instanceId);
  if (firstPeriod && (firstPeriod.payment_mode != null || firstPeriod.required_amount_ghs != null)) {
    db.prepare(
      "UPDATE learning_instance_academic_periods SET payment_mode = NULL, required_amount_ghs = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(firstPeriod.id);
  }
}

// The payment requirement that actually governs `period`, right now —
// the one thing every payment-status/access-control/admin-payment check
// should call instead of reading period.paymentMode/requiredAmountGHS
// directly. For the combined-mode first period this is always the
// instance's Registration Fee (mode 'full' — a Registration Fee is never
// a partial deposit); for every other period it's exactly whatever the
// admin independently configured on that period row. Shape matches
// { mode, requiredAmountGHS } so callers can drop it straight into
// period-shaped code; requiredAmountGHS is null when nothing is
// required.
function getEffectivePeriodPaymentRequirement(instance, period) {
  if (isCombinedFirstPeriod(instance, period)) {
    const combined = resolveCombinedPeriodCharge(instance);
    if (combined) return { mode: "full", requiredAmountGHS: combined.requiredAmountGHS, inheritedFromRegistrationFee: true };
  }
  if (!period || !period.paymentMode || !period.requiredAmountGHS) return { mode: null, requiredAmountGHS: null, inheritedFromRegistrationFee: false };
  return { mode: period.paymentMode, requiredAmountGHS: Number(period.requiredAmountGHS), inheritedFromRegistrationFee: false };
}

// ============================================================
// ABRS v2.2 Compliance Remediation — Constitutional Academic Term
// resolution: Programme Run -> Academic Period -> Academic Term
// (§8.2 "Programme Runs own... the academic calendar, academic periods",
// §13.1, §19 Single Source of Truth Reference, §21 Reporting, §22
// Certification). This is now the ONLY path any term-scoped activity
// record (attendance, grades, assessments, examinations, transcripts,
// certificates) may use to determine which Academic Term a record
// belongs to or is filtered by.
//
// Deliberately NO fallback to a school-wide "active" Academic Term
// (utils/academicTerm.js's getActiveTerm/getActiveTermId) here: an
// institution-wide selection that is independent of the owning Programme
// Run is precisely the second, competing owner the Single Ownership
// Principle (§2.1) forbids — two Programme Runs on different academic
// calendars must never be silently coerced onto the same term just
// because an admin activated one globally.
//
// Returns null when the instance has no academic structure configured, no
// resolvable current period, or the current period simply isn't yet
// linked to a school-wide Academic Term
// (learning_instance_academic_periods.academic_term_id is NULL until an
// admin sets it via PATCH .../academic-periods/:periodId — Phase 4).
// Callers must treat null as "not yet configured" — e.g. reject a write
// with a 409 telling the admin to finish configuring the Run's Academic
// Calendar — never guess, backfill, or fall back to a different owner.
function resolveConstitutionalTermId(instanceOrId) {
  const instance = typeof instanceOrId === "string" ? getLearningInstanceById(instanceOrId) : instanceOrId;
  if (!instance) return null;
  const period = getCurrentAcademicPeriod(instance);
  if (!period) return null;
  return period.academicTermId || null;
}

// Convenience wrapper for the shape almost every term-scoped route already
// has on hand: a Module/Course id. Resolves the Course's own Active
// Programme Run (getActiveInstanceIdForCourse — the same call every one of
// these routes already makes to resolve learningInstanceId) and then that
// Run's current Academic Period's linked Academic Term, so the two ids a
// record is stamped with (learning_instance_id and term_id) are always
// derived from the same resolution, never resolved independently of one
// another (which is exactly how the two could previously drift apart).
function resolveConstitutionalTermIdForCourse(courseId) {
  const instanceId = getActiveInstanceIdForCourse(courseId);
  return instanceId ? resolveConstitutionalTermId(instanceId) : null;
}

// Same convenience wrapper, for the Class/Programme-level shape used by
// Programme-level (non-module) certificates.
function resolveConstitutionalTermIdForClass(classId) {
  const instanceId = getActiveInstanceIdForClass(classId);
  return instanceId ? resolveConstitutionalTermId(instanceId) : null;
}

// Phase 6/8 — shared "is this Programme/Module currently available for
// registration/enrolment/access, given the instance's academic structure"
// check. Same back-compat rules as evaluatePeriodAccess in
// utils/periodPayments.js (which reuses this for its own target check):
// no academic structure configured at all, no resolvable current period,
// or the current period's target list simply not configured yet (empty)
// all mean "available" — nothing here ever locks a run down further than
// an admin has actually configured.
function isTargetActiveInCurrentPeriod(instance, { courseId = null, programmeId = null } = {}) {
  if (!instance || !instance.academicStructure) return true;
  const period = getCurrentAcademicPeriod(instance);
  if (!period) return true;
  const periodTargets = getPeriodTargets(period.id);
  if (!periodTargets.length) return true;
  return periodTargets.some((t) => (courseId && t.courseId === courseId) || (programmeId && t.programmeId === programmeId));
}

// Phase 5 — Period-specific target configuration. A period's configured
// targets, resolved as full target DTOs (same shape getInstanceTargets
// returns) via the learning_instance_period_targets join — never a
// separate/duplicated copy of target identity.
const PERIOD_TARGET_SELECT = `
  SELECT lit.*, p.name AS programme_name, m.title AS course_title
  FROM learning_instance_period_targets lipt
  JOIN learning_instance_targets lit ON lit.id = lipt.learning_instance_target_id
  LEFT JOIN programmes p ON p.id = lit.programme_id
  LEFT JOIN courses m ON m.id = lit.course_id
  WHERE lipt.learning_instance_academic_period_id = ?
  ORDER BY lit.is_primary DESC, lit.created_at ASC
`;

function getPeriodTargets(periodId) {
  if (!periodId) return [];
  return db.prepare(PERIOD_TARGET_SELECT).all(periodId).map(toTargetDto);
}

// Replaces the full set of targets configured for one academic period.
// Every id in targetIds must already be one of this Learning Instance's
// OWN targets (learning_instance_targets) — a period can only expose a
// subset of what the run serves overall, never something unrelated.
// Passing the exact same targetIds another period already has is exactly
// how an admin chooses "same targets as another period" (option 1);
// passing a different list is option 2 — both go through this one
// function, so there's no separate "inherit" code path that could ever
// apply itself automatically.
function setPeriodTargets(instance, period, targetIds) {
  if (!Array.isArray(targetIds)) return { error: "targetIds must be an array." };
  if (targetIds.length && isBootcampOfferingType(getOfferingTypeSlugForInstance(instance))) {
    return { error: "Bootcamp Learning Instances don't use Academic Periods — Bootcamp is a one-time Registration Fee, run-based offering." };
  }
  const ownTargetIds = new Set(getInstanceTargets(instance.id).map((t) => t.id));
  const invalid = targetIds.filter((id) => !ownTargetIds.has(id));
  if (invalid.length) {
    return { error: "Every targetId must already be attached to this Learning Instance (see its targets list) — attach it there first." };
  }
  const uniqueIds = [...new Set(targetIds)];
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM learning_instance_period_targets WHERE learning_instance_academic_period_id = ?").run(period.id);
    const insert = db.prepare(
      `INSERT INTO learning_instance_period_targets (id, learning_instance_academic_period_id, learning_instance_target_id)
       VALUES (?, ?, ?)`
    );
    uniqueIds.forEach((targetId) => insert.run(uuid(), period.id, targetId));
  });
  tx();
  return { targets: getPeriodTargets(period.id) };
}

// The "for a given Learning Instance, academic period, and learner, which
// targets are actually active and available" resolution this task asks
// for: the period's configured targets, intersected with what this
// specific learner is actually currently enrolled in (enrollments.course_id
// for Module targets, programme_enrollments with status='active' for
// Programme targets) — a target isn't "available" to a learner who was
// never placed into it, even if the period itself exposes it.
function getLearnerActiveTargetsInPeriod(periodId, learnerId) {
  if (!periodId || !learnerId) return [];
  const periodTargets = getPeriodTargets(periodId);
  if (!periodTargets.length) return [];
  const learnerModuleIds = new Set(
    db.prepare("SELECT course_id FROM enrollments WHERE user_id = ?").all(learnerId).map((r) => r.course_id)
  );
  const learnerActiveProgrammeIds = new Set(
    db.prepare("SELECT programme_id FROM programme_enrollments WHERE user_id = ? AND status = 'active'").all(learnerId).map((r) => r.programme_id)
  );
  return periodTargets.filter(
    (t) => (t.courseId && learnerModuleIds.has(t.courseId)) || (t.programmeId && learnerActiveProgrammeIds.has(t.programmeId))
  );
}

function assertTransitionAllowed(currentStatus, targetStatus) {
  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (allowed.includes(targetStatus)) return null;
  const list = allowed.length ? allowed.join(", ") : "none — this is a terminal status";
  return `Can't move a Learning Instance from "${currentStatus}" to "${targetStatus}". Valid next status(es) from "${currentStatus}": ${list}.`;
}

/* ---------------------------------------------------------------------
   Reusable read helpers for future consumers (enrolments, payments,
   attendance, assessments, results, certificates, transcripts,
   dashboards, reports, registration, instructor assignment). None of
   those modules are wired up to these yet — this is the interface they
   will use once that work starts.
   --------------------------------------------------------------------- */

// The single Active run for a Programme, or null — found via
// learning_instance_targets so a Programme attached only as a *secondary*
// target of some run is still correctly resolved (not just runs where
// it's the primary target). This is what "which run does this enrolment
// belong to" / the registration catalogue's active-run check resolves to.
//
// ABRS v2.2 amendment (concurrent Programme Runs): a Programme can now
// have MORE THAN ONE Active run at once (see migrate.js's "Concurrent
// Programme Runs enabled" note). When that's the case, this function
// still returns exactly one row — the most-recently-activated one — as a
// backward-compatible default for the many read-only/reporting callers
// that only ever expected a single answer and aren't in a position to
// prompt anyone for a choice. This default is NOT safe for registration
// or enrolment-attachment decisions once more than one Active run
// exists — those call sites must use getActiveInstancesForProgramme()
// directly and require an explicit disambiguator (operationalGroupId or
// instanceId) instead of silently trusting this "most recent" guess. See
// routes/auth.js's requestedOperationalGroupId handling for the pattern.
function getActiveInstanceForProgramme(programmeId) {
  const candidates = getActiveInstancesForProgramme(programmeId);
  return candidates[0] || null;
}

// Every currently-Active run for a Programme (via learning_instance_targets,
// same primary-or-secondary-target reasoning as getActiveInstanceForProgramme),
// ordered most-recently-activated first. Empty array if none. This is the
// function any NEW code — and any registration/enrolment-attachment code
// being updated to support concurrent Runs — should call, since it's the
// only one of the two that doesn't hide the possibility of more than one
// answer.
function getActiveInstancesForProgramme(programmeId) {
  if (!programmeId) return [];
  const rows = db
    .prepare(
      `${LEARNING_INSTANCE_SELECT} JOIN learning_instance_targets lit ON lit.learning_instance_id = li.id
       WHERE lit.programme_id = ? AND li.status = 'active'
       ORDER BY li.created_at DESC`
    )
    .all(programmeId);
  return rows.map(toLearningInstanceDto);
}

// The single Active run for a Module, or null — same target-table lookup.
// Same "most-recently-activated default, not safe for registration once
// ambiguous" caveat as getActiveInstanceForProgramme above.
function getActiveInstanceForCourse(courseId) {
  const candidates = getActiveInstancesForCourse(courseId);
  return candidates[0] || null;
}

// Every currently-Active run for a Course/Module, most-recently-activated
// first. See getActiveInstancesForProgramme above.
function getActiveInstancesForCourse(courseId) {
  if (!courseId) return [];
  const rows = db
    .prepare(
      `${LEARNING_INSTANCE_SELECT} JOIN learning_instance_targets lit ON lit.learning_instance_id = li.id
       WHERE lit.course_id = ? AND li.status = 'active'
       ORDER BY li.created_at DESC`
    )
    .all(courseId);
  return rows.map(toLearningInstanceDto);
}

// Registration-safe resolver: given a Programme and an optional
// operationalGroupId/instanceId the caller's request is targeting,
// resolves which specific Active Run registration should attach to —
// WITHOUT silently guessing when more than one Active Run exists. Returns:
//   { instance, ambiguous: false }              — exactly one answer (0 or 1 Active Runs, or a disambiguator matched one)
//   { instance: null, ambiguous: true, options } — 2+ Active Runs and no (or no matching) disambiguator; caller must ask
// `options` is the raw list from getActiveInstancesForProgramme, safe to
// return to the client as-is (already DTO-shaped) so it can render a
// picker ("Which run are you registering into?").
//
// Two disambiguators are accepted, checked in this order:
//   1. `instanceId` — an explicit Run id the caller picked directly (e.g.
//      a "which cohort/term" selector in the registration UI). Simplest
//      and always available, even for a Run with no Operational Groups
//      configured under it yet.
//   2. `operationalGroupId` — resolves indirectly via which Run that
//      group belongs to (§11.3's "which school/batch" selector) — kept
//      for every existing caller that already sends this.
function resolveActiveInstanceForRegistration(programmeId, operationalGroupId, instanceId, participationStructure) {
  let candidates = getActiveInstancesForProgramme(programmeId);
  // When the caller knows which participation structure they are registering
  // into, never silently attach them to a Run of a different structure
  // (e.g. Individual Course → Structured School Club) merely because it is
  // active on the same Programme. Legacy callers that omit the structure
  // keep the historical unfiltered behaviour.
  if (participationStructure === "individual_course") {
    candidates = candidates.filter((c) => c.participationStructure === "individual_course");
  } else if (participationStructure) {
    // Structured journeys must never resolve onto an Individual Course run.
    // Exact-structure matches are preferred when any exist; otherwise any
    // non-individual (including legacy NULL) Active Run remains eligible.
    const nonIndividual = candidates.filter((c) => c.participationStructure !== "individual_course");
    const exact = nonIndividual.filter((c) => c.participationStructure === participationStructure);
    candidates = exact.length ? exact : nonIndividual;
  }
  if (candidates.length <= 1) {
    return { instance: candidates[0] || null, ambiguous: false, options: candidates };
  }
  if (instanceId) {
    const match = candidates.find((c) => c.id === instanceId);
    if (match) return { instance: match, ambiguous: false, options: candidates };
  }
  if (operationalGroupId) {
    const group = db.prepare("SELECT learning_instance_id FROM operational_groups WHERE id = ? AND is_active = 1").get(operationalGroupId);
    if (group) {
      const match = candidates.find((c) => c.id === group.learning_instance_id);
      if (match) return { instance: match, ambiguous: false, options: candidates };
    }
  }
  return { instance: null, ambiguous: true, options: candidates };
}

// Individual Course offering membership — authoritative for registration.
// A course is available for an Individual Course Learning Instance ONLY when
// it is explicitly linked to that offering (LI.course_id, a course target, or
// an activated learning_instance_courses row). A programme-level target alone
// identifies the Programme the offering belongs to; it must NOT authorize
// every course in that Programme for selection.
function isCourseAvailableForIndividualCourseOffering(instanceId, courseId) {
  if (!instanceId || !courseId) return false;
  const instance = getLearningInstanceById(instanceId);
  if (!instance) return false;
  if (instance.courseId === courseId) return true;
  const targets = getInstanceTargets(instanceId);
  if (targets.some((t) => t.courseId === courseId)) return true;
  const activated = db
    .prepare(
      `SELECT 1 FROM learning_instance_courses
       WHERE learning_instance_id = ? AND course_id = ? AND (status IS NULL OR status = 'active')`
    )
    .get(instanceId, courseId);
  return !!activated;
}

// True if ANY currently-Active Learning Instance has this Programme as one
// of its targets (primary or secondary) — the exact check Kids STEM
// registration's catalogue filter needs ("must only be able to select a
// Module or Programme that is currently associated with an active Learning
// Instance"), expressed as a boolean rather than needing the instance back.
function programmeHasActiveInstance(programmeId) {
  if (!programmeId) return false;
  return !!getActiveInstanceForProgramme(programmeId);
}

// Same, for a Module.
function courseHasActiveInstance(courseId) {
  if (!courseId) return false;
  return !!getActiveInstanceForCourse(courseId);
}

// True if the given Learning Instance is currently in a state where new
// enrolments/attendance/assessment activity would make sense (i.e. active).
// Exposed now so a future feature can gate on it without redefining what
// "usable" means for a Learning Instance.
function isInstanceOpenForActivity(instanceId) {
  const row = getLearningInstanceById(instanceId);
  return !!row && row.status === "active";
}

/* ---------------------------------------------------------------------
   Auto-attachment helpers — added for the Enrolments/Payments/Attendance/
   Assessments/Results/Certificates/Transcripts integration milestone.
   Every write path in those modules that creates a new record calls one
   of these to resolve the correct learning_instance_id automatically,
   rather than querying `learning_instances` directly. All three return a
   bare id (or null), matching what a `?`-bound INSERT needs, so callers
   don't have to unwrap a DTO just to get the id.

   Design: these resolve to the single ACTIVE run only. A Learning
   Instance is manually created/activated by an admin (see
   routes/learningInstances.js); until one exists and is active for a
   given Programme/Module, new activity simply isn't attached to a run
   yet (learning_instance_id stays NULL) — this never blocks the
   underlying action (enrolling, paying, marking attendance, etc.), since
   Learning Instance adoption is opt-in per the previous milestone's
   scope, not a new hard requirement on every Programme/Module.
   --------------------------------------------------------------------- */

// The active run for a Programme, as a bare id (or null).
function getActiveInstanceIdForProgramme(programmeId) {
  const inst = getActiveInstanceForProgramme(programmeId);
  return inst ? inst.id : null;
}

// The active run for a Module: the Module's own active instance if one
// exists, otherwise its parent Programme's active instance (a Module
// doesn't always get its own dedicated run — most activity runs at the
// Programme level, with per-Module instances reserved for a Module that's
// scheduled/run on its own, e.g. a standalone short course).
function getActiveInstanceIdForCourse(courseId) {
  if (!courseId) return null;
  const direct = getActiveInstanceForCourse(courseId);
  if (direct) return direct.id;
  const moduleRow = db.prepare("SELECT programme_id FROM courses WHERE id = ?").get(courseId);
  return moduleRow && moduleRow.programme_id ? getActiveInstanceIdForProgramme(moduleRow.programme_id) : null;
}

// The active run for whichever Programme a Class/Learning Group belongs
// to (classes are always scoped to one Programme — see classes.programme_id).
function getActiveInstanceIdForClass(classId) {
  if (!classId) return null;
  const classRow = db.prepare("SELECT programme_id FROM classes WHERE id = ?").get(classId);
  return classRow ? getActiveInstanceIdForProgramme(classRow.programme_id) : null;
}

/* ---------------------------------------------------------------------
   v31 — Programme Run operational ownership (Delivery Modes, Campuses,
   Fee, Installments, Capacity, Instructor). See migrate.js's v31 comment
   for the full rationale. These are the resolvers every other module
   (fees.js, routes/auth.js, routes/enrolments.js, routes/payments.js,
   routes/classes.js, the public registration-config endpoint) should call
   instead of reading learning_instances/classes columns directly.
   --------------------------------------------------------------------- */

// Resolves a Learning Instance's own operational configuration — the
// Programme Run's declared Delivery Modes/Campuses (joined to real campus
// rows), Fee, Installments (merged with the Offering Type's default when
// the Run hasn't set its own), Capacity, and assigned Instructor. Accepts
// either an instance id or an already-loaded raw DB row/DTO with an `id`.
function getInstanceOperationalConfig(instanceOrId) {
  const id = typeof instanceOrId === "string" ? instanceOrId : instanceOrId && instanceOrId.id;
  if (!id) return null;
  const row = db.prepare("SELECT * FROM learning_instances WHERE id = ?").get(id);
  if (!row) return null;
  const deliveryModes = parseJsonArray(row.delivery_modes);
  const campusIds = parseJsonArray(row.campus_ids);
  const campuses = campusIds.length
    ? db
        .prepare(`SELECT id, name FROM campuses WHERE id IN (${campusIds.map(() => "?").join(",")}) AND active = 1`)
        .all(...campusIds)
    : [];
  return {
    instanceId: row.id,
    deliveryModes,
    campusIds,
    campuses,
    feeGHS: row.fee_ghs != null ? row.fee_ghs : null,
    registrationFeeGHS: row.registration_fee_ghs != null ? row.registration_fee_ghs : null,
    combineRegistrationWithFirstPeriod: !!row.combine_registration_with_first_period,
    installmentsEnabled: row.installments_enabled == null ? null : !!row.installments_enabled,
    capacity: row.capacity != null ? row.capacity : null,
    instructorId: row.instructor_id || null,
  };
}

/* ---------------------------------------------------------------------
   Registration Window ownership (Programme Run) — ABRS v2.2 §8.2/§16
   compliance remediation. The Programme Run's own
   registration_opens_at/registration_deadline/registration_force_closed/
   registration_force_open are now the ONLY place registration
   configuration lives. The legacy Programme-level columns this used to
   fall back to (`programmes.registration_opens_at` etc., and
   utils/offeringTypeSettings.js's isProgrammeRegistrationOpen()) have
   been removed entirely — see migrate.js's backfill-and-drop migration,
   which one-time-copies any pre-existing Programme-level window onto its
   Programme's active Run before dropping those columns, so no live data
   is lost by this ownership consolidation. Single Ownership Principle
   (§2.1): there is now exactly one place a Registration Window can be
   read from or written to.
   --------------------------------------------------------------------- */

// True if this Learning Instance row has been given its own registration
// window configuration — i.e. an admin has touched at least one of the
// four Run-level registration fields. Exposed on the instance DTO
// (registrationWindowConfigured) purely as admin-facing information;
// unlike before this remediation, it no longer gates any fallback — an
// unconfigured Run (all NULL/0) simply means "open by default", the same
// "not configured yet = unrestricted" convention every other nullable
// operational-config field in this file already uses.
function isInstanceRegistrationConfigured(row) {
  if (!row) return false;
  return !!(row.registration_opens_at || row.registration_deadline || row.registration_force_closed || row.registration_force_open);
}

// Is registration currently open for this specific Learning Instance,
// taking its own registration-opens/deadline dates, its own end_date
// (auto-close once the run itself has ended), and any admin force-open/
// force-closed override into account? `row` is a raw `learning_instances`
// table row (has registration_opens_at/registration_deadline/
// registration_force_closed/registration_force_open/end_date columns).
//
// `deadlineOverride` (optional) is an Operational Group's own
// registration_deadline (§11.3 "Closing Date (optional)" — the ONLY
// registration-window field an Operational Group is constitutionally
// permitted to override; opens-at, force-open/force-closed and end_date
// all remain exclusively Run-owned, §8.2/§16). Pass `undefined` (not
// called, or the group has none set — NULL means "inherit from Run",
// never "no deadline") to fall back to the Run's own deadline exactly as
// before; pass an explicit value (including `null`, meaning the group
// was found but isn't overriding this field) to use it instead.
function isInstanceRegistrationOpen(row, deadlineOverride) {
  if (!row) return true; // no run = nothing configured, same "unrestricted by default" convention
  if (row.registration_force_open) return true;
  if (row.registration_force_closed) return false;
  const now = Date.now();
  if (row.registration_opens_at && now < Date.parse(row.registration_opens_at)) return false;
  // §16.4: an Operational Group's own Closing Date may only NARROW the
  // Run's own window, never widen it — so the effective deadline is
  // whichever of the two is earlier, not "the override if present". A
  // group with no override (undefined/null) simply defers entirely to
  // the Run's own deadline, exactly as before.
  const runDeadlineMs = row.registration_deadline ? Date.parse(row.registration_deadline) : null;
  const overrideMs = deadlineOverride ? Date.parse(deadlineOverride) : null;
  const effectiveDeadlineMs =
    runDeadlineMs != null && overrideMs != null
      ? Math.min(runDeadlineMs, overrideMs)
      : runDeadlineMs != null
      ? runDeadlineMs
      : overrideMs;
  if (effectiveDeadlineMs != null && now > effectiveDeadlineMs) return false;
  if (row.end_date && now > Date.parse(row.end_date)) return false;
  return true;
}

// Raw `learning_instances` row for a Programme's current Active Run, or
// null if it has none. Single query every registration-window reader
// (resolveProgrammeRegistrationOpen, getProgrammeRegistrationWindow)
// shares, so there's exactly one place that defines "the Run whose
// registration window governs this Programme".
// Raw `learning_instances` row for a Programme's current Active Run, or
// null if it has none. Single query every registration-window reader
// (resolveProgrammeRegistrationOpen, getProgrammeRegistrationWindow) goes
// through, so the public registration page and the admin's own "is this
// Run open for registration" checks can never disagree.
//
// ABRS v2.2 amendment (concurrent Programme Runs): more than one Run can
// be Active for the same Programme at once. This used to be a bare,
// unordered `.get()` — correct only when at most one Active Run could
// ever exist, and silently picking an arbitrary (not necessarily the
// admin's intended) row once that stopped being true. Ordered by
// li.created_at DESC — same "most-recently-activated wins" convention
// getActiveInstancesForProgramme above already uses for every other
// active-run resolution in the app — so registration-window resolution
// can't disagree with those about which Run is "the" one to read.
function getActiveInstanceRowForProgramme(programmeId) {
  if (!programmeId) return null;
  return db
    .prepare(
      `SELECT li.* FROM learning_instances li
       JOIN learning_instance_targets lit ON lit.learning_instance_id = li.id
       WHERE lit.programme_id = ? AND li.status = 'active'
       ORDER BY li.created_at DESC
       LIMIT 1`
    )
    .get(programmeId);
}

// Resolves the §11.3 Closing Date override (operational_groups.registration_deadline)
// for a candidate Operational Group, scoped to a specific Run — mirrors the
// same (group belongs to this instance AND is active) check every other
// operationalGroupId validation in the routes layer already performs, so
// an unrelated, inactive, or cross-Run group id can never affect
// registration-open resolution. Returns `undefined` (meaning "no
// override — fall back to the Run's own deadline") when there's no
// operationalGroupId, no matching/active group, or the group hasn't set
// its own Closing Date; returns the override value (a date string, or
// `null` if the group is real but hasn't set one) otherwise.
function getOperationalGroupRegistrationDeadlineOverride(instanceId, operationalGroupId) {
  if (!instanceId || !operationalGroupId) return undefined;
  const group = db
    .prepare("SELECT registration_deadline, is_active FROM operational_groups WHERE id = ? AND learning_instance_id = ?")
    .get(operationalGroupId, instanceId);
  if (!group || !group.is_active) return undefined;
  return group.registration_deadline || undefined;
}

// The single resolver every registration validation path should call.
// Resolution: this Programme's current ACTIVE Learning Instance (Run) is
// the sole authority — the constitution is explicit that Programme Runs
// own registration entirely (§8.2, §16) and that there is no fallback
// registration path when none exists: no Active Run at all means
// registration is not open, full stop. When an Active Run exists but
// hasn't configured its own window yet, it is simply open by default
// (§8.2's "not configured yet" convention), never a reason to consult the
// Programme — the Programme has no registration fields to consult.
// `programmeRow` is the already-loaded raw `programmes` row (every
// existing call site already has one) — its only remaining use here is
// to resolve programmeRow.id.
//
// `operationalGroupId` (optional) is the Operational Group the caller's
// registration request is targeting, if any — e.g. a second school or a
// later intake batch added under the same still-active Run (§11.3
// "Closing Date (optional)"). When that group has its own Closing Date
// set, it's honoured in place of the Run's own deadline for this specific
// caller, exactly as the constitution authorizes; every other Run-level
// gate (force-open/force-closed, opens-at, end_date) still applies
// uniformly, since only Closing Date is an Operational-Group-overridable
// field. Omitting it (every pre-existing caller) keeps this byte-for-byte
// the historical Run-only behaviour.
function resolveProgrammeRegistrationOpen(programmeRow, operationalGroupId) {
  if (!programmeRow) return true; // no programme scoping = unaffected legacy behaviour
  const activeInstanceRow = getActiveInstanceRowForProgramme(programmeRow.id);
  if (!activeInstanceRow) return false;
  const deadlineOverride = getOperationalGroupRegistrationDeadlineOverride(activeInstanceRow.id, operationalGroupId);
  return isInstanceRegistrationOpen(activeInstanceRow, deadlineOverride);
}

// Read-only view of a Programme's effective Registration Window, sourced
// exclusively from its active Run — used by routes/learningOfferings.js's
// Programme DTOs (public listing + admin listing) purely for *display*
// (e.g. "Registration opens ..." on the public registration card). This
// never accepts a write; the Run's own operational-config endpoint
// (PATCH /api/learning-instances/:id/operational-config) is the only
// place this data can be set (§8.2 Single Ownership).
function getProgrammeRegistrationWindow(programmeId) {
  const row = getActiveInstanceRowForProgramme(programmeId);
  return {
    registrationOpensAt: row ? row.registration_opens_at || null : null,
    registrationDeadline: row ? row.registration_deadline || null : null,
    registrationForceOpen: row ? !!row.registration_force_open : false,
    registrationForceClosed: row ? !!row.registration_force_closed : false,
  };
}

// Resolves the EFFECTIVE Delivery Mode/Campus/Fee for one Class — a Class-
// level value (back-compat per-batch override, e.g. Bootcamp's Weekday vs
// Weekend having different fees/campuses under the same Programme Run)
// takes precedence when the Class has explicitly set its own; otherwise
// this falls back to the Class's Programme Run's configuration (the new
// source of truth), auto-resolving to the Run's single option when it only
// declares one. Returns nulls (the historical "unspecified/legacy" state)
// when neither the Class nor its Run has anything configured — behaviour
// is byte-for-byte unchanged for every installation that predates v31.
function resolveClassOperationalConfig(classRow) {
  if (!classRow) return { deliveryMode: null, campusId: null, feeGHS: null, instanceId: null };
  const instanceId = getActiveInstanceIdForClass(classRow.id) || getActiveInstanceIdForProgramme(classRow.programme_id);
  const instanceConfig = instanceId ? getInstanceOperationalConfig(instanceId) : null;

  let deliveryMode = classRow.delivery_mode || null;
  if (!deliveryMode && instanceConfig && instanceConfig.deliveryModes.length === 1) {
    deliveryMode = instanceConfig.deliveryModes[0];
  }

  let campusId = classRow.campus_id || null;
  if (!campusId && instanceConfig && instanceConfig.campusIds.length === 1) {
    campusId = instanceConfig.campusIds[0];
  }

  const feeGHS = classRow.fee_ghs != null ? classRow.fee_ghs : instanceConfig && instanceConfig.feeGHS != null ? instanceConfig.feeGHS : null;

  return { deliveryMode, campusId, feeGHS, instanceId, instanceConfig };
}

// Resolves what a new enrolment row should record for its operational
// snapshot (v31 spec: "every enrollment must know Delivery Mode, Campus,
// Academic Period, Course Group"). Shared by every enrolment-writing path
// (routes/auth.js's registration, routes/enrolments.js's additional-
// programme enrolment) so they can never disagree. `classRow` is the
// learner's chosen Class (for its resolved Delivery Mode/Campus/Fee);
// `instanceId` is the Programme Run the enrolment is actually going into
// (falls back to the Class's own Run if omitted); `courseIds` is whatever
// Modules were selected at enrolment time (only used to resolve a single,
// unambiguous Course Group — left null if the selection spans none/more
// than one Course Group, never guessed).
function deriveEnrollmentOperationalSnapshot({ classRow, instanceId, courseIds, operationalGroupId } = {}) {
  // §17/§11.4: an explicitly-assigned Operational Group is the
  // authoritative source for Delivery Mode/Campus at enrolment time —
  // only falls through to the legacy Class-level resolution when no
  // Operational Group was assigned (this Run has none, or none was
  // chosen), preserving byte-for-byte pre-v39 behaviour in that case.
  const ogConfig = operationalGroupId ? resolveOperationalGroupConfig(operationalGroupId) : null;
  const classConfig = !ogConfig && classRow ? resolveClassOperationalConfig(classRow) : null;
  const resolvedInstanceId = instanceId || (ogConfig && ogConfig.instanceId) || (classConfig && classConfig.instanceId) || null;
  const instanceDto = resolvedInstanceId ? getLearningInstanceById(resolvedInstanceId) : null;
  const currentPeriod = instanceDto ? getCurrentAcademicPeriod(instanceDto) : null;

  let courseGroupId = null;
  if (Array.isArray(courseIds) && courseIds.length) {
    const rows = db
      .prepare(`SELECT DISTINCT course_group_id FROM courses WHERE id IN (${courseIds.map(() => "?").join(",")}) AND course_group_id IS NOT NULL`)
      .all(...courseIds);
    if (rows.length === 1) courseGroupId = rows[0].course_group_id;
  }

  return {
    deliveryMode: ogConfig ? ogConfig.deliveryMode : classConfig ? classConfig.deliveryMode : null,
    campusId: ogConfig ? ogConfig.campusId : classConfig ? classConfig.campusId : null,
    academicPeriodId: currentPeriod ? currentPeriod.id : null,
    courseGroupId,
    operationalGroupId: ogConfig ? ogConfig.operationalGroupId : null,
  };
}

/* ---------------------------------------------------------------------
   v39 — Operational Groups (ABRS v2.2 §11; resolves Appendix Item A-9).

   An Operational Group is a Programme Run (learning_instances) child
   that exists only to organize operational delivery (§11.1) — it is NOT
   a Programme Level (that remains `classes`), NOT a Participation
   Structure, NOT a Course. Its overridable fields (§11.3) are limited
   exactly to what the Programme Run itself already owns today: Tuition
   Fee, Capacity, Instructor, Delivery Mode, Campus, and an optional
   registration Closing Date — see migrate.js's v39 comment for why the
   other §11.3-named fields (Venue, Schedule, Meeting Days/Times,
   Waitlist Capacity) are intentionally absent from this list.

   §11.4: Promotion (routes/promotion.js) never calls anything in this
   section, and nothing in this section ever writes to `classes` or
   `users.class_id` — that is Promotion's/Programme Level's ownership
   exclusively (§13, §19). §11.4 also requires Operational Group
   reassignment to be its own action, distinct from Promotion — see
   routes/enrolments.js's PATCH /:id/operational-group.
   --------------------------------------------------------------------- */

// The complete, exhaustive set of Operational Group override columns —
// exported so routes/learningInstances.js's validation can never drift
// from this list (single source of truth for "what may be overridden").
const OPERATIONAL_GROUP_OVERRIDE_FIELDS = ["feeGHS", "capacity", "instructorId", "deliveryMode", "campusId", "registrationDeadline"];

function toOperationalGroupDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    learningInstanceId: row.learning_instance_id,
    name: row.name,
    displayLabel: row.display_label,
    sortOrder: row.sort_order,
    isActive: !!row.is_active,
    overrides: {
      feeGHS: row.fee_ghs != null ? row.fee_ghs : null,
      capacity: row.capacity != null ? row.capacity : null,
      instructorId: row.instructor_id || null,
      deliveryMode: row.delivery_mode || null,
      campusId: row.campus_id || null,
      registrationDeadline: row.registration_deadline || null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Every Operational Group belonging to one Programme Run, ordered for
// display. Includes inactive (retired) groups only when requested, so
// historical Enrollment/Reporting reads (§11.4, §21) can still resolve a
// retired group's name/overrides while active pickers (registration,
// admin "assign group" UI) default to hiding them.
function getOperationalGroupsForInstance(instanceId, { includeInactive = false } = {}) {
  const rows = includeInactive
    ? db.prepare("SELECT * FROM operational_groups WHERE learning_instance_id = ? ORDER BY sort_order ASC, name ASC").all(instanceId)
    : db.prepare("SELECT * FROM operational_groups WHERE learning_instance_id = ? AND is_active = 1 ORDER BY sort_order ASC, name ASC").all(instanceId);
  return rows.map(toOperationalGroupDto);
}

function getOperationalGroupById(id) {
  const row = db.prepare("SELECT * FROM operational_groups WHERE id = ?").get(id);
  return row ? toOperationalGroupDto(row) : null;
}

function getOperationalGroupRow(id) {
  return db.prepare("SELECT * FROM operational_groups WHERE id = ?").get(id);
}

// Validates that an override value is legal against its parent Programme
// Run's OWN configuration (§11.3: an Operational Group's override is
// meaningless, and rejected, if it names something the Run itself never
// declared — e.g. a Delivery Mode the Run didn't activate, a Campus the
// Run didn't select). Returns an error string, or null if valid.
function validateOperationalGroupOverrides(instanceRow, { deliveryMode, campusId, instructorId }) {
  if (deliveryMode !== undefined && deliveryMode !== null) {
    const allowed = parseJsonArray(instanceRow.delivery_modes);
    if (!allowed.length || !allowed.includes(deliveryMode)) {
      return `deliveryMode must be one of this Programme Run's own configured delivery modes: ${allowed.join(", ") || "(none configured)"}.`;
    }
  }
  if (campusId !== undefined && campusId !== null) {
    const allowed = parseJsonArray(instanceRow.campus_ids);
    if (!allowed.length || !allowed.includes(campusId)) {
      return "campusId must be one of this Programme Run's own configured campuses.";
    }
  }
  if (instructorId !== undefined && instructorId !== null) {
    const instructor = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'instructor'").get(instructorId);
    if (!instructor) return "instructorId does not match a known instructor.";
  }
  return null;
}

function createOperationalGroup(instanceId, { name, displayLabel, sortOrder, feeGHS, capacity, instructorId, deliveryMode, campusId, registrationDeadline }) {
  const instanceRow = db.prepare("SELECT * FROM learning_instances WHERE id = ?").get(instanceId);
  if (!instanceRow) throw Object.assign(new Error("Programme Run not found."), { status: 404 });
  if (!name || !String(name).trim()) throw Object.assign(new Error("name is required."), { status: 400 });

  const validationError = validateOperationalGroupOverrides(instanceRow, { deliveryMode, campusId, instructorId });
  if (validationError) throw Object.assign(new Error(validationError), { status: 400 });

  const id = uuid();
  try {
    db.prepare(
      `INSERT INTO operational_groups
         (id, learning_instance_id, name, display_label, sort_order, fee_ghs, capacity, instructor_id, delivery_mode, campus_id, registration_deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      instanceId,
      String(name).trim(),
      displayLabel || null,
      Number.isFinite(sortOrder) ? sortOrder : 0,
      feeGHS === undefined || feeGHS === null || feeGHS === "" ? null : Number(feeGHS),
      capacity === undefined || capacity === null || capacity === "" ? null : Number(capacity),
      instructorId || null,
      deliveryMode || null,
      campusId || null,
      registrationDeadline || null
    );
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      throw Object.assign(new Error("An Operational Group with this name already exists for this Programme Run."), { status: 409 });
    }
    throw e;
  }
  return getOperationalGroupById(id);
}

// Patch semantics match every other resolver in this file: a key that is
// `undefined` in `patch` leaves the column unchanged; a key explicitly
// set to `null` clears the override back to "inherit from Programme
// Run" (§11.3's read-time-resolution rule) — never guessed, never
// backfilled.
function updateOperationalGroup(id, patch) {
  const row = getOperationalGroupRow(id);
  if (!row) throw Object.assign(new Error("Operational Group not found."), { status: 404 });
  const instanceRow = db.prepare("SELECT * FROM learning_instances WHERE id = ?").get(row.learning_instance_id);

  const next = {
    name: patch.name !== undefined ? String(patch.name).trim() : row.name,
    displayLabel: patch.displayLabel !== undefined ? patch.displayLabel || null : row.display_label,
    sortOrder: patch.sortOrder !== undefined ? Number(patch.sortOrder) : row.sort_order,
    feeGHS: patch.feeGHS !== undefined ? (patch.feeGHS === null || patch.feeGHS === "" ? null : Number(patch.feeGHS)) : row.fee_ghs,
    capacity: patch.capacity !== undefined ? (patch.capacity === null || patch.capacity === "" ? null : Number(patch.capacity)) : row.capacity,
    instructorId: patch.instructorId !== undefined ? patch.instructorId || null : row.instructor_id,
    deliveryMode: patch.deliveryMode !== undefined ? patch.deliveryMode || null : row.delivery_mode,
    campusId: patch.campusId !== undefined ? patch.campusId || null : row.campus_id,
    registrationDeadline: patch.registrationDeadline !== undefined ? patch.registrationDeadline || null : row.registration_deadline,
    isActive: patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : row.is_active,
  };
  if (!next.name) throw Object.assign(new Error("name is required."), { status: 400 });

  const validationError = validateOperationalGroupOverrides(instanceRow, {
    deliveryMode: patch.deliveryMode !== undefined ? next.deliveryMode : undefined,
    campusId: patch.campusId !== undefined ? next.campusId : undefined,
    instructorId: patch.instructorId !== undefined ? next.instructorId : undefined,
  });
  if (validationError) throw Object.assign(new Error(validationError), { status: 400 });

  try {
    db.prepare(
      `UPDATE operational_groups
       SET name = ?, display_label = ?, sort_order = ?, fee_ghs = ?, capacity = ?, instructor_id = ?,
           delivery_mode = ?, campus_id = ?, registration_deadline = ?, is_active = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(next.name, next.displayLabel, next.sortOrder, next.feeGHS, next.capacity, next.instructorId, next.deliveryMode, next.campusId, next.registrationDeadline, next.isActive, id);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      throw Object.assign(new Error("An Operational Group with this name already exists for this Programme Run."), { status: 409 });
    }
    throw e;
  }
  return getOperationalGroupById(id);
}

// Retirement, not deletion — mirrors the Draft/Active/Retired lifecycle
// discipline used elsewhere (§12.2) and the existing `is_active` pattern
// (campuses.active, learning_offering_types.is_active): a group that has
// ever had an Enrollment assigned to it must remain readable so
// historical records and Reporting (§21) continue to resolve correctly
// (mirrors §12.2's Retired-Participation-Structure rule). A group with no
// Enrollment history at all may still be hard-deleted, since nothing
// depends on it existing.
function retireOrDeleteOperationalGroup(id) {
  const row = getOperationalGroupRow(id);
  if (!row) throw Object.assign(new Error("Operational Group not found."), { status: 404 });
  const enrollmentCount = db.prepare("SELECT COUNT(*) AS c FROM programme_enrollments WHERE operational_group_id = ?").get(id).c;
  if (enrollmentCount > 0) {
    db.prepare("UPDATE operational_groups SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    return { retired: true, deleted: false, enrollmentCount };
  }
  db.prepare("DELETE FROM operational_groups WHERE id = ?").run(id);
  return { retired: false, deleted: true, enrollmentCount: 0 };
}

// Resolves the EFFECTIVE configuration for one Operational Group: each
// §11.3 field is the Group's own override if it has set one, otherwise
// falls through to its parent Programme Run's configuration
// (getInstanceOperationalConfig) — single-level override only, exactly
// as §11.3 specifies ("never a merge... beyond the one-level override
// described here").
function resolveOperationalGroupConfig(operationalGroupOrId) {
  const row = typeof operationalGroupOrId === "string" ? getOperationalGroupRow(operationalGroupOrId) : operationalGroupOrId;
  if (!row) return null;
  const instanceConfig = getInstanceOperationalConfig(row.learning_instance_id);

  return {
    operationalGroupId: row.id,
    instanceId: row.learning_instance_id,
    name: row.name,
    deliveryMode: row.delivery_mode || (instanceConfig && instanceConfig.deliveryModes.length === 1 ? instanceConfig.deliveryModes[0] : null),
    campusId: row.campus_id || (instanceConfig && instanceConfig.campusIds.length === 1 ? instanceConfig.campusIds[0] : null),
    feeGHS: row.fee_ghs != null ? row.fee_ghs : instanceConfig ? instanceConfig.feeGHS : null,
    capacity: row.capacity != null ? row.capacity : instanceConfig ? instanceConfig.capacity : null,
    instructorId: row.instructor_id || (instanceConfig ? instanceConfig.instructorId : null),
    registrationDeadline: row.registration_deadline || null,
    instanceConfig,
  };
}

// The single resolver every NEW read path (fees.js, registration,
// reporting) should call to get a learner's effective operational
// configuration — supersedes resolveClassOperationalConfig() for any
// Enrollment that has actually been assigned an Operational Group.
// `enrollmentRow` is a raw `programme_enrollments` row (or any object
// carrying operational_group_id/class_id). Falls back to the legacy
// Class-level resolution for an Enrollment with no Operational Group
// (either because its Programme Run has none, or because it predates
// this migration and wasn't backfilled) — this is the only remaining
// caller of resolveClassOperationalConfig() and is what keeps every
// pre-v39 Enrollment resolving exactly as it did before.
function resolveEnrollmentOperationalConfig(enrollmentRow, classRow) {
  if (enrollmentRow && enrollmentRow.operational_group_id) {
    const config = resolveOperationalGroupConfig(enrollmentRow.operational_group_id);
    if (config) return config;
  }
  const resolvedClassRow = classRow || (enrollmentRow && enrollmentRow.class_id ? db.prepare("SELECT * FROM classes WHERE id = ?").get(enrollmentRow.class_id) : null);
  const legacy = resolveClassOperationalConfig(resolvedClassRow);
  return { ...legacy, operationalGroupId: null, capacity: legacy.instanceConfig ? legacy.instanceConfig.capacity : null, instructorId: legacy.instanceConfig ? legacy.instanceConfig.instructorId : null };
}

// Checks operational group or learning instance capacity for registration.
// Returns { ok: true/false, capacity, occupied, remaining, error }.
function checkOperationalGroupCapacity(operationalGroupId, instanceId, requestedSeats = 1) {
  let capacity = null;
  if (operationalGroupId) {
    const targetGroup = resolveOperationalGroupConfig(operationalGroupId);
    if (targetGroup) {
      capacity = targetGroup.capacity;
    }
  }
  if (capacity == null && instanceId) {
    const instanceConfig = getInstanceOperationalConfig(instanceId);
    if (instanceConfig) {
      capacity = instanceConfig.capacity;
    }
  }

  if (capacity == null) {
    return { ok: true, capacity: null, occupied: 0, remaining: null };
  }

  let occupied = 0;
  if (operationalGroupId) {
    const row = db.prepare("SELECT COUNT(*) AS count FROM programme_enrollments WHERE operational_group_id = ? AND status IN ('active', 'pending_payment')").get(operationalGroupId);
    occupied = row ? row.count : 0;
  } else if (instanceId) {
    const row = db.prepare("SELECT COUNT(*) AS count FROM programme_enrollments WHERE learning_instance_id = ? AND status IN ('active', 'pending_payment')").get(instanceId);
    occupied = row ? row.count : 0;
  }

  const remaining = Math.max(0, capacity - occupied);
  if (occupied + requestedSeats > capacity) {
    return {
      ok: false,
      error: "Operational Group capacity reached.",
      capacity,
      occupied,
      remaining,
    };
  }

  return { ok: true, capacity, occupied, remaining };
}


/* ---------------------------------------------------------------------
   Transcript labeling — added for the "Transcript Learning Instance
   separation" continuation milestone. A transcript's per-module row
   (utils/transcriptEngine.js's moduleResult, read by routes/grades.js'
   GET /:userId/transcript) is computed from up to four source tables
   (grades, examination_attempts, ca_attempts, assignment_submissions),
   each of which was tagged with its own learning_instance_id at write
   time (see the Enrolments/Payments/.../Certificates integration
   milestone). This reads those same four tables back — read-only,
   nothing here writes — to say which run(s) actually produced this
   row's data, so the transcript can label it (or flag it as spanning
   more than one run) instead of silently merging history across runs.
   --------------------------------------------------------------------- */
function distinctInstanceIdsForCourse(userId, courseId, termId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT learning_instance_id AS id FROM grades
         WHERE user_id = ? AND course_id = ? AND (term_id = ? OR term_id IS NULL) AND learning_instance_id IS NOT NULL
       UNION
       SELECT DISTINCT ea.learning_instance_id AS id FROM examination_attempts ea
         JOIN examinations e ON e.id = ea.examination_id
         WHERE ea.user_id = ? AND e.course_id = ? AND (ea.term_id = ? OR ea.term_id IS NULL) AND ea.learning_instance_id IS NOT NULL
       UNION
       SELECT DISTINCT a.learning_instance_id AS id FROM ca_attempts a
         JOIN continuous_assessments c ON c.id = a.assessment_id
         WHERE a.user_id = ? AND c.course_id = ? AND (a.term_id = ? OR a.term_id IS NULL) AND a.learning_instance_id IS NOT NULL
       UNION
       SELECT DISTINCT s.learning_instance_id AS id FROM assignment_submissions s
         JOIN notes n ON n.id = s.note_id
         WHERE s.user_id = ? AND n.course_id = ? AND (s.term_id = ? OR s.term_id IS NULL) AND s.learning_instance_id IS NOT NULL
       UNION
       SELECT DISTINCT learning_instance_id AS id FROM progress
         WHERE user_id = ? AND course_id = ? AND (term_id = ? OR term_id IS NULL) AND learning_instance_id IS NOT NULL AND quiz_score IS NOT NULL
       UNION
       SELECT DISTINCT learning_instance_id AS id FROM projects
         WHERE user_id = ? AND course_id = ? AND (term_id = ? OR term_id IS NULL) AND learning_instance_id IS NOT NULL AND mark IS NOT NULL`
    )
    .all(
      userId, courseId, termId,
      userId, courseId, termId,
      userId, courseId, termId,
      userId, courseId, termId,
      userId, courseId, termId,
      userId, courseId, termId
    );
  return rows.map((r) => r.id);
}

// Returns a label object for one module/term's transcript row:
// - { instance: null, mixed: false }                          — no
//   underlying record carries a learning_instance_id yet (predates
//   Learning Instances for this Module, or none configured).
// - { instance: {...dto}, mixed: false }                      — every
//   contributing record agrees on exactly one run; safe to label plainly.
// - { instance: null, mixed: true, instances: [{...dto}, ...] }
//   — records disagree (e.g. a midterm from one run, an end-of-term
//   retake from a later one) — the transcript must show all of them
//   labeled rather than silently picking or blending one.
function getCourseInstanceLabel(userId, courseId, termId) {
  const ids = distinctInstanceIdsForCourse(userId, courseId, termId);
  if (!ids.length) return { instance: null, mixed: false };
  if (ids.length === 1) return { instance: getLearningInstanceById(ids[0]), mixed: false };
  return { instance: null, mixed: true, instances: ids.map(getLearningInstanceById).filter(Boolean) };
}

// ---------------------------------------------------------------------
// Instructor Portal scoping (ABRS v2.2 §8.2 — Instructor Assignment is a
// Programme Run-owned concept). Since the constitutional remediation, an
// instructor IS directly assigned to specific Learning Instances (see
// server/src/utils/instructorScope.js / the instructor_assignments
// table) — that's the single source of truth this function now reads,
// rather than inferring Programme/Module ownership from separate,
// Run-unaware tables. Read-only; used to scope GET /api/learning-
// instances for the instructor role, and to validate a client-supplied
// programmeId/courseId/learningInstanceId belongs to that same set before
// trusting it in a write.
// ---------------------------------------------------------------------
function instructorProgrammeAndCourseIds(instructorId) {
  const { getInstructorInstanceIds, getInstructorCourseIds } = require("./instructorScope");
  const instanceIds = getInstructorInstanceIds(instructorId);
  const courseIds = new Set(getInstructorCourseIds(instructorId));
  const programmeIds = new Set();
  if (instanceIds.length) {
    db.prepare(`SELECT DISTINCT programme_id FROM learning_instances WHERE id IN (${instanceIds.map(() => "?").join(",")}) AND programme_id IS NOT NULL`)
      .all(...instanceIds)
      .forEach((r) => programmeIds.add(r.programme_id));
  }
  return { programmeIds, courseIds, instanceIds: new Set(instanceIds) };
}

// True if the given Learning Instance is one this instructor is directly
// assigned to (instructor_assignments) — the "prevent instructors from
// accessing records belonging to other Learning Instances" check, applied
// wherever a client supplies a learningInstanceId/programmeId/courseId
// directly.
function instanceBelongsToInstructor(instructorId, instance) {
  if (!instance) return false;
  const { instructorHasInstanceAccess } = require("./instructorScope");
  return instructorHasInstanceAccess(instructorId, instance.id);
}

// True if `instanceId` targets `courseId` — either directly (legacy/simple
// single-course Runs, where learning_instances.course_id is the Course
// itself) or via the multi-target model (learning_instance_targets), which
// is how a Programme-wide Run (learning_instances.course_id IS NULL, one
// row per Course it actually offers) is associated with any one of its
// Courses. getActiveInstancesForCourse — which is what builds the
// "eligible Learning Instance" list instructors are actually offered when
// authoring a Note/Examination/Continuous Assessment — already resolves
// eligibility this way; every caller that then validates an explicitly
// submitted learningInstanceId must agree with that same definition, or a
// Run the UI legitimately offered gets rejected as "doesn't belong to this
// module" the moment the instructor submits it.
function instanceTargetsCourse(instanceId, courseId) {
  if (!instanceId || !courseId) return false;
  return !!db.prepare(`SELECT 1 FROM learning_instance_targets WHERE learning_instance_id = ? AND course_id = ? LIMIT 1`).get(instanceId, courseId);
}

// Returns the learning_instance_id recorded on the learner's primary (or
// programme-specific) programme_enrollment — the authoritative billing and
// curriculum Run once an enrollment exists. Never re-resolves to the
// currently-active Run for that Programme.
function getEnrolledLearningInstanceIdForLearner(userId, { programmeId = null } = {}) {
  if (!userId) return null;
  if (programmeId) {
    const row = db
      .prepare(
        `SELECT learning_instance_id FROM programme_enrollments
         WHERE user_id = ? AND programme_id = ? AND learning_instance_id IS NOT NULL
         ORDER BY is_primary DESC, created_at DESC LIMIT 1`
      )
      .get(userId, programmeId);
    return row ? row.learning_instance_id : null;
  }
  const primary = db
    .prepare("SELECT learning_instance_id FROM programme_enrollments WHERE user_id = ? AND is_primary = 1 LIMIT 1")
    .get(userId);
  return primary && primary.learning_instance_id ? primary.learning_instance_id : null;
}

// Offering types whose learner curriculum is resolved from Run-scoped
// learning_instance_courses assignments (not legacy class/course-group
// expansion). Bootcamp and Corporate Training share this path with Adult
// Professional — one reusable Course entity assigned per Learning Instance.
const RUN_SCOPED_CURRICULUM_SLUGS = new Set(["adult_professional", "bootcamp", "corporate_training"]);

function usesRunScopedCourseCurriculum(offeringTypeSlug) {
  return RUN_SCOPED_CURRICULUM_SLUGS.has(offeringTypeSlug);
}

function getOfferingTypeSlugForInstance(instance) {
  if (!instance || !instance.offeringTypeId) return null;
  const row = db.prepare("SELECT slug FROM learning_offering_types WHERE id = ?").get(instance.offeringTypeId);
  return row ? row.slug : null;
}

// True when the learner's enrollment on this Run belongs to an Adult
// Professional Programme (learning_offering_types.slug = adult_professional).
function isAdultProfessionalEnrollment(userId, learningInstanceId) {
  const enrollment = db
    .prepare(
      `SELECT pe.programme_id FROM programme_enrollments pe
       WHERE pe.user_id = ? ${learningInstanceId ? "AND pe.learning_instance_id = ?" : ""}
       ORDER BY pe.is_primary DESC, pe.created_at DESC LIMIT 1`
    )
    .get(userId, ...(learningInstanceId ? [learningInstanceId] : []));
  if (!enrollment || !enrollment.programme_id) return false;
  const row = db
    .prepare(
      `SELECT t.slug FROM programmes p
       JOIN learning_offering_types t ON t.id = p.offering_type_id
       WHERE p.id = ?`
    )
    .get(enrollment.programme_id);
  return !!(row && row.slug === "adult_professional");
}

// Adult Professional / Programme-Run curriculum resolver. Courses come from
// the learner's enrollment selections and the Run's own configured targets —
// never from class_id → course_group_courses (structured level mapping).
function resolveRunConfiguredCourseCurriculum(userId, learningInstanceId) {
  if (!userId || !learningInstanceId) return [];
  const courseIds = new Set();

  const enrollment = db
    .prepare(
      `SELECT id, requested_course_ids FROM programme_enrollments
       WHERE user_id = ? AND learning_instance_id = ?
       ORDER BY is_primary DESC, created_at DESC LIMIT 1`
    )
    .get(userId, learningInstanceId);
  if (enrollment) {
    db.prepare("SELECT course_id FROM programme_enrollment_courses WHERE programme_enrollment_id = ?")
      .all(enrollment.id)
      .forEach((r) => courseIds.add(r.course_id));
    try {
      JSON.parse(enrollment.requested_course_ids || "[]").forEach((cid) => {
        if (cid) courseIds.add(cid);
      });
    } catch (e) {
      /* ignore malformed JSON */
    }
  }

  const instance = getLearningInstanceById(learningInstanceId);
  if (instance) {
    if (instance.courseId) courseIds.add(instance.courseId);
    db.prepare(
      "SELECT course_id FROM learning_instance_courses WHERE learning_instance_id = ? AND (status IS NULL OR status = 'active')"
    )
      .all(learningInstanceId)
      .forEach((r) => courseIds.add(r.course_id));
    getInstanceTargets(learningInstanceId).forEach((t) => {
      if (t.courseId) courseIds.add(t.courseId);
    });
  }

  return Array.from(courseIds);
}

// Returns course ids configured for a Run that an admin may assign to a
// learner enrolled on that Run (Programme targets + activated courses).
function getEligibleCoursesForRun(learningInstanceId, programmeId) {
  if (!learningInstanceId) return [];
  const courseIds = new Set();
  const instance = getLearningInstanceById(learningInstanceId);
  if (instance) {
    if (instance.courseId) courseIds.add(instance.courseId);
    db.prepare(
      "SELECT course_id FROM learning_instance_courses WHERE learning_instance_id = ? AND (status IS NULL OR status = 'active')"
    )
      .all(learningInstanceId)
      .forEach((r) => courseIds.add(r.course_id));
    getInstanceTargets(learningInstanceId).forEach((t) => {
      if (t.courseId) courseIds.add(t.courseId);
    });
  }
  // Legacy fallback for Builders' Lab / Kids STEM only — Bootcamp, Adult
  // Professional, and Corporate Training must not inherit every programme-
  // scoped Course when no Run assignment exists (that would break per-
  // instance Course isolation).
  if (programmeId && !courseIds.size && instance) {
    const slug = getOfferingTypeSlugForInstance(instance);
    if (!usesRunScopedCourseCurriculum(slug)) {
      db.prepare("SELECT id FROM courses WHERE programme_id = ?").all(programmeId).forEach((r) => courseIds.add(r.id));
    }
  }
  return Array.from(courseIds);
}

// STRUCTURED CURRICULUM CONSTANTS — the two structured Builders' Lab
// participation structures that use the Programme Level × Academic Period
// curriculum matrix. Individual Course and non-Builders'-Lab programmes
// are explicitly excluded from this path.
const STRUCTURED_PARTICIPATION_STRUCTURES = new Set(["structured_school_club", "structured_other"]);

// Returns true if the learner's primary (or most relevant) programme_enrollment
// for the given learningInstanceId is a structured Builders' Lab journey.
//
// ACCESS_RESTRICTED state-mismatch fix (BOOTCAMP — INVALID STRUCTURE
// ALLOWED + LEARNER RESTRICTED): before the Bootcamp participation-structure
// scoping fix above existed, a Bootcamp Learning Instance/enrolment could
// end up with a stale structured_school_club/structured_other value on
// programme_enrollments.participation_structure. That misidentified the
// enrolment as a structured Builders' Lab journey to every caller of this
// function — most importantly syncPeriodCourseEnrollments's period-target
// resolution (see activateEnrollmentCurriculum below), which for a
// "structured" enrolment calls resolveStructuredCourseCurriculum instead
// of the correct Run-scoped resolver. resolveStructuredCourseCurriculum
// requires a course_group_id — a Kids STEM/Builders' Lab-only concept a
// Bootcamp enrolment never has — and silently returns no courses when
// it's absent, so a fully paid, active/current Bootcamp learner ended up
// with zero assigned coursework: indistinguishable from "restricted" in
// the portal even though accessRestriction() (account/payment status) was
// itself correct. Bootcamp is never a structured journey, full stop —
// checked here (not just at the write path) so this also self-heals any
// legacy row already carrying a stale structured_* value. Scoped by
// offering-type slug so Kids STEM/Adult Professional/Corporate Training
// behaviour is completely unaffected.
function isStructuredJourneyEnrollment(userId, learningInstanceId) {
  const instance = getLearningInstanceById(learningInstanceId);
  if (instance && getOfferingTypeSlugForInstance(instance) === "bootcamp") return false;
  const row = db
    .prepare(
      `SELECT participation_structure FROM programme_enrollments
       WHERE user_id = ? AND learning_instance_id = ?
       ORDER BY is_primary DESC, created_at DESC LIMIT 1`
    )
    .get(userId, learningInstanceId);
  return !!(row && STRUCTURED_PARTICIPATION_STRUCTURES.has(row.participation_structure));
}

// Returns the primary programme_enrollment for the given user + learningInstanceId
// scoped to a structured Builders' Lab participation, or null if none exists.
// This is the authoritative source for course_group_id — never guessed from
// existing enrollments.
function getStructuredProgrammeEnrollment(userId, learningInstanceId) {
  return db
    .prepare(
      `SELECT id, user_id, class_id, course_group_id, learning_instance_id, participation_structure
       FROM programme_enrollments
       WHERE user_id = ? AND learning_instance_id = ?
         AND participation_structure IN ('structured_school_club', 'structured_other')
       ORDER BY is_primary DESC, created_at DESC LIMIT 1`
    )
    .get(userId, learningInstanceId);
}

// Level-based structured curriculum resolver.
// For a learner on a structured Builders' Lab journey:
//   - Reads course_group_id DIRECTLY from programme_enrollments.
//   - Resolves current level (users.class_id or enrollment.class_id).
//   - Returns ALL courses configured for that Course Group at that Level.
//   - Academic periods control access entitlement (when access is active),
//     while the level determines the curriculum (what courses belong to the level).
//
// Returns [] if no structured enrollment exists or no courses are configured.
function resolveStructuredCourseCurriculum(userId, learningInstanceId) {
  const enrollment = getStructuredProgrammeEnrollment(userId, learningInstanceId);
  if (!enrollment || !enrollment.course_group_id) return [];

  const learner = db.prepare("SELECT class_id FROM users WHERE id = ?").get(userId);
  const classId = (learner && learner.class_id) || enrollment.class_id;
  if (!classId) return [];

  const courseIds = db
    .prepare(
      `SELECT DISTINCT course_id FROM course_group_courses
       WHERE course_group_id = ? AND class_id = ?
       ORDER BY sort_order ASC`
    )
    .all(enrollment.course_group_id, classId)
    .map((r) => r.course_id);
  return courseIds;
}

// Builders' Lab Course Group/Class curriculum mapping (course_group_courses
// table) had a full admin CRUD API (routes/courses.js) but — verified by
// reading every write path — was never actually consulted anywhere a
// learner's module set gets decided (registration, promotion). This left
// "a Course Group presents Module A/B at Foundation, C/D at Framework" as
// admin-editable data with no effect. This is the read side of closing
// that gap: given a learner and the class they're now in, resolve which
// additional modules their existing Course Group(s) say belong at that class.
//
// Deliberately additive-only (never removes/replaces an existing module
// enrolment) to match this codebase's "preserve all previous academic
// history" rule for anything promotion touches (see routes/promotion.js's
// header comment) — a learner's Course Group is inferred from the Modules
// they are ALREADY enrolled in that carry a course_group_id, not
// overwritten here.
//
// NOTE (Phase 1): This function is NOT called for structured Builders' Lab
// journeys during period-aware activation or promotion. Those paths use
// resolveStructuredCourseCurriculum instead. This function remains in use
// for non-structured programmes and backward-compatible pathways.
function resolveCourseCurriculumForClass(userId, classId) {
  if (!classId) return [];
  const courseGroupIds = db
    .prepare(
      `SELECT DISTINCT m.course_group_id AS course_group_id
       FROM enrollments e
       JOIN courses m ON m.id = e.course_id
       WHERE e.user_id = ? AND m.course_group_id IS NOT NULL`
    )
    .all(userId)
    .map((r) => r.course_group_id);
  if (!courseGroupIds.length) return [];

  const courseIds = new Set();
  const stmt = db.prepare("SELECT course_id FROM course_group_courses WHERE course_group_id = ? AND class_id = ?");
  courseGroupIds.forEach((courseGroupId) => {
    stmt.all(courseGroupId, classId).forEach((r) => courseIds.add(r.course_id));
  });
  return Array.from(courseIds);
}

// Applies curriculum resolution after a Programme Level change (promotion).
// Callers (routes/promotion.js) run this right after moving class_id.
//
// For STRUCTURED Builders' Lab journeys (structured_school_club or
// structured_other): only grants courses up to the learner's CURRENT
// Academic Period sequence, preventing future-period courses from being
// granted during a mid-year promotion. The learner's active programme
// enrollment provides the learning_instance_id to identify the current period.
//
// For ALL OTHER journeys: falls back to resolveCourseCurriculumForClass
// (the legacy approach using existing enrollments to find course groups),
// preserving prior behaviour exactly.
function syncCourseCurriculumForClass(userId, classId) {
  const insert = db.prepare("INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)");
  const added = [];

  // Look for an active structured enrollment on any currently-active Run
  // for this user. If found, use the period-safe resolver.
  const structuredEnrollment = db
    .prepare(
      `SELECT pe.learning_instance_id
       FROM programme_enrollments pe
       WHERE pe.user_id = ?
         AND pe.participation_structure IN ('structured_school_club', 'structured_other')
         AND pe.status = 'active'
       ORDER BY pe.is_primary DESC, pe.created_at DESC LIMIT 1`
    )
    .get(userId);

  if (structuredEnrollment && structuredEnrollment.learning_instance_id) {
    const courseIds = resolveStructuredCourseCurriculum(userId, structuredEnrollment.learning_instance_id);
    courseIds.forEach((courseId) => {
      const info = insert.run(userId, courseId);
      if (info.changes > 0) added.push(courseId);
    });
    return added;
  }

  // Non-structured or unresolvable — legacy class-based resolver.
  const courseIds = resolveCourseCurriculumForClass(userId, classId);
  courseIds.forEach((courseId) => {
    const info = insert.run(userId, courseId);
    if (info.changes > 0) added.push(courseId);
  });
  return added;
}

// Term/Semester-scoped auto-enrollment for structured Programme Runs
// (Instructor Assignment/Enrollment remediation). When a Learning
// Instance has an academic structure configured (learning_instances.
// academic_structure / learning_instance_academic_periods, Phase 4/5), a
// learner is auto-enrolled into a period's Courses under these rules:
//   - Period 1 (the first term/semester) is always eligible the moment
//     activation happens at all — matching this codebase's existing
//     "activation grants what's been configured so far" behavior.
//   - Every later period is only eligible once it has actually begun
//     (its sequence is <= the Run's currently-resolved period, via
//     getCurrentAcademicPeriod's date-based resolution) AND that
//     period's own payment requirement is satisfied (utils/
//     periodPayments.js — the SAME machinery that already gates CONTENT
//     access for an unpaid period, required lazily here to avoid a
//     circular require since periodPayments.js itself reads from this
//     module).
// This only ever creates the enrollment ROW (so instructors/gradebooks/
// listings immediately reflect it, per the AUTHORIZATION requirements
// above); it never bypasses evaluatePeriodAccess's own independent
// content-gate, which keeps enforcing the same payment requirement at
// the content layer regardless of whether an enrollment row exists.
// Additive-only (INSERT OR IGNORE) and idempotent, same as its siblings.
// Instances with no academic structure configured return [] immediately
// — nothing here changes behavior for those; they rely entirely on the
// requestedCourseIds/class-curriculum steps in activateEnrollmentCurriculum
// below, unchanged.
function syncPeriodCourseEnrollments(userId, learningInstanceId) {
  if (!userId || !learningInstanceId) return [];
  const instance = getLearningInstanceById(learningInstanceId);
  if (!instance || !instance.academicStructure) return [];
  const periods = (instance.academicPeriods || []).slice().sort((a, b) => a.sequence - b.sequence);
  if (!periods.length) return [];

  const { getPeriodPaymentStatus } = require("./periodPayments");
  const current = getCurrentAcademicPeriod(instance);
  const currentSequence = current ? current.sequence : 1;
  const learner = db.prepare("SELECT class_id FROM users WHERE id = ?").get(userId);
  const insert = db.prepare("INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)");
  const granted = new Set();

  // Detect if this user has a structured Builders' Lab enrollment on this Run,
  // so the programme-target path uses the level-based resolver instead of
  // legacy class resolution.
  const isStructured = isStructuredJourneyEnrollment(userId, learningInstanceId);

  periods.forEach((period) => {
    if (period.sequence !== 1) {
      if (period.sequence > currentSequence) return; // hasn't begun yet
      const status = getPeriodPaymentStatus(userId, instance, period);
      if (!status.satisfied) return; // this period's own payment isn't in yet
    }

    const targets = getPeriodTargets(period.id);
    const courseIds = new Set();
    targets.forEach((t) => {
      if (t.courseId) {
        courseIds.add(t.courseId);
      } else if (t.programmeId && learner && learner.class_id) {
        if (isStructured) {
          // STRUCTURED JOURNEY: resolve all courses configured for the learner's current level
          resolveStructuredCourseCurriculum(userId, learningInstanceId)
            .forEach((cid) => courseIds.add(cid));
        } else if (
          usesRunScopedCourseCurriculum(getOfferingTypeSlugForInstance(instance))
        ) {
          // Bootcamp / Adult Professional / Corporate Training — Run-assigned
          // Courses only; never class/course-group expansion.
          resolveRunConfiguredCourseCurriculum(userId, learningInstanceId).forEach((cid) => courseIds.add(cid));
        } else {
          // Other non-structured journeys: legacy class/course-group behaviour.
          resolveCourseCurriculumForClass(userId, learner.class_id).forEach((cid) => courseIds.add(cid));
        }
      }
    });
    if (!targets.length && period.sequence === 1) {
      // Not configured yet — fall back to this Run's own top-level
      // resolution (its own Course for a Course-type Run, or every
      // active Activated Course), the same "unconfigured = unrestricted"
      // rule isTargetActiveInCurrentPeriod/evaluatePeriodAccess apply.
      if (instance.courseId) courseIds.add(instance.courseId);
      db.prepare("SELECT course_id FROM learning_instance_courses WHERE learning_instance_id = ? AND status = 'active'")
        .all(learningInstanceId)
        .forEach((r) => courseIds.add(r.course_id));
    }

    courseIds.forEach((courseId) => {
      const info = insert.run(userId, courseId);
      if (info.changes > 0) granted.add(courseId);
    });
  });

  return Array.from(granted);
}

// Enrollment Activation — the single point (utils/paymentActivation.js's
// activateSuccessfulPayment, and the Hub access-override grant in
// routes/users.js) where a Registration's expressed INTENT to enrol
// becomes actual Module access. Registration itself never calls this —
// it only records what was requested (programme_enrollments.
// requested_course_ids, routes/auth.js/routes/users.js) and creates the
// account in a non-accessing state (pending_payment/unpaid), exactly the
// same "no access until activation" state every other pending enrolment
// already lives in.
//
// Three steps, in order:
//   1. Grant whatever specific module(s) the learner/parent actually
//      picked at registration (requestedCourseIds) — this is the
//      learner's own selection, not something curriculum-mapping can
//      derive on its own for a brand-new enrolment with no prior module
//      history to infer a Course Group from. This is also the entire
//      story for an individual (non-structured) Course enrollment: the
//      learner is auto-assigned to that one Course as soon as this step
//      runs, i.e. immediately after their payment activates it.
//   2. Reuse syncCourseCurriculumForClass — the EXACT function
//      routes/promotion.js already calls when a learner's class changes
//      — so that, once step 1 has given the learner at least one
//      Course-Group-linked module, any other module their now-known
//      Course Group's curriculum mapping (course_group_courses) assigns
//      to their current Class is granted too. Promotion and activation
//      therefore always resolve curriculum through the identical mapping;
//      nothing about Course Group/Class curriculum resolution is
//      reimplemented here.
//   3. For a structured Programme Run (an academic_structure/Term-
//      Semester breakdown configured), additionally run
//      syncPeriodCourseEnrollments so the learner is auto-enrolled into
//      the first term/semester's Courses now, and into any later
//      term/semester's Courses automatically once that term begins and
//      its own payment requirement is met (see that function's own
//      comment) — without requiring admin intervention for the normal
//      case, and without ever bypassing the existing payment-gated
//      content restriction for a period that hasn't been paid for.
//
// Additive-only (INSERT OR IGNORE, same as syncCourseCurriculumForClass)
// and idempotent — safe to call more than once for the same activation
// event (e.g. a webhook retry, or a later term beginning), and harmless
// to call for an account with nothing pending (returns an empty list).
function activateEnrollmentCurriculum(userId, classId, requestedCourseIds, learningInstanceId) {
  const granted = new Set();

  // Step 1 — grant explicitly requested courses (Individual Course uses ONLY
  // this step; structured journeys also use this if a seed course was picked).
  if (Array.isArray(requestedCourseIds) && requestedCourseIds.length) {
    const insert = db.prepare("INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)");
    requestedCourseIds.forEach((courseId) => {
      const info = insert.run(userId, courseId);
      if (info.changes > 0) granted.add(courseId);
    });
  }

  // Check enrollment participation structure to ensure Individual Course
  // registrations never receive unselected courses from class/level mapping.
  const enrollmentRow = db
    .prepare(
      `SELECT participation_structure FROM programme_enrollments
       WHERE user_id = ? ${learningInstanceId ? "AND learning_instance_id = ?" : ""}
       ORDER BY is_primary DESC, created_at DESC LIMIT 1`
    )
    .get(userId, ...(learningInstanceId ? [learningInstanceId] : []));

  const participationStructure = enrollmentRow ? enrollmentRow.participation_structure : null;
  const isIndividualCourse = participationStructure === "individual_course";

  // Step 2 — Individual Course journeys MUST NEVER run class-curriculum expansion.
  // Structured Builders' Lab journeys also skip legacy class-wide sync (handled in Step 3).
  // Legacy non-individual journeys retain class-curriculum sync for backward compatibility.
  const isStructured =
    learningInstanceId && isStructuredJourneyEnrollment(userId, learningInstanceId);
  const instanceForCurriculum = learningInstanceId ? getLearningInstanceById(learningInstanceId) : null;
  const usesRunScoped =
    instanceForCurriculum && usesRunScopedCourseCurriculum(getOfferingTypeSlugForInstance(instanceForCurriculum));
  if (usesRunScoped && learningInstanceId) {
    // Bootcamp / Adult Professional / Corporate Training — Run-assigned
    // Courses only; never legacy class/course-group expansion.
    const insert = db.prepare("INSERT OR IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)");
    resolveRunConfiguredCourseCurriculum(userId, learningInstanceId).forEach((courseId) => {
      const info = insert.run(userId, courseId);
      if (info.changes > 0) granted.add(courseId);
    });
  } else if (!isStructured && !isIndividualCourse && classId) {
    syncCourseCurriculumForClass(userId, classId).forEach((m) => granted.add(m));
  }

  // Step 3 — period-aware auto-enrollment (for structured journeys).
  // Individual Course journeys do NOT auto-enroll class/level curriculum by period.
  if (learningInstanceId && !isIndividualCourse) {
    syncPeriodCourseEnrollments(userId, learningInstanceId).forEach((m) => granted.add(m));
  }

  return Array.from(granted);
}

module.exports = {
  LEARNING_INSTANCE_STATUSES,
  ALLOWED_TRANSITIONS,
  // Builders' Lab participation structures (v29)
  PARTICIPATION_STRUCTURES,
  isParticipationStructureAllowedForOfferingType,
  isValidParticipationStructure,
  // ABRS v2.1 Phase 5 prerequisite — Programme-owned config (§10, A-1)
  getProgrammeParticipationStructures,
  resolveParticipationStructureConfig,
  getEffectiveProgrammeParticipationStructures,
  resolveEntryLevelForProgramme,
  ensureProgrammeParticipationStructure,
  ensureLearningInstanceParticipationStructureActivation,
  LEARNING_INSTANCE_SELECT,
  isValidStatus,
  toLearningInstanceDto,
  getAssignedInstructorsForInstance,
  // Admin Workflow Redesign — Programme Run completion/publish-readiness
  computeLearningInstanceWorkflowStatus,
  getLearningInstanceById,
  getLearnerLearningInstances,
  resolveCourseOfferingTypeId,
  validateOfferingTypeAssociation,
  findActiveInstanceConflict,
  findActiveInstanceConflictForTargets,
  assertTransitionAllowed,
  getActiveInstanceForProgramme,
  getActiveInstancesForProgramme,
  getActiveInstancesForCourse,
  resolveActiveInstanceForRegistration,
  isCourseAvailableForIndividualCourseOffering,
  getActiveInstanceForCourse,
  programmeHasActiveInstance,
  courseHasActiveInstance,
  isInstanceOpenForActivity,
  getActiveInstanceIdForProgramme,
  getActiveInstanceIdForCourse,
  getActiveInstanceIdForClass,
  getCourseInstanceLabel,
  instructorProgrammeAndCourseIds,
  instanceBelongsToInstructor,
  instanceTargetsCourse,
  // Multi-target model (Stage 4C/4E)
  getInstanceTargets,
  toTargetDto,
  syncTargetStatuses,
  addTarget,
  removeTarget,
  // Academic Structure per Learning Instance (Phase 4)
  ACADEMIC_STRUCTURES,
  ACADEMIC_STRUCTURE_PERIOD_COUNTS,
  isValidAcademicStructure,
  getAcademicPeriods,
  getAcademicPeriodById,
  toAcademicPeriodDto,
  setAcademicStructure,
  updateAcademicPeriod,
  // Period-specific target configuration (Phase 5)
  getPeriodTargets,
  setPeriodTargets,
  getLearnerActiveTargetsInPeriod,
  // Period-specific payment requirements & enforcement (Phase 6)
  setPeriodPaymentRequirement,
  isCombinedFirstPeriod,
  clearStaleFirstPeriodPaymentConfigIfCombined,
  getCurrentAcademicPeriod,
  resolveCombinedPeriodCharge,
  getEffectivePeriodPaymentRequirement,
  // ABRS v2.2 Compliance Remediation — Programme Run -> Academic Period ->
  // Academic Term (§8.2/§13.1/§19). The single, constitutional term
  // resolution path for every term-scoped route.
  resolveConstitutionalTermId,
  resolveConstitutionalTermIdForCourse,
  resolveConstitutionalTermIdForClass,
  isTargetActiveInCurrentPeriod,
  // Structured Builders' Lab curriculum (Phase 1)
  STRUCTURED_PARTICIPATION_STRUCTURES,
  isStructuredJourneyEnrollment,
  getStructuredProgrammeEnrollment,
  resolveStructuredCourseCurriculum,
  // Course/Class curriculum mapping resolution (promotion — item 3/9)
  resolveCourseCurriculumForClass,
  syncCourseCurriculumForClass,
  // Enrollment Activation (registration -> payment/waiver -> curriculum)
  activateEnrollmentCurriculum,
  syncPeriodCourseEnrollments,
  getEnrolledLearningInstanceIdForLearner,
  isAdultProfessionalEnrollment,
  usesRunScopedCourseCurriculum,
  getOfferingTypeSlugForInstance,
  isBootcampOfferingType,
  resolveRunConfiguredCourseCurriculum,
  getEligibleCoursesForRun,
  assignCourseToInstance,
  deactivateCourseFromInstance,
  // Programme Run operational ownership (v31)
  getInstanceOperationalConfig,
  resolveClassOperationalConfig,
  deriveEnrollmentOperationalSnapshot,
  // Registration Window ownership (v32)
  isInstanceRegistrationConfigured,
  isInstanceRegistrationOpen,
  resolveProgrammeRegistrationOpen,
  getProgrammeRegistrationWindow,
  // Activated Courses / normalized course selections (Phase 3 Checkpoint 3a)
  ensureActivatedCourse,
  recordEnrollmentCourseSelections,
  // Activated Courses (Phase 3 Checkpoint 3b)
  getActivatedCourseForInstance,
  // Activated Courses admin UI (Phase 5 prerequisite 2)
  getActivatedCoursesForInstance,
  updateActivatedCourse,
  // Operational Groups (v39, ABRS v2.2 §11 / Appendix A-9)
  OPERATIONAL_GROUP_OVERRIDE_FIELDS,
  toOperationalGroupDto,
  getOperationalGroupsForInstance,
  getOperationalGroupById,
  getOperationalGroupRow,
  createOperationalGroup,
  updateOperationalGroup,
  retireOrDeleteOperationalGroup,
  resolveOperationalGroupConfig,
  resolveEnrollmentOperationalConfig,
  checkOperationalGroupCapacity,
};
