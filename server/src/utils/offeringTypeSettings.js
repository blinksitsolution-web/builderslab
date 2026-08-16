const db = require("../db/db");

// Central resolver for Learning Offering Type behaviour settings (the
// "LEARNING OFFERING TYPE SETTINGS" admin feature). Every configurable
// switch listed in the spec (enrollment, academic structure, assessments,
// academic records, payments, certificates, AI, visibility) lives as JSON on
// learning_offering_types.settings. Routes should resolve behaviour through
// this module instead of hardcoding `if (slug === 'kids_stem')`-style checks,
// so that a brand-new Learning Offering Type created purely from the Admin
// Portal behaves correctly everywhere with zero source-code changes.

// Tri-state fields (Yes / No / Optional) use these string values.
const TRISTATE = ["yes", "no", "optional"];

const DEFAULT_SETTINGS = {
  enrollment: {
    parentAccountRequired: "no", // yes | no | optional
    selfRegistrationAllowed: true,
    instructorApprovalRequired: false,
    // ABRS v2.1 Phase 1 audit, Category 1: Kids STEM's flagship Parent +
    // Child flow predates `selfRegistrationAllowed` and must always stay
    // publicly self-registrable regardless of that flag's value (Kids STEM
    // is in fact seeded with selfRegistrationAllowed: false, since that
    // flag's real job is keeping admin-only types like Corporate Training
    // out of public self-registration surfaces). This used to be five
    // separate `slug === "kids_stem"` overrides scattered across the
    // backend and frontend (see server/docs/HARDCODED_IDENTIFIER_AUDIT.md,
    // Category 1); it is now this one configuration flag, defaulted `false`
    // for every offering type and seeded `true` only for kids_stem
    // (migrate.js), so every caller resolves the same single answer through
    // offeringTypeAllowsSelfRegistration()/programmeAllowsSelfRegistration()
    // below instead of re-deriving it from the offering's identity.
    legacyAlwaysSelfRegistrable: false,
  },
  academicStructure: {
    usesAcademicYear: true,
    usesAcademicTerm: "yes", // yes | no | optional
    usesPromotion: false,
    usesLearningGroups: true,
    usesModules: true,
    usesLessons: true,
    usesAttendance: true,
    // ABRS v2.1 Phase 1 audit, Category 1 (continued): a second, distinct
    // hardcoded `slug === "kids_stem"` rule — unrelated to self-registration
    // — gates whether the classic Parent + Child registration flow requires
    // choosing individual Courses ("Choose at least one module") up front.
    // Conflating this with legacyAlwaysSelfRegistrable above would just
    // trade one Single Ownership violation for another (one flag quietly
    // answering two different questions), so it gets its own flag: default
    // `false`, seeded `true` only for kids_stem. Once Phase 2/3 land
    // Programme-owned Participation Structures (ABRS §10), this flag's job
    // is properly subsumed by Individual Course's `requiresCourseSelection`
    // behaviour and can be retired.
    legacyRequiresCourseSelectionAtRegistration: false,
    // ABRS v2.1 Phase 3 Checkpoint 3a: gates whether registration/enrolment
    // and admin course-activation reads are allowed to prefer the new
    // learning_instance_courses / programme_enrollment_courses tables
    // (§8/§19 Phase 3, Appendix A-2/A-4) over the legacy inferred paths
    // (learning_instance_targets + course_group_courses +
    // requested_course_ids JSON). Defaults false for every offering type —
    // Checkpoint 3a only wires up DUAL-WRITE into the new tables so they
    // accumulate real data; no read path is cut over to prefer them yet.
    // Flip this per-offering-type only once Checkpoint 3b (the actual read
    // cutover) has landed and been verified in staging, per §19 Phase 3's
    // exit criteria ("feature flag flipped in staging").
    activatedCoursesV2Enabled: false,
    // ABRS v2.1 Phase 5 prerequisite (§19 Phase 3/5, Appendix A-1) —
    // whether registration/enrolment/Programme-Run routes are allowed to
    // validate and derive behaviour for `participationStructure` from this
    // Programme's own `programme_participation_structures` config rows
    // (§10.2) instead of the hardcoded 3-value enum
    // (isValidParticipationStructure/PARTICIPATION_STRUCTURES in
    // utils/learningInstances.js). Defaults false for every offering
    // type, same posture as activatedCoursesV2Enabled above: flipping
    // this changes real registration validation and the "does this
    // registration need a Course selection step" derivation (a Programme
    // whose configured "Structured Online Journey" correctly has
    // requiresCourseSelection: false, unlike the legacy hardcoded
    // `!== "structured_school_club"` check, which incorrectly required
    // one) — a genuine, documented behaviour change, not a transparent
    // swap, so it must be opted into per offering type once that
    // Programme's config rows have been reviewed.
    participationStructuresV2Enabled: false,
    // Admin Workflow Redesign (ABRS §15/§19-style rollout posture) —
    // whether the guided Programme Run workflow's publish gate
    // (POST /:id/activate refusing an "upcoming" -> "active" transition
    // while computeLearningInstanceWorkflowStatus(...).readyToPublish is
    // false) is actually enforced for this offering type, vs. merely
    // shown as guidance in the admin UI. Defaults false for every
    // offering type, same posture as activatedCoursesV2Enabled/
    // participationStructuresV2Enabled above: existing Runs (and the
    // large surface of tests that activate a minimally-configured Run as
    // setup for something unrelated) keep working unchanged until an
    // offering type opts in once its admins are ready to require full
    // setup before publishing.
    publishReadinessEnforced: false,
  },
  assessments: {
    aiQuizzes: true,
    teacherTests: true,
    assignments: true,
    projects: true,
    // These three previously defaulted to `false` while
    // routes/exams.js's Type-dropdown resolution ignored this setting
    // entirely (always showed the classic Midterm/End Of Term/Retake set
    // for every non-Bootcamp/Corporate-Training offering type regardless).
    // That meant the "Midterm Exams / End of Term Exams / Retake Exams"
    // toggles in Learning Offering Type Settings looked like they controlled
    // the instructor's "Type" dropdown but silently did nothing — flipping
    // them had zero effect either way. Now that exams.js actually reads
    // this setting (see allowedTermTypesForModule), the defaults are
    // updated to `true` to match the behaviour every existing offering
    // type already had, so nothing regresses for Kids STEM/Adult
    // Professional out of the box; migrate.js backfills already-seeded
    // offering types the same way.
    midtermExams: true,
    endOfTermExams: true,
    retakeExams: true,
  },
  academicRecords: {
    generateTranscript: "optional", // yes | no | optional
    generateCertificates: true,
    generateAttendanceReport: true,
  },
  payments: {
    registrationFee: true,
    monthlyFees: false,
    termFees: false,
    programmeFee: false,
    workshopFee: false,
    bootcampFee: false,
    installmentsAllowed: false,
  },
  certificates: {
    availableTemplateIds: [],
    defaultTemplateId: null,
  },
  ai: {
    aiQuizGenerationEnabled: true,
    transcriptRequired: false,
    aiTranscriptSummaryEnabled: false,
  },
  visibility: {
    displayOnPublicWebsite: true,
    displayInLearnerPortal: true,
    displayInParentPortal: true,
  },
  // Public Website CMS: everything the Landing Page's "Featured Learning
  // Offerings" section and this offering's own Enrol button need. Lives
  // here (rather than new columns) since learning_offering_types.settings
  // is already the JSON store the rest of this file resolves through —
  // deepMerge fills these in for every pre-existing row automatically.
  // Independent fee configuration per Offering Type ("Maintain the existing
  // fee structure. Allow independent fee configuration for Kids STEM, Adult
  // Professional, Corporate Training, Bootcamps"). A `null` value here means
  // "fall back to the legacy global Site Settings > Fees" — this is what
  // keeps Kids STEM's existing registration/monthly/sibling-discount fees
  // working byte-for-byte with zero migration required. Every other
  // offering type gets its own independent values the moment an admin sets
  // them. Per-Programme and per-Batch/Cohort overrides layer on top of this
  // (see utils/fees.js resolution chain) without needing any more code —
  // this is the "individual Adult programmes can later have their own fee
  // configuration without major refactoring" requirement.
  fees: {
    registrationGHS: null,
    monthlyGHS: null,
    oneTimeFeeGHS: null, // flat one-off fee (e.g. a Bootcamp or short course) instead of registration+monthly
    siblingDiscountPercent: null,
  },
  landing: {
    featureLevel: "standard", // featured | standard | hidden
    tagline: null,
    description: null,
    imagePath: null,
    features: [], // short bullet list shown on the offering's landing card
    sortOrder: 0,
    enrolButtonText: "Enrol now",
    // Empty string = default to this offering type's own registration flow;
    // set to override (e.g. a Corporate Training enquiry form URL instead
    // of a self-service registration page).
    enrolDestination: "",
    enrolOpenBehavior: "same_tab", // same_tab | new_tab
    enrolVisible: true,
  },
};

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// Deep-merges `overrides` onto `base`, one config section at a time, so a
// PATCH only touching e.g. `payments` never clobbers `assessments`.
function deepMerge(base, overrides) {
  if (!isPlainObject(overrides)) return isPlainObject(base) ? { ...base } : base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const key of Object.keys(overrides)) {
    out[key] = isPlainObject(overrides[key]) && isPlainObject(base && base[key])
      ? deepMerge(base[key], overrides[key])
      : overrides[key];
  }
  return out;
}

