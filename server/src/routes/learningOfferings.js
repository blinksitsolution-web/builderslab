const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requireRole, requirePermission } = require("../middleware/auth");
const { parseSettings, serializeSettings, resolveTriState, deepMerge, DEFAULT_SETTINGS, programmeAllowsSelfRegistration, offeringTypeAllowsSelfRegistration, offeringTypeRequiresCourseSelectionAtRegistration, programmeAllowsAudience } = require("../utils/offeringTypeSettings");
const { getProgrammeParticipationStructures } = require("../utils/learningInstances");
const {
  getActiveInstanceForProgramme,
  getActiveInstancesForProgramme,
  getInstanceOperationalConfig,
  getCurrentAcademicPeriod,
  toAcademicPeriodDto,
  PARTICIPATION_STRUCTURES,
  resolveProgrammeRegistrationOpen,
  getProgrammeRegistrationWindow,
  getEffectiveProgrammeParticipationStructures,
  resolveEntryLevelForProgramme,
  getOperationalGroupsForInstance,
  usesRunScopedCourseCurriculum,
} = require("../utils/learningInstances");

const router = express.Router();

const REPORT_OUTPUT_MODES = ["certificate_only", "attendance_only", "transcript_and_certificate"];

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/* ===========================================================
   Learning Offering Types
   Admin-manageable catalogue — new types (beyond the four seeded
   in migrate.js) can be added here with zero code changes.
   =========================================================== */
function toOfferingType(row) {
  const settings = parseSettings(row.settings);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    icon: row.icon,
    color: row.color,
    // Legacy flat fields — still populated (derived from settings) so any
    // older code path reading them directly keeps working unchanged.
    requiresParent: !!row.requires_parent,
    learningGroupLabel: row.learning_group_label,
    isActive: !!row.is_active,
    sortOrder: row.sort_order,
    // Full configurable behaviour. This is what routes throughout the LMS
    // should consult (via utils/offeringTypeSettings.js) instead of
    // hardcoding per-offering-type conditions.
    settings,
  };
}

// `requires_parent` is kept in sync with settings.enrollment.parentAccountRequired
// (treating "optional" as not-required) purely for backward compatibility
// with any pre-existing SQL that still reads the plain column.
function syncLegacyColumns(id, settings) {
  const requiresParent = resolveTriState(settings.enrollment.parentAccountRequired, false) ? 1 : 0;
  db.prepare("UPDATE learning_offering_types SET requires_parent = ? WHERE id = ?").run(requiresParent, id);
}

// Public: Learning Offerings for the landing page's "Featured Learning
// Offerings" section (and any Enrol button that needs to know where a given
// offering's registration flow lives). Unauthenticated by design — same
// pattern as GET /api/settings/public and GET /api/modules/campuses/list.
// Types marked landing.featureLevel = "hidden" are excluded entirely; the
// rest are returned with "featured" ones first, so the frontend doesn't
// need to know the sorting rule.
router.get("/types/public", (req, res) => {
  const rows = db.prepare("SELECT * FROM learning_offering_types WHERE is_active = 1").all();
  const offerings = rows
    .map(toOfferingType)
    .filter((t) => t.settings.landing.featureLevel !== "hidden")
    .sort((a, b) => {
      const rank = (t) => (t.settings.landing.featureLevel === "featured" ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (a.settings.landing.sortOrder ?? 0) - (b.settings.landing.sortOrder ?? 0);
    })
    .map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      icon: t.icon,
      color: t.color,
      description: t.description,
      featureLevel: t.settings.landing.featureLevel,
      tagline: t.settings.landing.tagline,
      landingDescription: t.settings.landing.description,
      imagePath: t.settings.landing.imagePath,
      features: t.settings.landing.features,
      enrolButtonText: t.settings.landing.enrolButtonText,
      enrolDestination: t.settings.landing.enrolDestination,
      enrolOpenBehavior: t.settings.landing.enrolOpenBehavior,
      enrolVisible: t.settings.landing.enrolVisible,
    }));
  res.json({ offerings });
});

// Public: Offering Types available for the *registration* flow specifically.
// Deliberately NOT filtered by landing.featureLevel/enrolVisible — those
// only control the landing page's "Featured Learning Offerings" cards. An
// offering type an admin hides from that section (or simply hasn't
// configured a landing card for yet) must still be selectable here, or a
// brand-new Learning Offering Type's Programmes would have no way to ever
// appear on the public registration form. Only gated on is_active and
// enrollment.selfRegistrationAllowed (Corporate Training-style types an
// admin enrolls people into directly via POST /users/participants are
// correctly excluded by that flag). Includes the enrollment routing info
// (parentAccountRequired) the registration page needs to decide whether an
// offering belongs under "Parent + Child" or "Adult learner".
router.get("/types/registration", (req, res) => {
  const rows = db.prepare("SELECT * FROM learning_offering_types WHERE is_active = 1 ORDER BY sort_order ASC, name ASC").all();
  const offerings = rows
    .map(toOfferingType)
    .filter((t) => offeringTypeAllowsSelfRegistration(t))
    .map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      icon: t.icon,
      color: t.color,
      description: t.description,
      learningGroupLabel: t.learningGroupLabel,
      parentAccountRequired: t.settings.enrollment.parentAccountRequired,
      // ABRS v2.1 Phase 1 audit, Category 1: replaces the frontend's own
      // `slug === "kids_stem"` check (RegisterPage.jsx) for whether this
      // offering's classic flow requires selecting individual Courses.
      requiresCourseSelectionAtRegistration: offeringTypeRequiresCourseSelectionAtRegistration(t),
    }));
  res.json({ offerings });
});

router.get("/types", requireAuth, (req, res) => {
  let sql = "SELECT * FROM learning_offering_types";
  if (req.query.all !== "true") sql += " WHERE is_active = 1";
  sql += " ORDER BY sort_order ASC, name ASC";
  const rows = db.prepare(sql).all();
  res.json({ offeringTypes: rows.map(toOfferingType) });
});

