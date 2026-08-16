const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { getFullUser, toPublicUser } = require("../utils/userView");
const { requireAuth } = require("../middleware/auth");
const { nextStudentCode } = require("../utils/studentCode");
const { registrationBreakdown } = require("../utils/fees");
const pricingEngine = require("../utils/pricingEngine");
const { programmeRequiresParent, programmeAllowsSelfRegistration, getOfferingTypeForClass, getOfferingTypeForProgramme, programmeAllowsAudience, getDefaultProgrammeForOfferingSlug, programmeHasOpenModules, offeringTypeUsesParticipationStructuresV2 } = require("../utils/offeringTypeSettings");
const { isValidEmail, isStrongPassword, passwordMessage, isValidCountryCode } = require("../utils/validators");
const { resolveCampusByName } = require("../utils/campusResolution");
const { getActiveInstanceIdForProgramme, getActiveInstanceIdForCourse, getLearningInstanceById, getInstanceTargets, isTargetActiveInCurrentPeriod, isValidParticipationStructure, isParticipationStructureAllowedForOfferingType, deriveEnrollmentOperationalSnapshot, resolveProgrammeRegistrationOpen, recordEnrollmentCourseSelections, resolveParticipationStructureConfig, getProgrammeParticipationStructures, resolveActiveInstanceForRegistration, isCourseAvailableForIndividualCourseOffering, getEligibleCoursesForRun, checkOperationalGroupCapacity, usesRunScopedCourseCurriculum } = require("../utils/learningInstances");

// The only country this platform has ever actually supported registration/
// payment for. Absent `country` (every pre-country frontend build, or any
// other API caller that doesn't send it) defaults here — the exact
// historical behaviour, just made explicit instead of assumed. A
// *present but malformed* value is rejected outright rather than silently
// coerced to 'GH', so a client-side bug can't quietly mis-file a real
// international registrant as Ghanaian.
const DEFAULT_COUNTRY = "GH";
function resolveCountry(raw) {
  if (raw === undefined || raw === null || raw === "") return { code: DEFAULT_COUNTRY };
  if (!isValidCountryCode(raw)) return { error: "country must be a valid 2-letter country code." };
  return { code: String(raw).trim().toUpperCase() };
}

// Stage 4G — Town/City of residence. Unlike country, there's no sensible
// default to fall back to, so an absent/empty value simply stores NULL
// (exactly like every other pre-existing optional profile field) rather
// than being rejected outright — that's what keeps this backward
// compatible with any caller/test that predates the field. The actual
// "learner must provide it" requirement is enforced where a human is
// actually filling out the form (RegisterPage.jsx's `required` town
// field), the same division of labour already used for country.
function resolveTown(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed || null;
}

// Resolves the Learning Group a brand-new registrant should enter for a given
// programme: the class(es) at that programme's lowest sort_order. For the
// classic Kids STEM path this is exactly "Foundation" (sort_order 0), so
// omitting programmeId keeps today's behaviour byte-for-byte. If a programme
// happens to have more than one Learning Group tied for the lowest
// sort_order (e.g. parallel "Morning"/"Evening" intake batches), the caller
// may pick which one via `preferredClassId`; otherwise the first is used.
function resolveEntryClass(programmeId, preferredClassId) {
  const groups = db.prepare("SELECT * FROM classes WHERE programme_id = ? ORDER BY sort_order ASC, name ASC").all(programmeId);
  if (!groups.length) return null;
  const minSort = groups[0].sort_order;
  const entryGroups = groups.filter((g) => g.sort_order === minSort);
  if (preferredClassId) {
    const match = entryGroups.find((g) => g.id === preferredClassId);
    if (match) return match;
  }
  return entryGroups[0];
}

// Resolves the campus to store on `users.campus` for this registration,
// honouring Delivery Mode (see migrate.js's classes.delivery_mode/
// campus_id). A class that predates Delivery Mode (delivery_mode IS NULL
// — every legacy Kids STEM/Bootcamp/Adult/Corporate class today) is
// completely unaffected: the caller's own free-text campus is trusted
// exactly as it was before this feature existed — callers pass their
// pre-existing fallback behaviour in via `legacyValue`. Only once a class
// has an explicit delivery_mode does this override ever apply, and it
// NEVER trusts client-supplied campus text for those classes — only the
// campus actually attached to that specific Class/Cohort by an admin.
// Returns { campus, error } — `error` (a user-facing string) means the
// caller must reject the registration with a 400 before creating anything.
function resolveCampusForRegistration(classRow, legacyValue) {
  if (!classRow || !classRow.delivery_mode) {
    // Legacy (pre-Delivery-Mode) classes still trust the caller's free-text
    // value as before — but best-effort normalize it against the canonical
    // campuses table first (§3/§2.1), so a value that already matches a
    // real campus under different casing/spacing gets stored consistently
    // rather than drifting. A value with no match (e.g. the synthetic
    // "Adult / self-paced" marker, which isn't a real campus) is passed
    // through unchanged exactly as before — this never rejects or blocks
    // a legacy registration, only tightens what gets stored when it can.
    const resolved = resolveCampusByName(legacyValue);
    return { campus: resolved ? resolved.name : legacyValue, error: null };
  }
  if (classRow.delivery_mode === "ONLINE") {
    // Online never carries a physical campus, regardless of what the
    // client sent — campus is null/ignored for the enrollment path.
    return { campus: null, error: null };
  }
  // ON_CAMPUS: campus is authoritative from the Class itself — the learner
  // must not be able to submit a campus/class combination that doesn't
  // match, and the campus must be an active, valid campus.
  if (!classRow.campus_id) {
    return { campus: null, error: "This on-campus Learning Group has no campus configured yet — contact the admin." };
  }
  const campus = db.prepare("SELECT * FROM campuses WHERE id = ?").get(classRow.campus_id);
  if (!campus || !campus.active) {
    return { campus: null, error: "The campus linked to this Learning Group is no longer active — contact the admin." };
  }
  return { campus: campus.name, error: null };
}

// Same delivery-mode resolution as above, but for the pre-account fee
// PREVIEW endpoint only: best-effort, never returns an error (a bad/
// misconfigured campus there should just show no partner-campus discount,
// not block the preview — the real /register call above still enforces
// the hard validation before anything is created).
function previewCampusForDeliveryMode(classRow, legacyValue) {
  if (!classRow || !classRow.delivery_mode) return legacyValue || null;
  if (classRow.delivery_mode === "ONLINE") return null;
  if (!classRow.campus_id) return null;
  const campus = db.prepare("SELECT name, active FROM campuses WHERE id = ?").get(classRow.campus_id);
  return campus && campus.active ? campus.name : null;
}

const router = express.Router();

// Auto-generated learner login password — easy to read/type (no ambiguous
// 0/O/1/l characters), used instead of asking parents to set one manually.
function generateLearnerPassword() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function cookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== "false",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}
function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "30d",
  });
  res.cookie("dtl_token", token, cookieOpts());
}

/**
 * Registration is a two-step trust boundary:
 *   1. Create the account with status='pending_payment' (no portal access yet).
 *   2. Only /api/payments/webhook flips it to status='active' once Paystack
 *      confirms the charge actually succeeded — never on the client's say-so.
 */