// Parses a raw settings JSON string (possibly null/malformed) and fills in
// any missing keys with defaults — this is what lets old rows created before
// a setting existed, and brand-new admin-created types that only set a few
// fields, both resolve to a complete, safe-to-read settings object.
function parseSettings(raw) {
  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = {};
    }
  }
  return deepMerge(DEFAULT_SETTINGS, parsed);
}

function serializeSettings(settingsObj) {
  return JSON.stringify(deepMerge(DEFAULT_SETTINGS, settingsObj || {}));
}

// A tri-state value resolves to a hard boolean for callers that just need to
// gate a feature on/off; "optional" resolves to `fallback` (default true —
// i.e. optional features are available but not enforced).
function resolveTriState(value, fallback = true) {
  if (value === "yes") return true;
  if (value === "no") return false;
  return fallback; // "optional" or anything unrecognized
}

// ---- lookups used by other routes (replaces ad-hoc SQL joins) -------------

function getOfferingTypeById(id) {
  const row = db.prepare("SELECT * FROM learning_offering_types WHERE id = ?").get(id);
  return row ? { ...row, settings: parseSettings(row.settings) } : null;
}

function getOfferingTypeForProgramme(programmeId) {
  if (!programmeId) return null;
  const row = db
    .prepare(
      `SELECT t.* FROM programmes p JOIN learning_offering_types t ON t.id = p.offering_type_id WHERE p.id = ?`
    )
    .get(programmeId);
  return row ? { ...row, settings: parseSettings(row.settings) } : null;
}