// Returns the full default settings schema (with blank/default values) so
// the Admin UI can render every configurable option for a brand-new type
// without hardcoding the option list on the frontend either.
router.get("/types/settings-schema", requireAuth, requirePermission("offeringTypes.view", "offeringTypes.create", "offeringTypes.edit"), (req, res) => {
  res.json({ settings: DEFAULT_SETTINGS });
});

router.get("/types/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM learning_offering_types WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Learning Offering Type not found." });
  res.json(toOfferingType(row));
});

router.post("/types", requireAuth, requirePermission("offeringTypes.create"), (req, res) => {
  const { name, description, icon, color, learningGroupLabel, sortOrder, settings } = req.body;
  if (!name) return res.status(400).json({ error: "name is required." });
  const slug = slugify(name);
  if (db.prepare("SELECT id FROM learning_offering_types WHERE name = ? OR slug = ?").get(name, slug)) {
    return res.status(409).json({ error: "A Learning Offering Type with this name already exists." });
  }
  const id = uuid();
  const mergedSettings = parseSettings(JSON.stringify(settings || {}));
  db.prepare(
    `INSERT INTO learning_offering_types (id, name, slug, description, icon, color, requires_parent, learning_group_label, sort_order, settings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    slug,
    description || null,
    icon || null,
    color || "#8B5E3C",
    resolveTriState(mergedSettings.enrollment.parentAccountRequired, false) ? 1 : 0,
    learningGroupLabel || "Class",
    sortOrder ?? 0,
    serializeSettings(mergedSettings)
  );
  res.json(toOfferingType(db.prepare("SELECT * FROM learning_offering_types WHERE id = ?").get(id)));
});

router.patch("/types/:id", requireAuth, requirePermission("offeringTypes.edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM learning_offering_types WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Learning Offering Type not found." });
  const { name, description, icon, color, learningGroupLabel, sortOrder, settings } = req.body;
  // Deep-merge: a PATCH can send just the section(s) it changed (e.g. only
  // `payments`) without wiping out the rest of the configuration.
  const mergedSettings = settings !== undefined ? { ...parseSettings(row.settings) } : parseSettings(row.settings);
  const nextSettings = settings !== undefined ? deepMerge(mergedSettings, settings) : mergedSettings;
  db.prepare(
    `UPDATE learning_offering_types SET name=?, description=?, icon=?, color=?, requires_parent=?, learning_group_label=?, sort_order=?, settings=? WHERE id=?`
  ).run(
    name ?? row.name,
    description ?? row.description,
    icon ?? row.icon,
    color ?? row.color,
    resolveTriState(nextSettings.enrollment.parentAccountRequired, false) ? 1 : 0,
    learningGroupLabel ?? row.learning_group_label,
    sortOrder ?? row.sort_order,
    serializeSettings(nextSettings),
    req.params.id
  );
  res.json(toOfferingType(db.prepare("SELECT * FROM learning_offering_types WHERE id = ?").get(req.params.id)));
});

router.post("/types/:id/activate", requireAuth, requirePermission("offeringTypes.edit"), (req, res) => {
  const result = db.prepare("UPDATE learning_offering_types SET is_active = 1 WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Learning Offering Type not found." });
  res.json({ ok: true });
});

router.post("/types/:id/deactivate", requireAuth, requirePermission("offeringTypes.edit"), (req, res) => {
  const result = db.prepare("UPDATE learning_offering_types SET is_active = 0 WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Learning Offering Type not found." });
  res.json({ ok: true });
});

/* ===========================================================
   Corporate Clients (Corporate Training only, e.g. "MTN Ghana")
   =========================================================== */
function toCorporateClient(row) {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    logoPath: row.logo_path,
    defaultReportOutputMode: row.default_report_output_mode,
    isActive: !!row.is_active,
  };
}

router.get("/corporate-clients", requireAuth, requirePermission("corporateClients.view"), (req, res) => {
  let sql = "SELECT * FROM corporate_clients";
  if (req.query.all !== "true") sql += " WHERE is_active = 1";
  sql += " ORDER BY name ASC";
  res.json({ corporateClients: db.prepare(sql).all().map(toCorporateClient) });
});

router.post("/corporate-clients", requireAuth, requirePermission("corporateClients.create"), (req, res) => {
  const { name, contactName, contactEmail, contactPhone, defaultReportOutputMode } = req.body;
  if (!name) return res.status(400).json({ error: "name is required." });
  if (defaultReportOutputMode && !REPORT_OUTPUT_MODES.includes(defaultReportOutputMode)) {
    return res.status(400).json({ error: `defaultReportOutputMode must be one of: ${REPORT_OUTPUT_MODES.join(", ")}` });
  }
  if (db.prepare("SELECT id FROM corporate_clients WHERE name = ?").get(name)) {
    return res.status(409).json({ error: "A corporate client with this name already exists." });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO corporate_clients (id, name, contact_name, contact_email, contact_phone, default_report_output_mode)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, name, contactName || null, contactEmail || null, contactPhone || null, defaultReportOutputMode || "certificate_only");
  res.json(toCorporateClient(db.prepare("SELECT * FROM corporate_clients WHERE id = ?").get(id)));
});

router.patch("/corporate-clients/:id", requireAuth, requirePermission("corporateClients.edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM corporate_clients WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Corporate client not found." });
  const { name, contactName, contactEmail, contactPhone, defaultReportOutputMode } = req.body;
  if (defaultReportOutputMode && !REPORT_OUTPUT_MODES.includes(defaultReportOutputMode)) {
    return res.status(400).json({ error: `defaultReportOutputMode must be one of: ${REPORT_OUTPUT_MODES.join(", ")}` });
  }
  db.prepare(
    `UPDATE corporate_clients SET name=?, contact_name=?, contact_email=?, contact_phone=?, default_report_output_mode=? WHERE id=?`
  ).run(
    name ?? row.name,
    contactName ?? row.contact_name,
    contactEmail ?? row.contact_email,
    contactPhone ?? row.contact_phone,
    defaultReportOutputMode ?? row.default_report_output_mode,
    req.params.id
  );
  res.json(toCorporateClient(db.prepare("SELECT * FROM corporate_clients WHERE id = ?").get(req.params.id)));
});

router.post("/corporate-clients/:id/activate", requireAuth, requirePermission("corporateClients.edit"), (req, res) => {
  const result = db.prepare("UPDATE corporate_clients SET is_active = 1 WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Corporate client not found." });
  res.json({ ok: true });
});

router.post("/corporate-clients/:id/deactivate", requireAuth, requirePermission("corporateClients.edit"), (req, res) => {
  const result = db.prepare("UPDATE corporate_clients SET is_active = 0 WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Corporate client not found." });
  res.json({ ok: true });
});

// Logo upload reuses the same "branding" folder as avatars/branding (see
// routes/users.js, routes/campusBranding.js) — kept local to this route
// since only corporate clients/programmes need a logo/image upload here.
// `verifyLogo` checks real file content (magic bytes) against
// png/jpeg/webp after upload, not just the client-supplied mimetype.
const { createUploadPipeline } = require("../middleware/upload");
const { upload: logoUpload, verify: verifyLogo } = createUploadPipeline("IMAGE", "branding", 8);

router.post("/corporate-clients/:id/logo", requireAuth, requirePermission("corporateClients.edit"), logoUpload.single("logo"), verifyLogo, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const logoPath = `/uploads/branding/${req.file.filename}`;
  const result = db.prepare("UPDATE corporate_clients SET logo_path = ? WHERE id = ?").run(logoPath, req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Corporate client not found." });
  res.json({ ok: true, logoPath });
});

/* ===========================================================
   Programmes — the actual course/offering a learner registers for
   (Builders Lab, Robotics, Python Programming, an MTN Ghana workshop, ...)
   =========================================================== */
function toProgramme(row) {
  return {
    id: row.id,
    offeringTypeId: row.offering_type_id,
    offeringTypeName: row.offering_type_name,
    offeringTypeSlug: row.offering_type_slug,
    corporateClientId: row.corporate_client_id,
    corporateClientName: row.corporate_client_name,
    name: row.name,
    durationLabel: row.duration_label,
    // Resolved label a Learning Group under this programme should display as,
    // falling back through programme override -> offering type default.
    learningGroupLabel: row.learning_group_label || row.offering_type_default_label,
    reportOutputMode: row.report_output_mode || row.corporate_default_report_output_mode || null,
    isActive: !!row.is_active,
    sortOrder: row.sort_order,
    // Public display / eligibility / registration-window fields — mainly
    // used by the Bootcamp registration tab, but available to every
    // programme (no offering-type-specific code path required).
    imagePath: row.image_path || null,
    longDescription: row.long_description || null,
    projects: row.projects ? (() => { try { return JSON.parse(row.projects); } catch (e) { return []; } })() : [],
    eligibilityAudience: row.eligibility_audience || "both",
    startsAt: row.starts_at || null,
    endsAt: row.ends_at || null,
    // Registration Window ownership belongs exclusively to the Programme
    // Run (§8.2/§16 — Single Ownership Principle). The Programme itself
    // no longer stores or resolves these fields; they're read here
    // purely for display, sourced from whichever Run is currently Active
    // for this Programme. See utils/learningInstances.js
    // getProgrammeRegistrationWindow()/resolveProgrammeRegistrationOpen().
    ...getProgrammeRegistrationWindow(row.id),
    registrationOpen: resolveProgrammeRegistrationOpen(row),
  };
}

// ABRS v2.1 Admin Workflow Redesign checkpoint — Programme Definition
// workflow (Learning Offering Type -> Programme -> Course Library ->
// Participation Structure Definitions -> Programme Levels where
// applicable -> Programme Definition Complete). Purely informational:
// read by the admin UI (ProgrammeModal) to show whether a Programme is
// fully defined before any admin creates a Programme Run for it. Never
// blocks or alters Programme Run creation/activation itself — that stays
// governed entirely by the existing, separate Programme Run publish-
// readiness gate (computeLearningInstanceWorkflowStatus in
// utils/learningInstances.js), which this checkpoint does not touch.
function computeProgrammeDefinitionStatus({ hasCourses, participationStructures, hasLearningGroups }) {
  // Whether this Programme needs Programme Levels at all is read from its
  // own Participation Structure configuration (usesProgrammeLevels), never
  // from a hardcoded programme/offering-type name (ABRS v2.1 §2.2) — a
  // Programme with no Participation Structure requiring progression simply
  // never shows this step as applicable.
  const needsProgrammeLevels = participationStructures.some((s) => s.usesProgrammeLevels);
  const steps = [
    { id: "offeringType", label: "Learning Offering Type", applicable: true, complete: true },
    { id: "programme", label: "Programme", applicable: true, complete: true },
    { id: "courseLibrary", label: "Course Library", applicable: true, complete: !!hasCourses },
    { id: "participationStructures", label: "Participation Structure Definitions", applicable: true, complete: participationStructures.length > 0 },
    { id: "programmeLevels", label: "Programme Levels", applicable: needsProgrammeLevels, complete: needsProgrammeLevels ? !!hasLearningGroups : true },
  ];
  const missingSteps = steps.filter((s) => s.applicable && !s.complete).map((s) => s.label);
  return { steps, complete: missingSteps.length === 0, missingSteps };
}

// Single place this "does this Programme use Programme Levels" question is
// answered (reused by the Programmes list route and, via the participation
// structures already fetched, the Programme detail route below) so the
// admin table's button label and the Batches/Cohorts/Programme Levels
// modal it opens can never disagree about which term applies to a given
// Programme (ABRS v2.1 §2.1 Single Ownership).
function programmeUsesProgrammeLevels(programmeId) {
  return getProgrammeParticipationStructures(programmeId).some((s) => s.usesProgrammeLevels);
}

const PROGRAMME_SELECT = `
  SELECT p.*, t.name as offering_type_name, t.slug as offering_type_slug,
         t.learning_group_label as offering_type_default_label,
         cc.name as corporate_client_name, cc.default_report_output_mode as corporate_default_report_output_mode
  FROM programmes p
  JOIN learning_offering_types t ON t.id = p.offering_type_id
  LEFT JOIN corporate_clients cc ON cc.id = p.corporate_client_id
`;

// Public: active programmes under one Offering Type, for the public
// self-registration flow (an adult picking a Programme before an account —
// and therefore a session — exists yet). Mirrors GET /types/public: same
// toProgramme()/PROGRAMME_SELECT the authenticated admin endpoint below
// uses, just unauthenticated and pared down to registration-relevant fields.
// Only Offering Types with enrollment.selfRegistrationAllowed !== false are
// exposed here — Corporate Training programmes admins create participants
// for directly still simply won't appear on the public registration page.
// Registration Experience Redesign — Choose Programme step. offeringTypeId/
// offeringTypeSlug are now OPTIONAL filters rather than a required
// parameter: omitting both returns every currently self-registrable,
// registration-open Programme across every active Learning Offering Type,
// which is what "Choose Programme" (the redesigned registration flow's
// actual first step — see RegisterPage.jsx) needs in a single call instead
// of first forcing an Offering Type pick. Every existing caller that does
// pass one of the two keeps getting exactly the same scoped result it
// always has.
router.get("/programmes/public", (req, res) => {
  const { offeringTypeId, offeringTypeSlug, audience } = req.query;
  let sql = PROGRAMME_SELECT + " WHERE p.is_active = 1 AND t.is_active = 1";
  const params = [];
  if (offeringTypeId) { sql += " AND p.offering_type_id = ?"; params.push(offeringTypeId); }
  if (offeringTypeSlug) { sql += " AND t.slug = ?"; params.push(offeringTypeSlug); }
  sql += " ORDER BY p.sort_order ASC, p.name ASC";
  const rows = db.prepare(sql).all(...params);
  const programmes = rows
    .map(toProgramme)
    .filter((p) => programmeAllowsSelfRegistration(p.id))
    .filter((p) => p.registrationOpen)
    .filter((p) => !audience || programmeAllowsAudience({ eligibility_audience: p.eligibilityAudience }, audience))
    .map((p) => ({
      id: p.id,
      name: p.name,
      durationLabel: p.durationLabel,
      learningGroupLabel: p.learningGroupLabel,
      imagePath: p.imagePath,
      longDescription: p.longDescription,
      projects: p.projects,
      eligibilityAudience: p.eligibilityAudience,
      registrationOpensAt: p.registrationOpensAt,
      registrationDeadline: p.registrationDeadline,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      // Offering Type identity — needed once this route can return
      // Programmes spanning more than one Offering Type in a single call
      // (see the comment above); harmless additive fields for every
      // existing caller that already scopes by offeringTypeId/Slug.
      offeringTypeId: p.offeringTypeId,
      offeringTypeName: p.offeringTypeName,
      offeringTypeSlug: p.offeringTypeSlug,
    }));
  res.json({ programmes });
});

// GET /api/learning-offerings/programme-runs/registration-config?programmeId=<id>
// v31 — ONE configuration endpoint the registration frontend can call
// instead of assembling registration rules from several scattered
// endpoints/derived-from-Classes logic. Given a Programme, resolves its
// current ACTIVE Programme Run (Learning Instance) and returns everything
// needed to progressively render registration for it: available Delivery
// Modes, eligible Campuses, Fee, whether Installments are enabled,
// Participation Structures, and Academic Structure/current Period — all
// sourced from the Run itself (see utils/learningInstances.js
// getInstanceOperationalConfig), not derived by scanning Classes.
// hasActiveRun: false (with everything else null/empty) is a normal,
// expected response for a Programme with no Active run configured yet —
// callers should treat that the same as "registration not available for
// this Programme right now", not as an error.
router.get("/programme-runs/registration-config", (req, res) => {
  const { programmeId, instanceId } = req.query;
  if (!programmeId) return res.status(400).json({ error: "programmeId is required." });
  const programme = db.prepare(PROGRAMME_SELECT + " WHERE p.id = ?").get(programmeId);
  if (!programme) return res.status(404).json({ error: "Programme not found." });

  // ABRS v2.2 amendment (concurrent Programme Runs): a Programme may now
  // have more than one Active Run. If the caller already knows which one
  // it wants (instanceId — set once the frontend's "choose a run" step
  // has resolved a choice), use that directly. Otherwise, resolve exactly
  // as before UNLESS there's more than one Active Run, in which case we
  // can't silently pick one — return the list of options instead so the
  // frontend can ask, then re-call this same endpoint with instanceId set.
  // This keeps the response shape, and every existing caller's behaviour,
  // completely unchanged for the still-overwhelmingly-common case of a
  // Programme with 0 or 1 Active Runs.
  let instance;
  if (instanceId) {
    const candidates = getActiveInstancesForProgramme(programmeId);
    instance = candidates.find((c) => c.id === instanceId) || null;
    if (!instance) return res.status(400).json({ error: "instanceId is not a currently Active Run for this programme." });
  } else {
    const candidates = getActiveInstancesForProgramme(programmeId);
    if (candidates.length > 1) {
      return res.json({
        hasActiveRun: false,
        multipleActiveRuns: true,
        programmeId,
        programmeName: programme.name,
        offeringTypeId: programme.offering_type_id,
        activeRuns: candidates.map((c) => ({ id: c.id, name: c.name })),
      });
    }
    instance = candidates[0] || null;
  }
  if (!instance) {
    return res.json({
      hasActiveRun: false,
      programmeId,
      programmeName: programme.name,
      offeringTypeId: programme.offering_type_id,
      // participationStructures: the historical flat, platform-wide enum
      // (kept only for callers that predate the Registration Experience
      // Redesign — no current in-repo client reads this field; the
      // registration frontend consumes participationStructureOptions
      // below, which is the one properly Programme/offering-type-scoped,
      // authoritative list). Never treat this raw field as authoritative:
      // it is not scoped to this Programme's offering type and, unlike
      // participationStructureOptions, cannot say whether e.g.
      // individual_course is actually valid here.
      participationStructures: PARTICIPATION_STRUCTURES,
      participationStructureOptions: getEffectiveProgrammeParticipationStructures(programmeId),
      entryLevel: resolveEntryLevelForProgramme(programmeId),
      operationalGroups: [],
    });
  }

  const offeringType = db.prepare("SELECT * FROM learning_offering_types WHERE id = ?").get(instance.offeringTypeId);
  const typeSettings = offeringType ? parseSettings(offeringType.settings) : DEFAULT_SETTINGS;
  const opConfig = getInstanceOperationalConfig(instance.id);
  // Installments: the Run's own explicit override, else the Offering
  // Type's configured default — same tri-state fallback pattern used
  // throughout offeringTypeSettings.js.
  const installmentsEnabled =
    opConfig.installmentsEnabled != null ? opConfig.installmentsEnabled : resolveTriState(typeSettings.payments && typeSettings.payments.installmentsAllowed, true);
  const currentPeriod = getCurrentAcademicPeriod(instance);

  // Registration-time Participation Structure lock: a Learning Instance
  // (Run) that has already been configured with its own Participation
  // Structure (instance.participationStructure — set by an admin when the
  // Run was created/edited, e.g. "WIS 2026" configured as
  // structured_school_club) is NOT a menu a registrant should be choosing
  // from at all — that choice was already made administratively for this
  // specific Run. Presenting every one of the Programme's other
  // Participation Structures alongside it (e.g. Individual Course) lets a
  // parent pick a structure the Run was never set up to run, which then
  // breaks downstream assumptions (resolveActiveInstanceForRegistration,
  // resolveEntryClass, promotion/period-payment logic all trust that a
  // Run's registrants share its one configured structure). So once this
  // Run has a configured structure, participationStructureOptions is
  // narrowed to just that single entry — still sourced from the
  // Programme's own effective list (never re-invented here) so its
  // flags (usesProgrammeLevels/requiresCourseSelection/etc.) stay
  // authoritative. A Run with no structure configured yet
  // (participationStructure: null — every pre-v29 Run) keeps seeing the
  // Programme's full menu exactly as before; nothing changes for that
  // still-common case.
  const effectiveParticipationStructures = getEffectiveProgrammeParticipationStructures(programmeId);
  const runParticipationStructureOptions = instance.participationStructure
    ? effectiveParticipationStructures.filter((s) => s.key === instance.participationStructure)
    : effectiveParticipationStructures;

  res.json({
    hasActiveRun: true,
    instanceId: instance.id,
    instanceName: instance.name,
    programmeId,
    programmeName: programme.name,
    offeringTypeId: instance.offeringTypeId,
    offeringTypeSlug: offeringType ? offeringType.slug : null,
    offeringTypeName: offeringType ? offeringType.name : null,
    // Delivery Modes/Campuses this Run is configured for. An empty array
    // means the Run hasn't configured these at the Run level yet — the
    // frontend should fall back to deriving them from GET /api/classes/
    // public (which itself already resolves through the Run — see
    // routes/classes.js), exactly as it does today.
    deliveryModes: opConfig.deliveryModes,
    campuses: opConfig.campuses,
    feeGHS: opConfig.feeGHS,
    installmentsEnabled,
    capacity: opConfig.capacity,
    // Participation Structures — the historical fixed, platform-wide enum
    // (unchanged field, kept for existing callers), plus, additively, the
    // Registration Experience Redesign's config-driven equivalent: this
    // Programme's own Participation Structures (§10.2), each carrying the
    // flags (usesProgrammeLevels, requiresCourseSelection, registrantRole,
    // autoAssignsEntryLevel, usesLongTermEnrollment) the registration
    // frontend needs to progressively disclose the right fields and never
    // let a parent choose a Programme Level (§11.2) — read from
    // getEffectiveProgrammeParticipationStructures so this always agrees
    // with the Programme's own admin-managed configuration wherever one
    // exists (§2.1 Single Ownership), falling back to the same legacy
    // metadata only when the Programme has none defined yet. Narrowed to
    // this specific Run's own configured structure when it has one — see
    // runParticipationStructureOptions above.
    participationStructures: PARTICIPATION_STRUCTURES,
    participationStructureOptions: runParticipationStructureOptions,
    // Informational only — the Programme Level a structured learner would
    // be auto-assigned into (§11.2: parents never choose one). Present
    // regardless of which Participation Structure ends up selected; the
    // frontend only surfaces it for structures where usesProgrammeLevels
    // is true.
    entryLevel: resolveEntryLevelForProgramme(programmeId),
    runParticipationStructure: instance.participationStructure,
    academicStructure: instance.academicStructure,
    currentAcademicPeriod: currentPeriod ? toAcademicPeriodDto(currentPeriod) : null,
    // Registration Window ownership belongs exclusively to the Programme
    // Run (§8.2/§16). registrationOpen resolves solely from this Run's
    // own window (unconfigured = open by default); the raw fields below
    // describe that same window.
    registrationOpen: resolveProgrammeRegistrationOpen(programme),
    registrationWindowConfigured: instance.registrationWindowConfigured,
    registrationOpensAt: instance.registrationOpensAt,
    registrationDeadline: instance.registrationDeadline,
    registrationForceClosed: instance.registrationForceClosed,
    registrationForceOpen: instance.registrationForceOpen,
    // v39 — this Run's active Operational Groups, if any (§11/§17/§18: a
    // registrant may optionally pick a batch/cohort/section at
    // registration time — never a Programme Level, which stays entirely
    // Promotion's/Entry Level's own territory, §11.2). An empty array is
    // the normal, expected response for a Run with none configured — the
    // frontend should treat that the same as "nothing to pick here",
    // exactly like every other optional field on this payload. Overrides
    // are included (they're not sensitive) so the registration UI can
    // show a group's own Fee/Delivery Mode/Campus without a second call.
    operationalGroups: getOperationalGroupsForInstance(instance.id),
  });
});

router.get("/programmes", requireAuth, (req, res) => {
  const { offeringTypeId, offeringTypeSlug, corporateClientId } = req.query;
  let sql = PROGRAMME_SELECT + " WHERE 1=1";
  const params = [];
  if (offeringTypeId) { sql += " AND p.offering_type_id = ?"; params.push(offeringTypeId); }
  if (offeringTypeSlug) { sql += " AND t.slug = ?"; params.push(offeringTypeSlug); }
  if (corporateClientId) { sql += " AND p.corporate_client_id = ?"; params.push(corporateClientId); }
  if (req.query.all !== "true") sql += " AND p.is_active = 1";
  sql += " ORDER BY p.sort_order ASC, p.name ASC";
  const programmes = db
    .prepare(sql)
    .all(...params)
    .map(toProgramme)
    .map((p) => ({ ...p, usesProgrammeLevels: programmeUsesProgrammeLevels(p.id) }));
  res.json({ programmes });
});

router.get("/programmes/:id", requireAuth, (req, res) => {
  const row = db.prepare(PROGRAMME_SELECT + " WHERE p.id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Programme not found." });
  // Delivery Mode (On-Campus vs Online) — additive fields only; every
  // existing field/shape below is unchanged. deliveryMode/campusId are
  // null for legacy/unspecified classes (see migrate.js's classes.
  // delivery_mode/campus_id); campusName is resolved here so the admin
  // Learning Group modal can display it without a second round-trip.
  const learningGroups = db
    .prepare(
      `SELECT c.id, c.name, c.display_label, c.fee_ghs, c.delivery_mode, c.campus_id, cm.name as campus_name
       FROM classes c
       LEFT JOIN campuses cm ON cm.id = c.campus_id
       WHERE c.programme_id = ? ORDER BY c.sort_order ASC, c.name ASC`
    )
    .all(req.params.id)
    .map((c) => ({
      id: c.id,
      name: c.name,
      displayLabel: c.display_label,
      feeGHS: c.fee_ghs != null ? c.fee_ghs : null,
      deliveryMode: c.delivery_mode || null,
      campusId: c.campus_id || null,
      campusName: c.campus_name || null,
    }));
  const moduleCount = usesRunScopedCourseCurriculum(row.offering_type_slug)
    ? db.prepare("SELECT COUNT(*) as n FROM courses").get().n
    : db.prepare("SELECT COUNT(*) as n FROM courses WHERE programme_id = ?").get(req.params.id).n;
  // ABRS v2.1 Admin Workflow Redesign checkpoint — same active
  // Participation Structure config getProgrammeParticipationStructures()
  // already resolves for registration/enrolment, reused here (not
  // re-queried a second way) so the Programme Definition checklist and
  // the Batches/Cohorts-vs-Programme-Levels label can never drift from
  // what registration actually validates against.
  const participationStructures = getProgrammeParticipationStructures(req.params.id);
  const usesProgrammeLevels = participationStructures.some((s) => s.usesProgrammeLevels);
  const programmeDefinitionStatus = computeProgrammeDefinitionStatus({
    hasCourses: moduleCount > 0,
    participationStructures,
    hasLearningGroups: learningGroups.length > 0,
  });
  res.json({ ...toProgramme(row), learningGroups, moduleCount, participationStructures, usesProgrammeLevels, programmeDefinitionStatus });
});

// GET /api/learning-offerings/programmes/:id/participation-structures
// ABRS v2.1 Phase 4 (Appendix A-1/Category 3 audit fix) — the
// Programme-owned Participation Structure configuration (Section 10.2),
// read from programme_participation_structures (Phase 2) instead of any
// caller hardcoding the three known key strings and their display names.
// Returns [] for a Programme with none configured (a Programme under an
// offering type that doesn't use Participation Structures at all, or one
// created after the Phase 4 backfill with no admin tooling yet to define
// its own — see migrate.js's v36 comment). Callers should treat an empty
// array as "not applicable here," not as an error.
router.get("/programmes/:id/participation-structures", (req, res) => {
  const programme = db.prepare("SELECT id FROM programmes WHERE id = ?").get(req.params.id);
  if (!programme) return res.status(404).json({ error: "Programme not found." });
  // ABRS v2.1 Phase 5 prerequisite — reads through the same
  // getProgrammeParticipationStructures() the flag-gated registration/
  // enrolment/Programme-Run validation now uses (utils/learningInstances.js),
  // instead of this route keeping its own copy of the query, so the admin
  // label UI and actual business-rule validation can never drift apart.
  res.json({
    participationStructures: getProgrammeParticipationStructures(req.params.id).map((s) => ({
      key: s.key,
      name: s.name,
      usesProgrammeLevels: s.usesProgrammeLevels,
      usesPromotion: s.usesPromotion,
      requiresCourseSelection: s.requiresCourseSelection,
      registrantRole: s.registrantRole,
      usesLongTermEnrollment: s.usesLongTermEnrollment,
      autoAssignsEntryLevel: s.autoAssignsEntryLevel,
    })),
  });
});

// ===========================================================
// Participation Structure Administration (ABRS v2.1 §10, Appendix A-1;
// Admin Workflow Redesign checkpoint Part 2) — Programme-scoped CRUD over
// programme_participation_structures. Deliberately separate from the
// read route above: that one is the lean, active-only, unauthenticated
// shape every registration/enrolment/account-editing consumer already
// depends on and must not change; this is the authenticated admin
// management surface (every status, full detail). A Participation
// Structure belongs to the Programme (§10.1) — never the Programme Run —
// so every route here is scoped by programmeId or the structure's own id,
// never by a Learning Instance.
// ===========================================================

const REGISTRANT_ROLES = ["parent", "self", "parent_or_self"];

function toParticipationStructureAdminDto(row) {
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
    isActive: !!row.is_active,
    sortOrder: row.sort_order,
    retiredAt: row.retired_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/learning-offerings/programmes/:id/participation-structures/manage
// Admin management list — every status (active, deactivated, retired),
// unlike the lean active-only public route above.
router.get("/programmes/:id/participation-structures/manage", requireAuth, (req, res) => {
  const programme = db.prepare("SELECT id FROM programmes WHERE id = ?").get(req.params.id);
  if (!programme) return res.status(404).json({ error: "Programme not found." });
  const rows = db
    .prepare("SELECT * FROM programme_participation_structures WHERE programme_id = ? ORDER BY sort_order ASC, name ASC")
    .all(req.params.id);
  res.json({ participationStructures: rows.map(toParticipationStructureAdminDto) });
});

router.post("/programmes/:id/participation-structures", requireAuth, requirePermission("learningOfferings.edit"), (req, res) => {
  const programme = db.prepare("SELECT id FROM programmes WHERE id = ?").get(req.params.id);
  if (!programme) return res.status(404).json({ error: "Programme not found." });
  const { name, key, usesProgrammeLevels, usesPromotion, requiresCourseSelection, registrantRole, usesLongTermEnrollment, autoAssignsEntryLevel, sortOrder } = req.body;
  const trimmedName = String(name || "").trim();
  if (!trimmedName) return res.status(400).json({ error: "Name is required." });
  if (registrantRole && !REGISTRANT_ROLES.includes(registrantRole)) {
    return res.status(400).json({ error: `registrantRole must be one of: ${REGISTRANT_ROLES.join(", ")}` });
  }
  const finalKey = slugify(key || name);
  if (!finalKey) return res.status(400).json({ error: "Could not derive a key from the name — provide one explicitly." });
  const existing = db
    .prepare("SELECT id FROM programme_participation_structures WHERE programme_id = ? AND key = ?")
    .get(req.params.id, finalKey);
  if (existing) return res.status(400).json({ error: `A Participation Structure with key "${finalKey}" already exists for this Programme.` });
  const id = uuid();
  db.prepare(
    `INSERT INTO programme_participation_structures
       (id, programme_id, key, name, uses_programme_levels, uses_promotion, requires_course_selection, registrant_role, uses_long_term_enrollment, auto_assigns_entry_level, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.params.id,
    finalKey,
    trimmedName,
    usesProgrammeLevels ? 1 : 0,
    usesPromotion ? 1 : 0,
    requiresCourseSelection ? 1 : 0,
    registrantRole || null,
    usesLongTermEnrollment ? 1 : 0,
    autoAssignsEntryLevel ? 1 : 0,
    sortOrder ?? 0
  );
  res.json(toParticipationStructureAdminDto(db.prepare("SELECT * FROM programme_participation_structures WHERE id = ?").get(id)));
});

router.patch("/participation-structures/:id", requireAuth, requirePermission("learningOfferings.edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM programme_participation_structures WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Participation Structure not found." });
  if (row.retired_at) return res.status(400).json({ error: "This Participation Structure has been retired and can no longer be edited." });
  const { name, usesProgrammeLevels, usesPromotion, requiresCourseSelection, registrantRole, usesLongTermEnrollment, autoAssignsEntryLevel, sortOrder } = req.body;
  if (registrantRole !== undefined && registrantRole && !REGISTRANT_ROLES.includes(registrantRole)) {
    return res.status(400).json({ error: `registrantRole must be one of: ${REGISTRANT_ROLES.join(", ")}` });
  }
  const trimmedName = name !== undefined ? String(name).trim() : null;
  if (name !== undefined && !trimmedName) return res.status(400).json({ error: "Name cannot be blank." });
  db.prepare(
    `UPDATE programme_participation_structures SET
       name=?, uses_programme_levels=?, uses_promotion=?, requires_course_selection=?, registrant_role=?, uses_long_term_enrollment=?, auto_assigns_entry_level=?, sort_order=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    name !== undefined ? trimmedName : row.name,
    usesProgrammeLevels !== undefined ? (usesProgrammeLevels ? 1 : 0) : row.uses_programme_levels,
    usesPromotion !== undefined ? (usesPromotion ? 1 : 0) : row.uses_promotion,
    requiresCourseSelection !== undefined ? (requiresCourseSelection ? 1 : 0) : row.requires_course_selection,
    registrantRole !== undefined ? (registrantRole || null) : row.registrant_role,
    usesLongTermEnrollment !== undefined ? (usesLongTermEnrollment ? 1 : 0) : row.uses_long_term_enrollment,
    autoAssignsEntryLevel !== undefined ? (autoAssignsEntryLevel ? 1 : 0) : row.auto_assigns_entry_level,
    sortOrder !== undefined ? sortOrder : row.sort_order,
    req.params.id
  );
  res.json(toParticipationStructureAdminDto(db.prepare("SELECT * FROM programme_participation_structures WHERE id = ?").get(req.params.id)));
});

router.post("/participation-structures/:id/activate", requireAuth, requirePermission("learningOfferings.edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM programme_participation_structures WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Participation Structure not found." });
  if (row.retired_at) return res.status(400).json({ error: "This Participation Structure has been retired and cannot be reactivated." });
  db.prepare("UPDATE programme_participation_structures SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json(toParticipationStructureAdminDto(db.prepare("SELECT * FROM programme_participation_structures WHERE id = ?").get(req.params.id)));
});

router.post("/participation-structures/:id/deactivate", requireAuth, requirePermission("learningOfferings.edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM programme_participation_structures WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Participation Structure not found." });
  if (row.retired_at) return res.status(400).json({ error: "This Participation Structure has already been retired." });
  db.prepare("UPDATE programme_participation_structures SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json(toParticipationStructureAdminDto(db.prepare("SELECT * FROM programme_participation_structures WHERE id = ?").get(req.params.id)));
});

// Terminal — see migrate.js v37 for why this is distinct from deactivate.
router.post("/participation-structures/:id/retire", requireAuth, requirePermission("learningOfferings.edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM programme_participation_structures WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Participation Structure not found." });
  if (row.retired_at) return res.status(400).json({ error: "This Participation Structure has already been retired." });
  db.prepare(
    "UPDATE programme_participation_structures SET is_active = 0, retired_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(req.params.id);
  res.json(toParticipationStructureAdminDto(db.prepare("SELECT * FROM programme_participation_structures WHERE id = ?").get(req.params.id)));
});

router.post("/programmes", requireAuth, requirePermission("learningOfferings.create"), (req, res) => {
  const { offeringTypeId, corporateClientId, name, durationLabel, learningGroupLabel, reportOutputMode, sortOrder, longDescription, projects, eligibilityAudience, startsAt, endsAt } = req.body;
  if (!offeringTypeId || !name) return res.status(400).json({ error: "offeringTypeId and name are required." });
  const offeringType = db.prepare("SELECT * FROM learning_offering_types WHERE id = ?").get(offeringTypeId);
  if (!offeringType) return res.status(400).json({ error: "offeringTypeId does not match a known Learning Offering Type." });
  if (corporateClientId && !db.prepare("SELECT id FROM corporate_clients WHERE id = ?").get(corporateClientId)) {
    return res.status(400).json({ error: "corporateClientId does not match a known corporate client." });
  }
  if (reportOutputMode && !REPORT_OUTPUT_MODES.includes(reportOutputMode)) {
    return res.status(400).json({ error: `reportOutputMode must be one of: ${REPORT_OUTPUT_MODES.join(", ")}` });
  }
  if (eligibilityAudience && !["adults", "children", "both"].includes(eligibilityAudience)) {
    return res.status(400).json({ error: "eligibilityAudience must be one of: adults, children, both." });
  }
  const id = uuid();
  // Registration Window fields (opens/deadline/force-open/force-closed)
  // are deliberately NOT accepted here — Registration Configuration
  // belongs exclusively to the Programme Run (§8.2/§16 Single Ownership
  // Principle). Configure it via PATCH
  // /api/learning-instances/:id/operational-config once this Programme
  // has an active Run.
  db.prepare(
    `INSERT INTO programmes (id, offering_type_id, corporate_client_id, name, duration_label, learning_group_label, report_output_mode, sort_order, long_description, projects, eligibility_audience, starts_at, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, offeringTypeId, corporateClientId || null, name, durationLabel || null, learningGroupLabel || null, reportOutputMode || null, sortOrder ?? 0,
    longDescription || null, Array.isArray(projects) ? JSON.stringify(projects) : null, eligibilityAudience || "both",
    startsAt || null, endsAt || null
  );
  res.json(toProgramme(db.prepare(PROGRAMME_SELECT + " WHERE p.id = ?").get(id)));
});