router.post("/register", (req, res) => {
  const { kind, parent, learner, adult, courseIds } = req.body;

  // Builders' Lab participation structure (v29) — optional; a registration
  // that doesn't send one (every pre-existing frontend build, and every
  // non-Kids-STEM offering type today) stores NULL, exactly the same
  // "unspecified/legacy" state every other new nullable column in this
  // codebase defaults to.
  const requestedParticipationStructure = req.body.participationStructure || null;

  // The "choose a Builders' Lab module" step only exists for Kids STEM
  // (Foundation/Framework/Skyline run in a fixed module season order).
  // Every other offering type (Adult Professional, Corporate Training,
  // Bootcamp, and any admin-created child-facing offering) organizes by
  // Programme + Batch/Cohort instead, so it never sends `courseIds` and must
  // not be forced to. We resolve which offering type this registration
  // targets from the programmeId/classId the client sent — omitting both
  // (every pre-existing frontend build) keeps the historical Kids STEM
  // behaviour byte-for-byte.
  const requestedProgrammeId = req.body.programmeId || null;
  const requestedClassId = req.body.classId || null;
  let targetOfferingType = null;
  if (requestedClassId) {
    targetOfferingType = getOfferingTypeForClass(requestedClassId);
  } else if (requestedProgrammeId) {
    targetOfferingType = getOfferingTypeForProgramme(requestedProgrammeId);
  }
  // Which Programme is this registration actually resolving into? Same
  // precedence the rest of this route already uses below (explicit classId
  // > explicit programmeId > the legacy no-selection-sent fallback, which
  // has always meant Kids STEM's own default programme).
  let resolvedProgrammeIdForModules = requestedProgrammeId;
  if (!resolvedProgrammeIdForModules && requestedClassId) {
    const cls = db.prepare("SELECT programme_id FROM classes WHERE id = ?").get(requestedClassId);
    resolvedProgrammeIdForModules = cls ? cls.programme_id : null;
  }
  if (!resolvedProgrammeIdForModules && !requestedClassId) {
    const kidsStemProgramme = getDefaultProgrammeForOfferingSlug("kids_stem");
    resolvedProgrammeIdForModules = kidsStemProgramme ? kidsStemProgramme.id : null;
  }

  // ABRS v2.1 Phase 5 prerequisite (§10, Appendix A-1): validated up front
  // so a bad value fails the whole registration instead of silently being
  // dropped, and — for any offering type that has opted into
  // participationStructuresV2Enabled — validated and its behaviour
  // resolved against this Programme's own configuration (§10.2) instead
  // of the hardcoded 3-value enum/error message. Every offering type
  // defaults to the flag off, so this is byte-for-byte the historical
  // behaviour unless an admin has explicitly opted a Programme in.
  const usesParticipationStructuresV2 = offeringTypeUsesParticipationStructuresV2(targetOfferingType);
  let matchedParticipationStructureConfig = null;
  if (usesParticipationStructuresV2 && resolvedProgrammeIdForModules) {
    if (requestedParticipationStructure != null) {
      matchedParticipationStructureConfig = resolveParticipationStructureConfig(
        resolvedProgrammeIdForModules,
        requestedParticipationStructure
      );
      if (!matchedParticipationStructureConfig) {
        const available = getProgrammeParticipationStructures(resolvedProgrammeIdForModules).map((s) => s.key);
        return res.status(400).json({
          error: available.length
            ? `participationStructure must be one of: ${available.join(", ")}.`
            : "This programme has no Participation Structures configured — contact the admin.",
        });
      }
    }
  } else if (
    !isValidParticipationStructure(requestedParticipationStructure) ||
    !isParticipationStructureAllowedForOfferingType(targetOfferingType, requestedParticipationStructure)
  ) {
    return res.status(400).json({ error: "participationStructure must be one of: structured_school_club, structured_other, individual_course." });
  }

  // Whether this registration needs a Course/Module selection step is
  // driven entirely by configuration, not by a hardcoded Kids STEM/
  // Builders' Lab special case: (a) the target Programme must actually have
  // Modules open for self-registration, and (b) the chosen Participation
  // Structure's own `requiresCourseSelection` flag says so (§10.2) — e.g.
  // School Club selection means the school itself, not the parent,
  // controls curriculum placement, so it never requires one. When the
  // flag is off (default) or no configured structure matched what was
  // sent, this falls back to the historical "everything except School
  // Club requires selection" heuristic, unchanged.
  const requiresCourseSelectionFlag =
    usesParticipationStructuresV2 && matchedParticipationStructureConfig
      ? matchedParticipationStructureConfig.requiresCourseSelection
      : requestedParticipationStructure !== "structured_school_club";
  const requiresModuleSelection =
    kind === "parent-learner" && requiresCourseSelectionFlag && programmeHasOpenModules(resolvedProgrammeIdForModules);

  if (requiresModuleSelection) {
    if (!Array.isArray(courseIds) || courseIds.length === 0) {
      return res.status(400).json({ error: "Choose at least one module." });
    }
    // Individual Course registrations must name their offering explicitly —
    // never fall back to an unrelated Active Run for the same Programme.
    if (requestedParticipationStructure === "individual_course" && !req.body.learningInstanceId) {
      return res.status(400).json({ error: "learningInstanceId is required for Individual Course registration." });
    }
    const validationInstanceId =
      requestedParticipationStructure === "individual_course" && req.body.learningInstanceId
        ? req.body.learningInstanceId
        : null;
    const validationInstance = validationInstanceId ? getLearningInstanceById(validationInstanceId) : null;
    if (requestedParticipationStructure === "individual_course") {
      if (!validationInstance || validationInstance.participationStructure !== "individual_course") {
        return res.status(400).json({ error: "learningInstanceId must refer to an active Individual Course Learning Instance." });
      }
    }

    for (const m of courseIds) {
      const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(m);
      if (!course) {
        return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
      }
      if (!course.is_open) {
        return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
      }
      if (resolvedProgrammeIdForModules && course.programme_id && course.programme_id !== resolvedProgrammeIdForModules) {
        return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
      }

      if (requestedParticipationStructure === "individual_course") {
        // Authoritative offering membership — programme-level targets alone
        // do NOT authorize course selection for Individual Course.
        if (!isCourseAvailableForIndividualCourseOffering(validationInstance.id, m)) {
          return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
        }
      } else {
        // Structured path — each course must have its own active instance.
        const instanceId = getActiveInstanceIdForCourse(m);
        if (!instanceId) {
          return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
        }
        const instance = getLearningInstanceById(instanceId);
        if (instance) {
          const targets = getInstanceTargets(instance.id);
          if (targets && targets.length > 0) {
            const isTarget = targets.some(
              (t) => t.courseId === m || (t.targetType === "programme" && t.programmeId === course.programme_id)
            );
            if (!isTarget) {
              return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
            }
          }
          if (!isTargetActiveInCurrentPeriod(instance, { courseId: m })) {
            return res.status(400).json({ error: `These courses aren't open for enrolment right now: ${m}.` });
          }
        }
      }
    }
  }

  try {
    if (kind === "parent-learner") {
      // Backward/forward compatible: accept either a single `learner` object
      // (existing single-ward flow) or a `learners` array (new multi-ward
      // flow) — internally we always work with a list.
      const learnerList = Array.isArray(req.body.learners) ? req.body.learners : learner ? [learner] : [];

      if (!parent?.name || !parent?.email || !parent?.password || learnerList.length === 0) {
        return res.status(400).json({ error: "Fill in every required field, including at least one learner." });
      }
      if (!isValidEmail(parent.email)) {
        return res.status(400).json({ error: "Enter a valid email address." });
      }
      if (!isStrongPassword(parent.password)) {
        return res.status(400).json({ error: passwordMessage(parent.password) });
      }
      if (parent.confirmPassword !== undefined && parent.password !== parent.confirmPassword) {
        return res.status(400).json({ error: "Your password and confirmation don't match." });
      }
      const parentCountryResult = resolveCountry(parent.country);
      if (parentCountryResult.error) return res.status(400).json({ error: parentCountryResult.error });
      const parentCountry = parentCountryResult.code;
      const parentTown = resolveTown(parent.town);
      for (const l of learnerList) {
        if (!l.name) return res.status(400).json({ error: "Every learner needs a name." });
        // Age is optional (a parent may not know/want to give it), but if
        // provided it must be a plausible whole number — matches the
        // min="6" hint on the form without hard-blocking edge cases like a
        // precocious 5-year-old or an older sibling using the Kids STEM path.
        if (l.age !== undefined && l.age !== null && l.age !== "") {
          const ageNum = Number(l.age);
          if (!Number.isInteger(ageNum) || ageNum < 3 || ageNum > 21) {
            return res.status(400).json({ error: `${l.name}'s age must be a whole number between 3 and 21.` });
          }
        }
      }

      parent.email = String(parent.email).toLowerCase().trim();
      if (db.prepare("SELECT id FROM users WHERE email = ?").get(parent.email)) {
        return res.status(409).json({ error: "An account with this email already exists." });
      }

      // Optional Programme selection (Unified Learning Architecture) — lets
      // a parent choose which Kids STEM programme to enrol into when more
      // than one exists. Omitting it (every pre-existing frontend build,
      // and the common case where there's only the one seeded "Builders
      // Lab" programme) falls back to the historical hardcoded lookup by
      // name, so nothing about the classic single-programme flow changes.
      const { programmeId } = req.body;
      if (programmeId && !db.prepare("SELECT id FROM programmes WHERE id = ?").get(programmeId)) {
        return res.status(400).json({ error: "programmeId does not match a known programme." });
      }
      const parentId = uuid();
      const parentHash = bcrypt.hashSync(parent.password, 12);
      // A specific Batch/Cohort (classId) takes precedence when the parent
      // picked one explicitly (dynamic non-Kids-STEM child offerings, e.g. a
      // Bootcamp's Weekday vs Weekend intake); otherwise fall back to the
      // programme's auto-resolved entry class exactly as before.
      const { classId: requestedParentClassId } = req.body;
      let foundation = null;
      if (requestedParentClassId) {
        foundation = db.prepare("SELECT * FROM classes WHERE id = ?").get(requestedParentClassId);
        if (!foundation) return res.status(400).json({ error: "Unknown classId (Batch/Cohort)." });
        if (programmeId && foundation.programme_id !== programmeId) {
          return res.status(400).json({ error: "That Batch/Cohort doesn't belong to the selected programme." });
        }
        if (!programmeAllowsSelfRegistration(foundation.programme_id)) {
          return res.status(400).json({ error: "Self-registration isn't open for this programme — contact the admin to be enrolled." });
        }
        const bootcampProgramme = db.prepare("SELECT * FROM programmes WHERE id = ?").get(foundation.programme_id);
        if (bootcampProgramme && !programmeAllowsAudience(bootcampProgramme, "parent-learner")) {
          return res.status(400).json({ error: "This programme is only open to adult self-registration." });
        }
        if (bootcampProgramme && !resolveProgrammeRegistrationOpen(bootcampProgramme, req.body.operationalGroupId)) {
          return res.status(409).json({ error: "Registration for this programme is currently closed — contact the admin." });
        }
        // ABRS v2.2 amendment (concurrent Programme Runs): a Programme may
        // now have more than one Active Run at once. When it does, we
        // cannot silently guess which one this registration belongs to —
        // require the caller to disambiguate via operationalGroupId
        // (already the natural "which school/batch" selector, see §11.3)
        // and surface the available runs so the frontend can prompt a
        // picker if it didn't send one.
        if (bootcampProgramme) {
          const resolvedRun = resolveActiveInstanceForRegistration(bootcampProgramme.id, req.body.operationalGroupId, req.body.learningInstanceId, requestedParticipationStructure);
          if (resolvedRun.ambiguous) {
            return res.status(409).json({
              error: "This programme currently has more than one active run — choose which one to register into.",
              activeRuns: resolvedRun.options.map((o) => ({ id: o.id, name: o.name })),
            });
          }
        }
      } else if (programmeId) {
        // Same three checks the explicit-classId branch above enforces —
        // previously skipped here entirely, which meant a caller could
        // bypass self-registration/audience/registration-window
        // validation simply by sending programmeId alone instead of
        // resolving+sending a classId first. resolveEntryClass() always
        // resolves within this programmeId, so the checks below are scoped
        // to the same programme the parent is actually registering into.
        foundation = resolveEntryClass(programmeId);
        if (foundation) {
          if (!programmeAllowsSelfRegistration(foundation.programme_id)) {
            return res.status(400).json({ error: "Self-registration isn't open for this programme — contact the admin to be enrolled." });
          }
          const selectedProgramme = db.prepare("SELECT * FROM programmes WHERE id = ?").get(foundation.programme_id);
          if (selectedProgramme && !programmeAllowsAudience(selectedProgramme, "parent-learner")) {
            return res.status(400).json({ error: "This programme is only open to adult self-registration." });
          }
          if (selectedProgramme && !resolveProgrammeRegistrationOpen(selectedProgramme, req.body.operationalGroupId)) {
            return res.status(409).json({ error: "Registration for this programme is currently closed — contact the admin." });
          }
          if (selectedProgramme) {
            const resolvedRun = resolveActiveInstanceForRegistration(selectedProgramme.id, req.body.operationalGroupId, req.body.learningInstanceId, requestedParticipationStructure);
            if (resolvedRun.ambiguous) {
              return res.status(409).json({
                error: "This programme currently has more than one active run — choose which one to register into.",
                activeRuns: resolvedRun.options.map((o) => ({ id: o.id, name: o.name })),
              });
            }
          }
        }
      } else {
        // Historical fallback for callers that send neither classId nor
        // programmeId (every pre-Unified-Learning-Architecture frontend
        // build) — this is always a Kids STEM registration. Previously this
        // looked up `classes WHERE name = 'Foundation'` with no programme
        // scoping at all, which would have matched *any* programme's class
        // named "Foundation" (an ambiguous, name-only identification the
        // architecture must not do) the moment more than one existed.
        // Resolving the Kids STEM offering type's own programme first, then
        // its entry class, keeps this scoped correctly no matter how many
        // programmes/offering types exist.
        const kidsStemProgramme = getDefaultProgrammeForOfferingSlug("kids_stem");
        foundation = kidsStemProgramme ? resolveEntryClass(kidsStemProgramme.id) : null;
      }
      if (programmeId && !foundation) {
        return res.status(400).json({ error: "That programme has no Learning Group configured yet — contact the admin." });
      }

      // Registration Source of Truth: registration is only ever permitted
      // through an ACTIVE Programme Run (Learning Instance). Previously the
      // resolved Active Learning Instance id was allowed to be NULL here and
      // registration proceeded anyway — a legacy Programme-based fallback.
      // That fallback is retired: if a Programme/Learning Group was resolved
      // but it has no Active Programme Run, there is no valid registration
      // opportunity and registration must not occur.
      //
      // ABRS v2.2 amendment (concurrent Programme Runs): this is the ONE
      // resolution point every registration path (classId branch,
      // programmeId branch, AND the historical neither-supplied fallback)
      // funnels through via `foundation` — so it's also the one place that
      // actually determines which Run this registration attaches to. The
      // ambiguity checks earlier in the classId/programmeId branches above
      // catch the common cases early with a clearer error, but this is the
      // authoritative resolution; it must use the same disambiguation-aware
      // resolver (not the legacy "most recently activated" default) or a
      // correctly-disambiguated request could still silently attach to the
      // wrong Run.
      // Root cause of the Kids STEM Individual Course pricing bug: every
      // branch above that resolves `foundation` does so purely via Classes/
      // Learning Groups (resolveEntryClass()), but Individual Course Runs
      // don't have or need a Class at all — a programme that only ever
      // offers Individual Course Runs can legitimately have ZERO classes
      // configured. That left `foundation` null for exactly that (very
      // normal) setup, which skipped this whole resolution block, which in
      // turn skipped the entire "insert primary enrollment" block below
      // (its own `if (foundation)` gate) — even though the parent had
      // already picked, and the block above had already validated, a
      // perfectly good learningInstanceId. The learner ended up with NO
      // programme_enrollments row and no learning_instance_id anywhere, so
      // every later lookup (registrationBreakdown() here, and
      // getEnrolledLearningInstanceIdForLearner() at payment time) fell
      // back to the legacy site-wide Registration Fee and never saw
      // Combine Registration with First Period — the exact "GHS 350 legacy
      // default, both semesters still unpaid" symptom. Resolved directly
      // from the already-validated Individual Course Learning Instance
      // here so it works with or without a foundation Class.
      let individualCourseEntryInstance = null;
      if (requestedParticipationStructure === "individual_course" && req.body.learningInstanceId) {
        const candidate = getLearningInstanceById(req.body.learningInstanceId);
        if (candidate && candidate.participationStructure === "individual_course") {
          individualCourseEntryInstance = candidate;
        }
      }
      let entryLearningInstanceIdPreCheck = null;
      if (individualCourseEntryInstance) {
        entryLearningInstanceIdPreCheck = individualCourseEntryInstance.id;
      } else if (foundation) {
        const resolvedEntryRun = resolveActiveInstanceForRegistration(foundation.programme_id, req.body.operationalGroupId, req.body.learningInstanceId, requestedParticipationStructure);
        if (resolvedEntryRun.ambiguous) {
          return res.status(409).json({
            error: "This programme currently has more than one active run — choose which one to register into.",
            activeRuns: resolvedEntryRun.options.map((o) => ({ id: o.id, name: o.name })),
          });
        }
        entryLearningInstanceIdPreCheck = resolvedEntryRun.instance ? resolvedEntryRun.instance.id : null;
      }
      if (foundation && !individualCourseEntryInstance && !entryLearningInstanceIdPreCheck) {
        return res.status(409).json({ error: "There are currently no available registration opportunities for this programme — an admin has not opened an active registration run yet." });
      }
      if (requestedParticipationStructure === "individual_course" && req.body.learningInstanceId && !individualCourseEntryInstance) {
        return res.status(400).json({ error: "learningInstanceId must refer to an active Individual Course Learning Instance." });
      }

      // §17/§18 — Operational Group selection is optional (most Programme
      // Runs have none configured) and, when provided, must belong to
      // THIS registration's own resolved Programme Run — never a
      // Programme Level choice (§11.2), and applies uniformly to every
      // ward in this submission since they all join the same
      // foundation Class/Run.
      const { operationalGroupId: requestedOperationalGroupId } = req.body;
      if (requestedOperationalGroupId) {
        if (!entryLearningInstanceIdPreCheck) {
          return res.status(400).json({ error: "operationalGroupId was provided but no Programme Run could be resolved for this registration." });
        }
        const group = db.prepare("SELECT id, learning_instance_id, is_active FROM operational_groups WHERE id = ?").get(requestedOperationalGroupId);
        if (!group || group.learning_instance_id !== entryLearningInstanceIdPreCheck || !group.is_active) {
          return res.status(400).json({ error: "operationalGroupId is not a valid, active Operational Group for this programme's current Programme Run." });
        }
      }

      // Delivery-Mode-aware campus resolution (see resolveCampusForRegistration)
      // — validated per learner, before any account is created. A class with
      // no delivery_mode (every legacy class) resolves to exactly the
      // historical `l.campus || null`, so nothing changes for existing flows.
      const resolvedCampuses = [];
      for (const l of learnerList) {
        const { campus, error } = resolveCampusForRegistration(foundation, l.campus || null);
        if (error) return res.status(400).json({ error });
        resolvedCampuses.push(campus);
      }

      const insertUser = db.prepare(
        `INSERT INTO users (id, role, name, email, password_hash, phone, phone_network, country, town, campus, school_name, parent_id, status, payment_status, joined_date, class_id, student_code, own_robotics_kit, age)
         VALUES (@id, @role, @name, @email, @password_hash, @phone, @phone_network, @country, @town, @campus, @school_name, @parent_id, @status, @payment_status, date('now'), @class_id, @student_code, @own_robotics_kit, @age)`
      );
      // Enrollment Activation pipeline (v30): Registration only ever
      // expresses intent to enrol — the actual `enrollments` (Module
      // access) rows are no longer written here. Whatever module(s) were
      // selected are stashed as JSON on the primary programme_enrollments
      // row below (requested_course_ids) and only turned into real
      // Module access by utils/learningInstances.js's
      // activateEnrollmentCurriculum, called from
      // utils/paymentActivation.js (successful payment) or the Hub
      // access-override grant (routes/users.js) — never from here.
      const requestedModuleIdsJSON = Array.isArray(courseIds) && courseIds.length ? JSON.stringify(courseIds) : null;
      // Fallback used only in the pre-existing edge case where no
      // Kids STEM programme/entry class could be resolved at all (see
      // `foundation` above) — there's no programme_enrollments row to
      // defer onto in that case, so this preserves the historical
      // immediate-enrol behaviour rather than silently dropping the
      // learner's module selection with no way to ever grant it.
      const enrollDirectly = db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)");
      // Records this learner's ORIGINAL/primary programme placement in the
      // same programme_enrollments table routes/enrolments.js uses for
      // *additional* programme signups. Without this, a self-registered
      // account (created after the one-time migration backfill) would show
      // up empty in "My Programmes" and — worse — the enrolments.js
      // duplicate-enrolment check (which only looks at programme_enrollments)
      // would never notice the account is already in this exact programme,
      // letting it "additionally" re-enrol into the one it just registered
      // for. is_primary rows start out mirroring the learner's own
      // status/payment_status and are kept in sync from then on by
      // utils/paymentActivation.js and the admin manual payment-status route.
      const insertPrimaryEnrollment = db.prepare(
        `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id, participation_structure, requested_course_ids, delivery_mode, campus_id, academic_period_id, course_group_id, operational_group_id, pricing_snapshot, financial_policy_snapshot)
         VALUES (?, ?, ?, ?, 1, ?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      // Every NEW registration enrols into the Active Programme Run for the
      // programme it's joining. The pre-check above already guarantees this
      // is non-null whenever `foundation` is set; only the true "no
      // Programme/Learning Group selected at all" edge case leaves this null.
      const entryLearningInstanceId = entryLearningInstanceIdPreCheck;
      // v31 — every enrolment records the operational context it was
      // actually created under (Delivery Mode, Campus, Academic Period,
      // Course Group), resolved once here since it's identical for every
      // ward in this registration (they all join the same foundation
      // Class/Run).
      const operationalSnapshot =
        foundation || individualCourseEntryInstance
          ? deriveEnrollmentOperationalSnapshot({ classRow: foundation, instanceId: entryLearningInstanceId, courseIds, operationalGroupId: requestedOperationalGroupId || null })
          : { deliveryMode: null, campusId: null, academicPeriodId: null, courseGroupId: null, operationalGroupId: null };

      // Every learner's login credentials are generated automatically — the
      // parent no longer sets a username/password for their child(ren).
      const createdLearners = [];
      const tx = db.transaction(() => {
        const capCheck = checkOperationalGroupCapacity(requestedOperationalGroupId, entryLearningInstanceIdPreCheck, learnerList.length);
        if (!capCheck.ok) {
          throw Object.assign(new Error(capCheck.error), { status: 409 });
        }
        insertUser.run({ id: parentId, role: "parent", name: parent.name, email: parent.email, password_hash: parentHash, phone: parent.phone, phone_network: null, country: parentCountry, town: parentTown, campus: null, school_name: null, parent_id: null, status: "active", payment_status: "current", class_id: null, student_code: null, own_robotics_kit: 0, age: null });

        learnerList.forEach((l, idx) => {
          const learnerId = uuid();
          const learnerPassword = generateLearnerPassword();
          const learnerHash = bcrypt.hashSync(learnerPassword, 12);
          const studentCode = nextStudentCode();
          // Short + memorable: first name + the student code's year/sequence
          // (e.g. "kid260001"), instead of a random UUID slice. studentCode
          // is already guaranteed unique, so this stays unique too.
          const firstName = (l.name.split(" ")[0] || "learner").toLowerCase().replace(/[^a-z0-9]/g, "") || "learner";
          const codeDigits = studentCode.replace(/^DTL-\d\d/, "").replace(/-/g, ""); // "2026-0001" -> "260001"
          const learnerEmail = `${firstName}${codeDigits}@learners.dalijaytechhub.online`;
          const learnerAge = l.age !== undefined && l.age !== null && l.age !== "" ? Number(l.age) : null;
          const isIndividual = requestedParticipationStructure === "individual_course";
          const effectiveLearnerClassId = isIndividual ? null : foundation ? foundation.id : null;
          // See the entryLearningInstanceIdPreCheck comment above: a
          // classless Individual Course registration must still get a real
          // programme_enrollments row (with the Instance's own programme_id,
          // since there's no `foundation` Class to read one off).
          const enrollmentProgrammeId = foundation ? foundation.programme_id : individualCourseEntryInstance ? individualCourseEntryInstance.programmeId : null;
          insertUser.run({ id: learnerId, role: "learner", name: l.name, email: learnerEmail, password_hash: learnerHash, phone: parent.phone, phone_network: parent.phoneNetwork || null, country: parentCountry, town: parentTown, campus: resolvedCampuses[idx], school_name: l.schoolName ? String(l.schoolName).trim() : null, parent_id: parentId, status: "pending_payment", payment_status: "unpaid", class_id: effectiveLearnerClassId, student_code: studentCode, own_robotics_kit: l.ownRoboticsKit ? 1 : 0, age: learnerAge });
          if (foundation || individualCourseEntryInstance) {
            const primaryEnrollmentId = uuid();
            // §17 Pricing Snapshot / Financial Policy Snapshot — resolved
            // ONCE, at the moment of enrollment, through the one Pricing
            // Engine (§15.13), and frozen onto the row from here on. Batch
            // siblings registered together don't have DB rows/parent_id
            // relationships to query yet, so rank is purely positional
            // within this signup — the same rule utils/fees.js's
            // registrationBreakdown() already uses for this exact scenario.
            const siblingRank = learnerList.length > 1 ? idx + 1 : null;
            const pricingSnapshot = pricingEngine.buildPricingSnapshot({
              learningInstanceId: entryLearningInstanceId,
              classId: effectiveLearnerClassId,
              operationalGroupId: operationalSnapshot.operationalGroupId,
              siblingRank,
              // Keeps this snapshot's registration amount identical to what
              // registrationBreakdown() actually charges this same learner
              // a few lines below — see pricingEngine.js's
              // applyLegacyRegistrationAdjustments.
              legacyAdjustmentContext: { campus: resolvedCampuses[idx], school_name: l.schoolName, own_robotics_kit: l.ownRoboticsKit },
            });
            const financialPolicySnapshot = pricingEngine.buildFinancialPolicySnapshot({ learningInstanceId: entryLearningInstanceId });
            insertPrimaryEnrollment.run(
              primaryEnrollmentId,
              learnerId,
              enrollmentProgrammeId,
              effectiveLearnerClassId,
              "pending_payment",
              "unpaid",
              entryLearningInstanceId,
              requestedParticipationStructure,
              requestedModuleIdsJSON,
              operationalSnapshot.deliveryMode,
              operationalSnapshot.campusId,
              operationalSnapshot.academicPeriodId,
              operationalSnapshot.courseGroupId,
              operationalSnapshot.operationalGroupId,
              pricingSnapshot,
              financialPolicySnapshot
            );
            // ABRS v2.1 Phase 3 Checkpoint 3a (Appendix A-4) — normalize
            // this learner's Course selection alongside the legacy
            // requestedModuleIdsJSON write above.
            recordEnrollmentCourseSelections(primaryEnrollmentId, entryLearningInstanceId, courseIds);

            if (!isIndividual && effectiveLearnerClassId) {
              db.prepare(
                `INSERT INTO promotion_log (id, learner_id, action, details, performed_by)
                 VALUES (?, ?, 'initial_placement', ?, ?)`
              ).run(
                uuid(),
                learnerId,
                JSON.stringify({
                  classId: effectiveLearnerClassId,
                  className: foundation.name,
                  learningInstanceId: entryLearningInstanceId,
                  academicPeriodId: operationalSnapshot.academicPeriodId,
                  placementType: "initial_placement",
                  reason: "Registration initial level placement"
                }),
                parentId
              );
            }
          } else {
            (courseIds || []).forEach((m) => enrollDirectly.run(learnerId, m));
          }
          createdLearners.push({ learnerId, name: l.name, learnerLoginEmail: learnerEmail, learnerPassword, studentCode });
        });
      });
      tx();

      // Log the parent in immediately — the payment step that follows
      // registration calls an authenticated endpoint (requireSelfParentOrStaff),
      // and without a session that call fails with "Not signed in."
      issueSession(res, { id: parentId, role: "parent" });

      const idList = createdLearners.map((l) => l.studentCode).join(", ");
      const { breakdown, totalGHS } = registrationBreakdown(
        learnerList.map((l, idx) => ({
          name: l.name,
          campus: resolvedCampuses[idx],
          schoolName: l.schoolName,
          ownRoboticsKit: l.ownRoboticsKit,
          classId: foundation ? foundation.id : null,
          programmeId: foundation ? foundation.programme_id : programmeId || null,
          learningInstanceId: entryLearningInstanceIdPreCheck,
          operationalGroupId: requestedOperationalGroupId || null,
        }))
      );
      return res.json({
        ok: true,
        parentId,
        learners: createdLearners,
        registrationBreakdown: breakdown,
        registrationTotalGHS: totalGHS,
        // Kept for backward compatibility with the single-ward flow/older frontend builds.
        learnerId: createdLearners[0].learnerId,
        learnerLoginEmail: createdLearners[0].learnerLoginEmail,
        learnerPassword: createdLearners[0].learnerPassword,
        studentCode: createdLearners[0].studentCode,
        message: createdLearners.length > 1
          ? `Account created for ${createdLearners.length} learners. Their unique student IDs are: ${idList} — use these as the reference when paying via Mobile Money. Complete payment for each to activate their access. Save each learner's generated login credentials shown below.`
          : `Account created. Your learner's unique student ID is ${idList} — use this as the reference when paying via Mobile Money. Complete payment to activate the learner's access, then sign in with the generated credentials shown below.`,
      });
    }

    if (kind === "adult") {
      if (!adult?.name || !adult?.email || !adult?.password) {
        return res.status(400).json({ error: "Fill in every required field." });
      }
      if (!isValidEmail(adult.email)) {
        return res.status(400).json({ error: "Enter a valid email address." });
      }
      if (!isStrongPassword(adult.password)) {
        return res.status(400).json({ error: passwordMessage(adult.password) });
      }
      if (adult.confirmPassword !== undefined && adult.password !== adult.confirmPassword) {
        return res.status(400).json({ error: "Your password and confirmation don't match." });
      }
      const adultCountryResult = resolveCountry(adult.country);
      if (adultCountryResult.error) return res.status(400).json({ error: adultCountryResult.error });
      const adultCountryCode = adultCountryResult.code;
      const adultTown = resolveTown(adult.town);
      adult.email = String(adult.email).toLowerCase().trim();
      if (db.prepare("SELECT id FROM users WHERE email = ?").get(adult.email)) {
        return res.status(409).json({ error: "An account with this email already exists." });
      }

      // Optional Programme + Batch/Cohort selection (Unified Learning
      // Architecture) — lets an adult self-register into an Adult
      // Professional / Bootcamp programme's specific Learning Group instead
      // of the historical campus='Adult / self-paced', no-class account.
      // Omitting classId keeps the exact pre-existing behaviour (a plain
      // adult learner with no programme/class), so older frontend builds
      // and the generic "no offering selected" case both still work.
      // Same root cause as the parent-learner path above (see its comment):
      // Individual Course Runs have no Class, so an adult self-registering
      // into one (classId/programmeId both omitted — the normal case for a
      // programme that only offers Individual Course Runs) left `classRow`
      // null and skipped enrollment/pricing-snapshot creation entirely,
      // even with a validated learningInstanceId in the request. Resolved
      // directly here, independent of the Class-based branches below.
      let individualCourseAdultInstance = null;
      if (requestedParticipationStructure === "individual_course" && req.body.learningInstanceId) {
        const candidate = getLearningInstanceById(req.body.learningInstanceId);
        if (candidate && candidate.participationStructure === "individual_course") {
          individualCourseAdultInstance = candidate;
        } else {
          return res.status(400).json({ error: "learningInstanceId must refer to an active Individual Course Learning Instance." });
        }
      }

      let classRow = null;
      let corporateClientId = null;
      const { classId } = req.body;
      if (classId) {
        classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
        if (!classRow) return res.status(400).json({ error: "Unknown classId (Learning Group)." });
        if (programmeRequiresParent(classRow.programme_id)) {
          return res.status(400).json({ error: "This Learning Group's offering type requires a parent account — use the Parent + Child registration instead." });
        }
        if (!programmeAllowsSelfRegistration(classRow.programme_id)) {
          return res.status(400).json({ error: "Self-registration isn't open for this programme — contact the admin to be enrolled." });
        }
        const programme = db.prepare("SELECT * FROM programmes WHERE id = ?").get(classRow.programme_id);
        corporateClientId = (programme && programme.corporate_client_id) || null;
        if (programme && !programmeAllowsAudience(programme, "adult")) {
          return res.status(400).json({ error: "This programme is only open to child (Parent + Child) registration." });
        }
        if (programme && !resolveProgrammeRegistrationOpen(programme, req.body.operationalGroupId)) {
          return res.status(409).json({ error: "Registration for this programme is currently closed — contact the admin." });
        }
        if (programme) {
          const resolvedRun = resolveActiveInstanceForRegistration(programme.id, req.body.operationalGroupId, req.body.learningInstanceId, requestedParticipationStructure);
          if (resolvedRun.ambiguous) {
            return res.status(409).json({
              error: "This programme currently has more than one active run — choose which one to register into.",
              activeRuns: resolvedRun.options.map((o) => ({ id: o.id, name: o.name })),
            });
          }
        }
      } else if (req.body.programmeId) {
        // Same bypass this branch closes for the parent-learner path above:
        // a bare programmeId (no explicit classId) must resolve into the
        // programme's entry class and be checked exactly as if that class
        // had been sent explicitly, not silently skipped.
        classRow = resolveEntryClass(req.body.programmeId);
        if (classRow) {
          if (programmeRequiresParent(classRow.programme_id)) {
            return res.status(400).json({ error: "This Learning Group's offering type requires a parent account — use the Parent + Child registration instead." });
          }
          if (!programmeAllowsSelfRegistration(classRow.programme_id)) {
            return res.status(400).json({ error: "Self-registration isn't open for this programme — contact the admin to be enrolled." });
          }
          const programme = db.prepare("SELECT * FROM programmes WHERE id = ?").get(classRow.programme_id);
          corporateClientId = (programme && programme.corporate_client_id) || null;
          if (programme && !programmeAllowsAudience(programme, "adult")) {
            return res.status(400).json({ error: "This programme is only open to child (Parent + Child) registration." });
          }
          if (programme && !resolveProgrammeRegistrationOpen(programme, req.body.operationalGroupId)) {
            return res.status(409).json({ error: "Registration for this programme is currently closed — contact the admin." });
          }
          if (programme) {
            const resolvedRun = resolveActiveInstanceForRegistration(programme.id, req.body.operationalGroupId, req.body.learningInstanceId, requestedParticipationStructure);
            if (resolvedRun.ambiguous) {
              return res.status(409).json({
                error: "This programme currently has more than one active run — choose which one to register into.",
                activeRuns: resolvedRun.options.map((o) => ({ id: o.id, name: o.name })),
              });
            }
          }
        }
      }

      // Registration Source of Truth: same hard gate as the parent-learner
      // path — a resolved Programme/Learning Group with no Active Programme
      // Run means there is no valid registration opportunity right now.
      //
      // ABRS v2.2 amendment (concurrent Programme Runs): same fix as the
      // parent-learner path above — this is the authoritative resolution
      // point for which Run this adult registration attaches to, so it must
      // use the disambiguation-aware resolver, not the legacy "most
      // recently activated" default (see the matching note above).
      let adultLearningInstanceIdPreCheck = null;
      if (individualCourseAdultInstance) {
        adultLearningInstanceIdPreCheck = individualCourseAdultInstance.id;
      } else if (classRow) {
        const resolvedAdultRun = resolveActiveInstanceForRegistration(classRow.programme_id, req.body.operationalGroupId, req.body.learningInstanceId, requestedParticipationStructure);
        if (resolvedAdultRun.ambiguous) {
          return res.status(409).json({
            error: "This programme currently has more than one active run — choose which one to register into.",
            activeRuns: resolvedAdultRun.options.map((o) => ({ id: o.id, name: o.name })),
          });
        }
        adultLearningInstanceIdPreCheck = resolvedAdultRun.instance ? resolvedAdultRun.instance.id : null;
      }
      if (classRow && !individualCourseAdultInstance && !adultLearningInstanceIdPreCheck) {
        return res.status(409).json({ error: "There are currently no available registration opportunities for this programme — an admin has not opened an active registration run yet." });
      }

      // §17/§18 — same optional Operational Group selection as the
      // parent-learner path above.
      const { operationalGroupId: requestedAdultOperationalGroupId } = req.body;
      if (requestedAdultOperationalGroupId) {
        if (!adultLearningInstanceIdPreCheck) {
          return res.status(400).json({ error: "operationalGroupId was provided but no Programme Run could be resolved for this registration." });
        }
        const adultGroup = db.prepare("SELECT id, learning_instance_id, is_active FROM operational_groups WHERE id = ?").get(requestedAdultOperationalGroupId);
        if (!adultGroup || adultGroup.learning_instance_id !== adultLearningInstanceIdPreCheck || !adultGroup.is_active) {
          return res.status(400).json({ error: "operationalGroupId is not a valid, active Operational Group for this programme's current Programme Run." });
        }
      }

      // Course ID Authority — this route never REQUIRES courseIds for the
      // adult path (Adult Professional/Corporate/Bootcamp organize by
      // Programme + Batch/Cohort, not module selection — see comment at the
      // top of this handler), but if a client submits them anyway they must
      // not be trusted blindly: they get stored on requested_course_ids and
      // are ultimately granted as real course access via
      // resolveRunConfiguredCourseCurriculum. For an Adult Professional
      // Programme, restrict them to courses actually configured/eligible on
      // the resolved Programme Run — never an arbitrary courseId for an
      // unrelated course/programme.
      if (Array.isArray(courseIds) && courseIds.length && classRow) {
        const offeringType = getOfferingTypeForProgramme(classRow.programme_id);
        if (offeringType && usesRunScopedCourseCurriculum(offeringType.slug)) {
          const eligible = new Set(getEligibleCoursesForRun(adultLearningInstanceIdPreCheck, classRow.programme_id));
          const invalidCourseIds = courseIds.filter((cid) => !eligible.has(cid));
          if (invalidCourseIds.length) {
            return res.status(400).json({
              error: "One or more courses are not configured for this Programme Run.",
              invalidCourseIds,
            });
          }
        }
      }

      const id = uuid();
      const hash = bcrypt.hashSync(adult.password, 12);
      const studentCode = nextStudentCode();
      const eduLevel = ["Senior High", "Tertiary", "None"].includes(adult.educationLevel) ? adult.educationLevel : "None";
      // Delivery-Mode-aware campus resolution (see resolveCampusForRegistration)
      // — only applies once the chosen Batch/Cohort actually carries a
      // delivery_mode. Every legacy/no-classId/no-delivery-mode case below
      // keeps the exact historical fallback: an explicit campus selection,
      // or the historical placeholder when omitted.
      let adultCampus;
      if (classRow && classRow.delivery_mode) {
        const campusResult = resolveCampusForRegistration(classRow, adult.campus ? String(adult.campus).trim() : null);
        if (campusResult.error) return res.status(400).json({ error: campusResult.error });
        adultCampus = campusResult.campus;
      } else {
        // No class at all (fully self-paced) — same best-effort
        // normalization as the legacy branch of resolveCampusForRegistration:
        // use the canonical spelling if the free text matches a real
        // campus, otherwise fall back exactly as before.
        const raw = adult.campus ? String(adult.campus).trim() : null;
        const resolved = resolveCampusByName(raw);
        adultCampus = resolved ? resolved.name : raw || "Adult / self-paced";
      }
      const isAdultIndividual = requestedParticipationStructure === "individual_course";
      const effectiveAdultClassId = isAdultIndividual ? null : classRow ? classRow.id : null;
      // See individualCourseAdultInstance's comment above: a classless
      // Individual Course self-registration must still get a real
      // programme_enrollments row, using the Instance's own programme_id
      // since there's no classRow to read one off.
      const adultEnrollmentProgrammeId = classRow ? classRow.programme_id : individualCourseAdultInstance ? individualCourseAdultInstance.programmeId : null;
      const tx = db.transaction(() => {
        const capCheck = checkOperationalGroupCapacity(requestedAdultOperationalGroupId, adultLearningInstanceIdPreCheck, 1);
        if (!capCheck.ok) {
          throw Object.assign(new Error(capCheck.error), { status: 409 });
        }
        db.prepare(
          `INSERT INTO users (id, role, name, email, password_hash, phone, phone_network, country, town, campus, status, payment_status, joined_date, is_adult, student_code, own_robotics_kit, education_level, class_id, corporate_client_id)
           VALUES (?, 'learner', ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', 'unpaid', date('now'), 1, ?, ?, ?, ?, ?)`
        ).run(id, adult.name, adult.email, hash, adult.phone, adult.phoneNetwork || null, adultCountryCode, adultTown, adultCampus, studentCode, adult.ownRoboticsKit ? 1 : 0, eduLevel, effectiveAdultClassId, corporateClientId);
        if (classRow || individualCourseAdultInstance) {
          const adultLearningInstanceId = adultLearningInstanceIdPreCheck;
          const adultRequestedModuleIdsJSON = Array.isArray(courseIds) && courseIds.length ? JSON.stringify(courseIds) : null;
          const adultOperationalSnapshot = deriveEnrollmentOperationalSnapshot({
            classRow,
            instanceId: adultLearningInstanceId,
            courseIds,
            operationalGroupId: requestedAdultOperationalGroupId || null,
          });
          const adultPrimaryEnrollmentId = uuid();
          const adultPricingSnapshot = pricingEngine.buildPricingSnapshot({
            learningInstanceId: adultLearningInstanceId,
            classId: effectiveAdultClassId,
            operationalGroupId: adultOperationalSnapshot.operationalGroupId,
            corporateClientId: corporateClientId || null,
            legacyAdjustmentContext: { campus: adultCampus, school_name: null, own_robotics_kit: adult.ownRoboticsKit },
          });
          const adultFinancialPolicySnapshot = pricingEngine.buildFinancialPolicySnapshot({ learningInstanceId: adultLearningInstanceId });
          db.prepare(
            `INSERT INTO programme_enrollments (id, user_id, programme_id, class_id, is_primary, status, payment_status, joined_date, learning_instance_id, participation_structure, requested_course_ids, delivery_mode, campus_id, academic_period_id, course_group_id, operational_group_id, pricing_snapshot, financial_policy_snapshot)
             VALUES (?, ?, ?, ?, 1, 'pending_payment', 'unpaid', date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            adultPrimaryEnrollmentId,
            id,
            adultEnrollmentProgrammeId,
            effectiveAdultClassId,
            adultLearningInstanceId,
            requestedParticipationStructure,
            adultRequestedModuleIdsJSON,
            adultOperationalSnapshot.deliveryMode,
            adultOperationalSnapshot.campusId,
            adultOperationalSnapshot.academicPeriodId,
            adultOperationalSnapshot.courseGroupId,
            adultOperationalSnapshot.operationalGroupId,
            adultPricingSnapshot,
            adultFinancialPolicySnapshot
          );
          // ABRS v2.1 Phase 3 Checkpoint 3a (Appendix A-4) — same
          // normalization as the parent-learner branch above (in
          // practice usually a no-op here — see comment above
          // adultRequestedModuleIdsJSON).
          recordEnrollmentCourseSelections(adultPrimaryEnrollmentId, adultLearningInstanceId, courseIds);
        } else {
          // No classRow (no Programme/Batch selected) means there's no
          // programme_enrollments row to defer onto — preserves the exact
          // historical immediate-enrol fallback for that edge case, same
          // reasoning as the parent-learner branch above.
          const enrollDirectly = db.prepare("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)");
          (courseIds || []).forEach((m) => enrollDirectly.run(id, m));
        }
      });
      tx();
      issueSession(res, { id, role: "learner" });
      return res.json({ ok: true, learnerId: id, studentCode, message: `Account created. Your unique ID is ${studentCode}. Complete payment yourself (no parent account is linked) to activate your access.` });
    }

    return res.status(400).json({ error: "Unknown registration type." });
  } catch (e) {
    console.error(e);
    const status = e && e.status ? e.status : 500;
    const message = status !== 500 ? e.message : "Registration failed. Please try again.";
    return res.status(status).json({ error: message });
  }
});

// POST /api/auth/registration-fee-preview — public (no account exists yet),
// read-only. Bug fix: RegisterPage.jsx's payment step used to show the flat
// Site Settings > Fees global default as the "Registration total" the whole
// time the parent/adult was on that screen, because the real total
// (registrationTotalGHS) only ever came back from POST /register itself —
// i.e. only after they'd already entered their Mobile Money number and hit
// Pay. So a Kids STEM registration whose Offering Type (or a specific
// Programme/Batch-Cohort) had its own fee configured via Offering Type
// Settings > Fees / a Learning Group's own fee would still show the
// site-wide default number right up until the moment of payment, even
// though the amount actually charged was always correct — the *preview*,
// not the charge, was wrong. This resolves the same classId (falling back
// to the classic Kids STEM entry class exactly like /register does when
// programmeId/classId are both omitted) and calls the exact same
// registrationBreakdown() /register uses to compute the real charge, so
// the number shown here can never disagree with what actually gets billed.
router.post("/registration-fee-preview", (req, res) => {
  try {
    const kind = req.body.kind === "adult" ? "adult" : "parent-learner";
    const programmeId = req.body.programmeId || null;
    const requestedClassId = req.body.classId || null;
    const requestedParticipationStructure = req.body.participationStructure || null;

    // Bug fix: an Individual Course Run has no Class at all, but this
    // endpoint used to always derive `classId` from
    // resolveEntryClass(programmeId) — which, for a programme that ALSO
    // has unrelated Classes (e.g. a Foundation class used by a different,
    // structured journey under the same programme), returns that
    // unrelated class. registrationBreakdown()'s resolveRunContext then
    // prioritizes a non-null classId's own Active Run over the explicit
    // learningInstanceId the parent actually picked — silently pricing a
    // completely different Learning Instance, exactly like the /register
    // bug this same fix addresses. Resolved directly, independent of
    // classId/foundation, whenever the request is for an Individual
    // Course.
    let individualCoursePreviewInstance = null;
    if (requestedParticipationStructure === "individual_course" && req.body.learningInstanceId) {
      const candidate = getLearningInstanceById(req.body.learningInstanceId);
      if (candidate && candidate.participationStructure === "individual_course") {
        individualCoursePreviewInstance = candidate;
      }
    }

    let foundation = null;
    if (individualCoursePreviewInstance) {
      foundation = null;
    } else if (requestedClassId) {
      foundation = db.prepare("SELECT * FROM classes WHERE id = ?").get(requestedClassId);
      if (!foundation) return res.status(400).json({ error: "Unknown classId (Batch/Cohort)." });
    } else if (programmeId) {
      foundation = resolveEntryClass(programmeId);
    } else if (kind === "parent-learner") {
      // Same historical Kids STEM fallback as /register.
      const kidsStemProgramme = getDefaultProgrammeForOfferingSlug("kids_stem");
      foundation = kidsStemProgramme ? resolveEntryClass(kidsStemProgramme.id) : null;
    }

    if (kind === "adult") {
      const adult = req.body.adult || {};
      const { breakdown, totalGHS } = registrationBreakdown([
        {
          name: adult.name || "You",
          campus: previewCampusForDeliveryMode(foundation, adult.campus || null),
          schoolName: null,
          ownRoboticsKit: !!adult.ownRoboticsKit,
          classId: individualCoursePreviewInstance ? null : foundation ? foundation.id : null,
          programmeId: individualCoursePreviewInstance ? individualCoursePreviewInstance.programmeId : foundation ? foundation.programme_id : programmeId || null,
          learningInstanceId: individualCoursePreviewInstance ? individualCoursePreviewInstance.id : req.body.learningInstanceId || null,
          operationalGroupId: req.body.operationalGroupId || null,
        },
      ]);
      return res.json({ breakdown, totalGHS });
    }

    const learners = Array.isArray(req.body.learners) ? req.body.learners : [];
    const { breakdown, totalGHS } = registrationBreakdown(
      learners.map((l) => ({
        name: l.name || "Child",
        campus: previewCampusForDeliveryMode(foundation, l.campus || null),
        schoolName: l.schoolName || null,
        ownRoboticsKit: !!l.ownRoboticsKit,
        classId: individualCoursePreviewInstance ? null : foundation ? foundation.id : null,
        programmeId: individualCoursePreviewInstance ? individualCoursePreviewInstance.programmeId : foundation ? foundation.programme_id : programmeId || null,
        learningInstanceId: individualCoursePreviewInstance ? individualCoursePreviewInstance.id : req.body.learningInstanceId || null,
        operationalGroupId: req.body.operationalGroupId || null,
      }))
    );
    return res.json({ breakdown, totalGHS });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Couldn't calculate the fee preview." });
  }
});

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").toLowerCase().trim());
  if (!row || !row.password_hash || !bcrypt.compareSync(password || "", row.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  if (row.status === "suspended") {
    return res.status(403).json({ error: "This account has been suspended. Contact the admin." });
  }
  // The sponsor/coordinator's credential view (GET /:parentId/children/
  // credentials) only ever needs the plaintext up until the learner
  // signs in for themselves once — once that's happened, they know
  // their own password, so drop it rather than keep it sitting in the
  // database indefinitely.
  if (row.temp_password_plaintext) {
    db.prepare("UPDATE users SET temp_password_plaintext = NULL WHERE id = ?").run(row.id);
  }
  issueSession(res, row);
  res.json({ ok: true, user: getFullUser(row.id, { viewerRole: row.role }) });
});

router.post("/logout", (req, res) => {
  res.clearCookie("dtl_token", cookieOpts());
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: getFullUser(req.user.id, { viewerRole: req.user.role }) });
});

module.exports = router;