function getOfferingTypeForClass(classId) {
  if (!classId) return null;
  const cls = db.prepare("SELECT programme_id FROM classes WHERE id = ?").get(classId);
  return cls ? getOfferingTypeForProgramme(cls.programme_id) : null;
}

// Resolves "the" programme for a given offering type slug — used by callers
// that historically hardcoded a lookup like `classes WHERE name = 'Foundation'`
// or `programmes WHERE name = 'Builders Lab'` with no offering-type/programme
// scoping at all. Picks the offering type's own lowest-sort_order active
// programme (ties broken by creation order), which is exactly "Builders Lab"
// for today's single-programme Kids STEM data, but — unlike a hardcoded name
// — still resolves correctly if a programme is ever renamed, or if Kids STEM
// ever gains more than one programme. Returns null (never a guess) if the
// offering type doesn't exist or has no programme yet.
function getDefaultProgrammeForOfferingSlug(slug) {
  const offeringType = db.prepare("SELECT id FROM learning_offering_types WHERE slug = ?").get(slug);
  if (!offeringType) return null;
  return db
    .prepare(
      `SELECT * FROM programmes
       WHERE offering_type_id = ? AND is_active = 1
       ORDER BY sort_order ASC, created_at ASC LIMIT 1`
    )
    .get(offeringType.id) || null;
}

// Convenience: does this programme's offering type require/allow a parent
// account? Used in place of the old hardcoded `requires_parent` read.
function programmeRequiresParent(programmeId, fallback = false) {
  const type = getOfferingTypeForProgramme(programmeId);
  if (!type) return fallback;
  return resolveTriState(type.settings.enrollment.parentAccountRequired, false);
}

// Resolves whether a Learning Offering Type allows public self-registration,
// from configuration alone (ABRS v2.1 §2.2 — no `slug === "kids_stem"`
// comparison). `type` must already be settings-parsed (see
// getOfferingTypeById/getOfferingTypeForProgramme above). Every caller that
// used to special-case Kids STEM's slug directly (GET /types/registration,
// GET /enrolments/eligible-offerings, this module's own
// programmeAllowsSelfRegistration below) now resolves through this single
// function instead, so they can never silently disagree.
function offeringTypeAllowsSelfRegistration(type) {
  if (!type) return true;
  if (type.settings.enrollment.legacyAlwaysSelfRegistrable === true) return true;
  return type.settings.enrollment.selfRegistrationAllowed !== false;
}