router.patch("/programmes/:id", requireAuth, requirePermission("learningOfferings.edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM programmes WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Programme not found." });
  const { name, durationLabel, learningGroupLabel, reportOutputMode, corporateClientId, sortOrder, longDescription, projects, eligibilityAudience, startsAt, endsAt } = req.body;
  if (reportOutputMode && !REPORT_OUTPUT_MODES.includes(reportOutputMode)) {
    return res.status(400).json({ error: `reportOutputMode must be one of: ${REPORT_OUTPUT_MODES.join(", ")}` });
  }
  if (eligibilityAudience && !["adults", "children", "both"].includes(eligibilityAudience)) {
    return res.status(400).json({ error: "eligibilityAudience must be one of: adults, children, both." });
  }
  // Registration Window fields are deliberately NOT accepted here — see
  // the same note on POST /programmes above. A client that still sends
  // registrationOpensAt/registrationDeadline/registrationForceClosed/
  // registrationForceOpen in this request body is silently ignored for
  // those fields rather than erroring, so older cached frontend bundles
  // degrade gracefully instead of breaking every other Programme edit.
  db.prepare(
    `UPDATE programmes SET name=?, duration_label=?, learning_group_label=?, report_output_mode=?, corporate_client_id=?, sort_order=?,
       long_description=?, projects=?, eligibility_audience=?, starts_at=?, ends_at=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    name ?? row.name,
    durationLabel ?? row.duration_label,
    learningGroupLabel ?? row.learning_group_label,
    reportOutputMode ?? row.report_output_mode,
    corporateClientId !== undefined ? (corporateClientId || null) : row.corporate_client_id,
    sortOrder ?? row.sort_order,
    longDescription !== undefined ? (longDescription || null) : row.long_description,
    projects !== undefined ? (Array.isArray(projects) ? JSON.stringify(projects) : null) : row.projects,
    eligibilityAudience ?? row.eligibility_audience,
    startsAt !== undefined ? (startsAt || null) : row.starts_at,
    endsAt !== undefined ? (endsAt || null) : row.ends_at,
    req.params.id
  );
  res.json(toProgramme(db.prepare(PROGRAMME_SELECT + " WHERE p.id = ?").get(req.params.id)));
});

// Registration Window admin one-click actions (reopen/close/reset) used to
// live here as Programme-level overrides. They have been removed — that
// capability now lives solely on the Programme Run, via
// PATCH /api/learning-instances/:id/operational-config's
// registrationForceOpen/registrationForceClosed fields (§8.2/§16 Single
// Ownership Principle: there must be exactly one place a Registration
// Window can be forced open or closed).

router.post("/programmes/:id/image", requireAuth, requirePermission("learningOfferings.edit"), logoUpload.single("image"), verifyLogo, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const imagePath = `/uploads/branding/${req.file.filename}`;
  const result = db.prepare("UPDATE programmes SET image_path = ?, updated_at = datetime('now') WHERE id = ?").run(imagePath, req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Programme not found." });
  res.json({ ok: true, imagePath });
});

router.post("/programmes/:id/activate", requireAuth, requirePermission("learningOfferings.edit"), (req, res) => {
  const result = db.prepare("UPDATE programmes SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Programme not found." });
  res.json({ ok: true });
});

router.post("/programmes/:id/deactivate", requireAuth, requirePermission("learningOfferings.edit"), (req, res) => {
  const result = db.prepare("UPDATE programmes SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Programme not found." });
  res.json({ ok: true });
});

module.exports = router;