// Convenience: is public self-registration switched on for this programme's
// offering type? Used by the public registration flow (routes/auth.js) to
// decide which Offering Types/Programmes to even offer a self-service signup
// for — Corporate Training, for instance, may be admin-created (via
// POST /users/participants) only, with self registration turned off.
function programmeAllowsSelfRegistration(programmeId, fallback = true) {
  const type = getOfferingTypeForProgramme(programmeId);
  if (!type) return fallback;
  return offeringTypeAllowsSelfRegistration(type);
}

// Resolves whether this Learning Offering Type's classic registration flow
// requires selecting individual Courses up front (today, only Kids STEM's
// Parent + Child flow does — the pre-Participation-Structures ancestor of
// what ABRS v2.1 §10.2 calls Individual Course's `requiresCourseSelection`).
// Same shape as offeringTypeAllowsSelfRegistration above, and deliberately a
// separate flag/function rather than reusing it — this answers a different
// question and must not become a second, competing owner of the same one.
function offeringTypeRequiresCourseSelectionAtRegistration(type) {
  if (!type) return false;
  return type.settings.academicStructure.legacyRequiresCourseSelectionAtRegistration === true;
}

// ABRS v2.1 Phase 3 Checkpoint 3a — whether this offering type's Programme
// Runs/enrolments should prefer the new learning_instance_courses /
// programme_enrollment_courses tables over the legacy inferred read paths.
// Defaults false (see DEFAULT_SETTINGS.academicStructure above); no caller
// in Checkpoint 3a actually branches on this yet — it exists now so
// Checkpoint 3b's read-path cutover has a single, already-wired resolver
// to call instead of adding one under time pressure later.
function offeringTypeUsesActivatedCoursesV2(type) {
  if (!type) return false;
  return type.settings.academicStructure.activatedCoursesV2Enabled === true;
}

// ABRS v2.1 Phase 5 prerequisite — same shape as
// offeringTypeUsesActivatedCoursesV2 above, gating the Participation
// Structure config cutover (§10, Appendix A-1) instead.
function offeringTypeUsesParticipationStructuresV2(type) {
  if (!type) return false;
  return type.settings.academicStructure.participationStructuresV2Enabled === true;
}

// Admin Workflow Redesign — same shape as the two resolvers above, gating
// whether an incomplete Programme Run is actually blocked from publishing
// (vs. only flagged in the guided-workflow UI) for this offering type.
function offeringTypeEnforcesPublishReadiness(type) {
  if (!type) return false;
  return type.settings.academicStructure.publishReadinessEnforced === true;
}

// Does this Programme's configured eligibility audience allow the given
// registration path? kind is "adult" (self-registering adult) or
// "parent-learner" (a parent registering a child).
function programmeAllowsAudience(programme, kind) {
  const audience = (programme && programme.eligibility_audience) || "both";
  if (audience === "both") return true;
  if (audience === "adults") return kind === "adult";
  if (audience === "children") return kind === "parent-learner";
  return true;
}

// Does this Programme actually have any Modules open for self-registration
// right now? Used to decide whether registration needs a Course/Module
// selection step at all — driven by what this specific Programme has
// configured, instead of a hardcoded "Kids STEM / Builders' Lab" special
// case. Today only Kids STEM's "Builders Lab" programme has Modules
// configured, so this resolves identically to the old hardcoded check for
// existing data — but a future Programme under any Offering Type that
// gains its own open Modules picks up the same behaviour automatically,
// with no registration-route code change required.
function programmeHasOpenModules(programmeId) {
  if (!programmeId) return false;
  const row = db.prepare("SELECT COUNT(*) as c FROM courses WHERE programme_id = ? AND is_open = 1").get(programmeId);
  return !!(row && row.c > 0);
}

module.exports = {
  TRISTATE,
  DEFAULT_SETTINGS,
  deepMerge,
  parseSettings,
  serializeSettings,
  resolveTriState,
  getOfferingTypeById,
  getOfferingTypeForProgramme,
  getOfferingTypeForClass,
  getDefaultProgrammeForOfferingSlug,
  programmeRequiresParent,
  programmeAllowsSelfRegistration,
  offeringTypeUsesActivatedCoursesV2,
  offeringTypeUsesParticipationStructuresV2,
  offeringTypeEnforcesPublishReadiness,
  offeringTypeAllowsSelfRegistration,
  offeringTypeRequiresCourseSelectionAtRegistration,
  programmeAllowsAudience,
  programmeHasOpenModules,
};
