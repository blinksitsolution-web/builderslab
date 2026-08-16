const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { campusScopeFor, corporateClientScopeFor } = require("../utils/rbac");
const {
  LEARNING_INSTANCE_STATUSES,
  LEARNING_INSTANCE_SELECT,
  isValidStatus,
  toLearningInstanceDto,
  getLearningInstanceById,
  validateOfferingTypeAssociation,
  assertTransitionAllowed,
  instructorProgrammeAndCourseIds,
  instanceBelongsToInstructor,
  syncTargetStatuses,
  addTarget,
  removeTarget,
  setAcademicStructure,
  updateAcademicPeriod,
  getPeriodTargets,
  setPeriodTargets,
  getLearnerActiveTargetsInPeriod,
  setPeriodPaymentRequirement,
  clearStaleFirstPeriodPaymentConfigIfCombined,
  getCurrentAcademicPeriod,
  getAcademicPeriodById,
  PARTICIPATION_STRUCTURES,
  isValidParticipationStructure,
  isParticipationStructureAllowedForOfferingType,
  ensureActivatedCourse,
  updateActivatedCourse,
  assignCourseToInstance,
  deactivateCourseFromInstance,
  resolveParticipationStructureConfig,
  getProgrammeParticipationStructures,
  ensureLearningInstanceParticipationStructureActivation,
  getOperationalGroupsForInstance,
  getOperationalGroupById,
  createOperationalGroup,
  updateOperationalGroup,
  retireOrDeleteOperationalGroup,
} = require("../utils/learningInstances");
const { getPeriodPaymentStatus } = require("../utils/periodPayments");
const { getOfferingTypeById, offeringTypeUsesParticipationStructuresV2, offeringTypeEnforcesPublishReadiness } = require("../utils/offeringTypeSettings");

// ABRS v2.1 Phase 5 prerequisite — shared by POST / and PATCH /:id below,
// same rationale as enrolments.js's copy of this pattern: one place that
// decides what a valid participationStructure is for a given
// offeringTypeId + programmeId, so the two write sites can never
// disagree (§17.2). Byte-for-byte the historical hardcoded-enum
// error/behaviour unless that offering type has opted into
// participationStructuresV2Enabled.
function validateRunParticipationStructure(offeringTypeId, programmeId, value) {
  const offeringType = offeringTypeId ? getOfferingTypeById(offeringTypeId) : null;
  if (offeringTypeUsesParticipationStructuresV2(offeringType) && programmeId && value != null) {
    const config = resolveParticipationStructureConfig(programmeId, value);
    if (!config) {
      const available = getProgrammeParticipationStructures(programmeId).map((s) => s.key);
      return {
        error: available.length
          ? `participationStructure must be one of: ${available.join(", ")}.`
          : "This programme has no Participation Structures configured — contact the admin.",
      };
    }
    return {};
  }
  if (!isValidParticipationStructure(value) || !isParticipationStructureAllowedForOfferingType(offeringType, value)) {
    return { error: `participationStructure must be one of: ${PARTICIPATION_STRUCTURES.join(", ")}` };
  }
  return {};
}

const router = express.Router();

// Read access for the Instructor Portal: an instructor never has
// learningInstances.view (that's an Admin Portal permission), but they do
// need to see the runs of their own assigned Programmes/Modules — "Display
// only the Learning Instances assigned to the instructor." Admin/anyone
// with the permission passes through unchanged; an instructor is let
// through here and scoped inside each handler instead.
function viewableByInstructorOrPermission(req, res, next) {
  if (req.user && req.user.role === "instructor") return next();
  return requirePermission("learningInstances.view")(req, res, next);
}

// A conflicting-active-run 409 always names the other instance, so the
// admin knows exactly what to deactivate/complete/cancel first instead of
// guessing.
function conflictResponse(res, conflictRow) {
  const conflict = toLearningInstanceDto(db.prepare(`${LEARNING_INSTANCE_SELECT} WHERE li.id = ?`).get(conflictRow.id));
  return res.status(409).json({
    error: `"${conflict.name || conflict.id}" is already the Active Learning Instance for this ${conflict.programmeId ? "Programme" : "Module"} — only one Active run is allowed at a time.`,
    conflictingInstance: conflict,
  });
}

// GET /api/learning-instances — list, optionally filtered. Learning
// Offering Type stays the primary lookup context (offeringTypeId is always
// present on every row and always filterable), consistent with the rest of
// this architecture.
router.get("/", requireAuth, viewableByInstructorOrPermission, (req, res) => {
  const { offeringTypeId, programmeId, courseId, status } = req.query;
  let sql = `${LEARNING_INSTANCE_SELECT} WHERE 1=1`;
  const params = [];
  if (offeringTypeId) { sql += " AND li.offering_type_id = ?"; params.push(offeringTypeId); }
  if (programmeId) { sql += " AND li.programme_id = ?"; params.push(programmeId); }
  if (courseId) { sql += " AND li.course_id = ?"; params.push(courseId); }
  if (status) {
    if (!isValidStatus(status)) return res.status(400).json({ error: `status must be one of: ${LEARNING_INSTANCE_STATUSES.join(", ")}` });
    sql += " AND li.status = ?"; params.push(status);
  }

  // Instructor scoping: never a global list — only runs of Programmes/
  // Modules this instructor is actually assigned to. A requested
  // programmeId/courseId outside that set is rejected outright (403)
  // rather than silently returning nothing, so the Instructor Portal gets
  // a clear signal instead of a confusing empty list.
  if (req.user.role === "instructor") {
    const { programmeIds, courseIds, instanceIds } = instructorProgrammeAndCourseIds(req.user.id);
    if (programmeId && !programmeIds.has(programmeId)) return res.status(403).json({ error: "You haven't been assigned to this Programme." });
    if (courseId && !courseIds.has(courseId)) return res.status(403).json({ error: "You haven't been assigned to this Module." });
    if (!programmeId && !courseId) {
      const iIds = [...instanceIds];
      if (!iIds.length) return res.json({ learningInstances: [] });
      sql += ` AND li.id IN (${iIds.map(() => "?").join(",")})`;
      params.push(...iIds);
    }
  }

  sql += " ORDER BY li.start_date IS NULL, li.start_date DESC, li.created_at DESC";
  const rows = db.prepare(sql).all(...params);
  res.json({ learningInstances: rows.map(toLearningInstanceDto) });
});

// GET /api/learning-instances/dashboard-stats — Admin Overview's grouped
// statistics. One row per Learning Instance (the finest grain in this
// architecture — Offering Type/Programme/Module are all attributes of a
// row already, via LEARNING_INSTANCE_SELECT's joins), each carrying its own
// Active Learners / Active Enrolments / Payments / Programme Completion —
// reusing the existing `learning_instances` / `programme_enrollments` /
// `payments` relationships and tagging exactly as the previous milestones
// built them; nothing here re-tags or re-derives that data.
//
// Filter contract is deliberately identical to GET /api/users and
// GET /api/payments/overview (offeringTypeId, programmeId, courseId,
// learningInstanceId, learningInstanceScope) so the same shared
// "Learning Instance scope" filter trio already used by Manage Accounts/
// Payments/Transcripts/Certificates can be reused here unchanged:
//   - no params at all from that trio never happens (it always sends
//     learningInstanceScope=active by default) — Active Learning Instances
//     only, by default, exactly as required.
//   - explicitly picking one specific run sends learningInstanceId.
//   - explicitly picking "All Learning Instances (consolidated)" sends
//     neither param — every run (active AND historical) is returned, each
//     still in its own row/labeled by its own status, never summed into a
//     single blended figure unless the admin's own totals card does that
//     over the explicitly-consolidated set.
//
// §21 closes out the full list of named Reporting dimensions this report
// didn't yet support: instructorId (a Run-level field, filtered the same
// way offeringTypeId/programmeId are, just below), plus six more that all
// live on the Enrollment rather than the Run — operationalGroupId,
// classId (Programme Level, §13), participationStructure (§12), campusId,
// deliveryMode, and academicPeriodId. Institution has no filter because
// it's an implicit singleton (Appendix A-7); Course was already covered
// by courseId above. Every one of these seven is optional/additive — a
// caller that sends none of them gets byte-for-byte the same query and
// the same numbers as before this change.
router.get("/dashboard-stats", requireAuth, requirePermission("dashboard.view"), (req, res) => {
  const {
    offeringTypeId, programmeId, courseId, learningInstanceId, learningInstanceScope,
    instructorId, operationalGroupId, classId, participationStructure, campusId, deliveryMode, academicPeriodId,
  } = req.query;

  if (participationStructure && !isValidParticipationStructure(participationStructure)) {
    return res.status(400).json({ error: `participationStructure must be one of: ${PARTICIPATION_STRUCTURES.join(", ")}` });
  }
  if (deliveryMode && !OPERATIONAL_DELIVERY_MODES.includes(deliveryMode)) {
    return res.status(400).json({ error: `deliveryMode must be one of: ${OPERATIONAL_DELIVERY_MODES.join(", ")}.` });
  }

  let sql = `${LEARNING_INSTANCE_SELECT} WHERE 1=1`;
  const params = [];
  if (offeringTypeId) { sql += " AND li.offering_type_id = ?"; params.push(offeringTypeId); }
  // §21/§8.4 — filtering by Programme/Course must resolve through
  // learning_instance_targets, not li.programme_id/li.course_id alone.
  // Those two columns only ever hold a Run's PRIMARY target; a multi-
  // target Run's secondary Programme/Course lives only in
  // learning_instance_targets (see getActiveInstanceForProgramme/Course
  // above for the same pattern). Filtering on the legacy primary-only
  // columns would silently drop a Run's statistics from this report the
  // moment its Programme/Course is attached as a secondary target rather
  // than the primary one — a report deriving from a legacy ownership
  // relationship instead of the constitutional multi-target owner.
  if (programmeId) {
    sql += " AND EXISTS (SELECT 1 FROM learning_instance_targets lit WHERE lit.learning_instance_id = li.id AND lit.programme_id = ?)";
    params.push(programmeId);
  }
  if (courseId) {
    sql += " AND EXISTS (SELECT 1 FROM learning_instance_targets lit WHERE lit.learning_instance_id = li.id AND lit.course_id = ?)";
    params.push(courseId);
  }
  if (learningInstanceId) {
    sql += " AND li.id = ?"; params.push(learningInstanceId);
  } else if (learningInstanceScope === "active") {
    sql += " AND li.status = 'active'";
  }
  // §21 — Instructor is a named Reporting dimension, filtered at the same
  // Programme-Run grain as offeringTypeId/programmeId above:
  // learning_instances.instructor_id is the Run's own field
  // (LEARNING_INSTANCE_SELECT already joins it — see its `ins` alias). An
  // Operational-Group-level instructor override (§11.3) organizes delivery
  // beneath this grain and is a narrower question than "which Runs does
  // this instructor teach," so it isn't folded into this filter.
  if (instructorId) { sql += " AND li.instructor_id = ?"; params.push(instructorId); }
  // No learningInstanceId and no learningInstanceScope at all means the
  // admin explicitly chose the consolidated view — every status included,
  // deliberately.
  sql += " ORDER BY t.name ASC, p.name ASC, m.title ASC, li.start_date DESC";
  const instanceRows = db.prepare(sql).all(...params);

  // Same campus/Corporate Client scoping GET /api/users and
  // GET /api/payments/overview already apply for a Campus Administrator /
  // Corporate Coordinator admin — kept consistent so this new grouped view
  // never shows a scoped admin numbers outside what the rest of the Admin
  // Portal already limits them to.
  const scopedCampus = campusScopeFor(req.user);
  const scopedClientId = corporateClientScopeFor(req.user);
  let userScopeSql = "";
  const userScopeParams = [];
  if (scopedCampus) { userScopeSql += " AND u.campus = ?"; userScopeParams.push(scopedCampus); }
  if (scopedClientId) { userScopeSql += " AND u.corporate_client_id = ?"; userScopeParams.push(scopedClientId); }

  // §21/§17 — the remaining named dimensions (Operational Group, Programme
  // Level, Participation Structure, Campus, Delivery Mode, Academic
  // Period) all live on the Enrollment, not the Run. Each Enrollment
  // already carries its own resolved value for these, captured once at
  // enrollment time (utils/learningInstances.js's
  // deriveEnrollmentOperationalSnapshot) — filtering here reads that same
  // recorded value rather than re-deriving anything, so a Run whose
  // Operational Group later changes its own delivery mode/campus doesn't
  // retroactively reshuffle which Enrollments a past filter would match
  // (consistent with the Pricing/Financial Policy Snapshot's "captured
  // once, never re-resolved" discipline in §17).
  let enrollmentDimensionSql = "";
  const enrollmentDimensionParams = [];
  if (operationalGroupId) { enrollmentDimensionSql += " AND pe.operational_group_id = ?"; enrollmentDimensionParams.push(operationalGroupId); }
  if (classId) { enrollmentDimensionSql += " AND pe.class_id = ?"; enrollmentDimensionParams.push(classId); }
  if (participationStructure) { enrollmentDimensionSql += " AND pe.participation_structure = ?"; enrollmentDimensionParams.push(participationStructure); }
  if (campusId) { enrollmentDimensionSql += " AND pe.campus_id = ?"; enrollmentDimensionParams.push(campusId); }
  if (deliveryMode) { enrollmentDimensionSql += " AND pe.delivery_mode = ?"; enrollmentDimensionParams.push(deliveryMode); }
  if (academicPeriodId) { enrollmentDimensionSql += " AND pe.academic_period_id = ?"; enrollmentDimensionParams.push(academicPeriodId); }

  const activeLearnersStmt = db.prepare(
    `SELECT COUNT(DISTINCT pe.user_id) as n FROM programme_enrollments pe JOIN users u ON u.id = pe.user_id
     WHERE pe.learning_instance_id = ? AND pe.status = 'active' AND u.status = 'active'${userScopeSql}${enrollmentDimensionSql}`
  );
  const activeEnrolmentsStmt = db.prepare(
    `SELECT COUNT(*) as n FROM programme_enrollments pe JOIN users u ON u.id = pe.user_id
     WHERE pe.learning_instance_id = ? AND pe.status = 'active'${userScopeSql}${enrollmentDimensionSql}`
  );
  const completedEnrolmentsStmt = db.prepare(
    `SELECT COUNT(*) as n FROM programme_enrollments pe JOIN users u ON u.id = pe.user_id
     WHERE pe.learning_instance_id = ? AND pe.status = 'completed'${userScopeSql}${enrollmentDimensionSql}`
  );
  // Payments don't carry these Enrollment-level dimensions directly — a
  // payment is only tagged with programme_enrollment_id for an "additional
  // programme" enrolment (routes/enrolments.js's POST /); an account's
  // PRIMARY enrolment/payment leaves it NULL, same distinction
  // utils/fees.js, utils/paymentActivation.js, and utils/userView.js
  // already resolve via "WHERE user_id = ? AND is_primary = 1" rather than
  // programme_enrollment_id. Reusing that exact resolution here (instead
  // of inventing a second one) is what lets this join reach a primary
  // payment's governing Enrollment at all. The join is only added when at
  // least one of these dimensions is actually being filtered on, so a
  // caller that filters by none of them gets the exact unchanged
  // query/plan this endpoint already ran before this change.
  const paymentsJoinSql = enrollmentDimensionSql
    ? ` LEFT JOIN programme_enrollments pe ON (pay.programme_enrollment_id IS NOT NULL AND pe.id = pay.programme_enrollment_id)
        OR (pay.programme_enrollment_id IS NULL AND pe.user_id = pay.user_id AND pe.is_primary = 1)`
    : "";
  const paymentsStmt = db.prepare(
    `SELECT COALESCE(SUM(pay.amount), 0) as n FROM payments pay JOIN users u ON u.id = pay.user_id${paymentsJoinSql}
     WHERE pay.learning_instance_id = ? AND pay.status = 'successful' AND pay.currency = 'GHS'${userScopeSql}${enrollmentDimensionSql}`
  );

  const instances = instanceRows.map((row) => {
    const dto = toLearningInstanceDto(row);
    const activeLearners = activeLearnersStmt.get(dto.id, ...userScopeParams, ...enrollmentDimensionParams).n;
    const activeEnrolments = activeEnrolmentsStmt.get(dto.id, ...userScopeParams, ...enrollmentDimensionParams).n;
    const completedEnrolments = completedEnrolmentsStmt.get(dto.id, ...userScopeParams, ...enrollmentDimensionParams).n;
    const paymentsGHS = paymentsStmt.get(dto.id, ...userScopeParams, ...enrollmentDimensionParams).n;
    const completionBase = activeEnrolments + completedEnrolments;
    const completionRate = completionBase ? Math.round((completedEnrolments / completionBase) * 100) : null;
    return { ...dto, activeLearners, activeEnrolments, completedEnrolments, paymentsGHS, completionRate };
  });

  const totals = instances.reduce(
    (acc, r) => ({
      activeLearners: acc.activeLearners + r.activeLearners,
      activeEnrolments: acc.activeEnrolments + r.activeEnrolments,
      completedEnrolments: acc.completedEnrolments + r.completedEnrolments,
      paymentsGHS: acc.paymentsGHS + r.paymentsGHS,
    }),
    { activeLearners: 0, activeEnrolments: 0, completedEnrolments: 0, paymentsGHS: 0 }
  );

  res.json({ instances, totals });
});

router.get("/:id", requireAuth, viewableByInstructorOrPermission, (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });
  if (req.user.role === "instructor" && !instanceBelongsToInstructor(req.user.id, instance)) {
    return res.status(403).json({ error: "You haven't been assigned to this Learning Instance's Programme/Module." });
  }
  res.json(instance);
});

// POST /api/learning-instances — create. Always starts life at whatever
// status is given (default 'upcoming'); if the caller asks to create it
// already 'active', the same one-Active-run rule applies as the dedicated
// /activate endpoint below.
router.post("/", requireAuth, requirePermission("learningInstances.create"), (req, res) => {
  const { offeringTypeId, programmeId, courseId, name, startDate, endDate, participationStructure } = req.body;
  let { status } = req.body;
  status = status || "upcoming";

  const associationError = validateOfferingTypeAssociation({ offeringTypeId, programmeId, courseId });
  if (associationError) return res.status(400).json({ error: associationError });

  if (!isValidStatus(status)) {
    return res.status(400).json({ error: `status must be one of: ${LEARNING_INSTANCE_STATUSES.join(", ")}` });
  }
  if (startDate && endDate && String(endDate) < String(startDate)) {
    return res.status(400).json({ error: "endDate can't be before startDate." });
  }
  const createPsValidation = validateRunParticipationStructure(offeringTypeId, programmeId, participationStructure);
  if (createPsValidation.error) return res.status(400).json({ error: createPsValidation.error });

  if (status === "active") {
    // ABRS v2.2 amendment (concurrent Programme Runs): a Programme/Course
    // may now have more than one Active Learning Instance at once (e.g.
    // concurrent cohorts for different schools/batches), so creating this
    // run as 'active' while another Active run already claims the same
    // Programme/Course is no longer rejected.
  }

  const id = uuid();
  const targetType = programmeId ? "programme" : "course";
  try {
    const createTxn = db.transaction(() => {
      db.prepare(
        `INSERT INTO learning_instances (id, offering_type_id, programme_id, course_id, name, start_date, end_date, status, participation_structure)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, offeringTypeId, programmeId || null, courseId || null, name || null, startDate || null, endDate || null, status, participationStructure || null);
      // Mirror the primary programme/module into learning_instance_targets
      // (Stage 4C/4E multi-target model) — see migrate.js's v23 note.
      db.prepare(
        `INSERT INTO learning_instance_targets (id, learning_instance_id, target_type, programme_id, course_id, is_primary, instance_status)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      ).run(uuid(), id, targetType, programmeId || null, courseId || null, status);
      // ABRS v2.1 Phase 3 Checkpoint 3a (Appendix A-2) — mirror a
      // course-type Run's primary target into the Activated Course table,
      // same as addTarget() already does for secondary targets.
      if (courseId) ensureActivatedCourse(id, courseId);
      // ABRS v2.1 Phase 5 prerequisite (Appendix A-1) — unconditional
      // dual-write (not behind the flag, same rationale as
      // ensureActivatedCourse above): a Run naming a participation_structure
      // is, per §10.1, "activating" that Participation Structure, so record
      // that activation in the new join table too, so it holds real
      // accumulated history by the time any offering type opts into
      // participationStructuresV2Enabled.
      if (programmeId && participationStructure) {
        ensureLearningInstanceParticipationStructureActivation(id, programmeId, participationStructure);
      }
    });
    createTxn();
  } catch (e) {
    // Backstop: the partial unique indexes / CHECK constraints in
    // migrate.js catch anything the checks above somehow missed (e.g. a
    // genuine race between two requests).
    if (/UNIQUE constraint failed/i.test(e.message)) {
      return res.status(409).json({ error: "Only one Active Learning Instance is allowed per Programme/Module." });
    }
    if (/CHECK constraint failed/i.test(e.message)) {
      return res.status(400).json({ error: "Invalid Learning Instance data." });
    }
    throw e;
  }
  res.json(getLearningInstanceById(id));
});

// PATCH /api/learning-instances/:id — edit. offeringTypeId/programmeId/
// courseId are deliberately immutable after creation (this is the "belongs
// to exactly one Offering Type and one Programme/Module" identity of the
// row — changing it isn't an edit, it's a different Learning Instance).
// Status is not settable here either; use the dedicated action endpoints
// below so every transition goes through the same state-machine check.
router.patch("/:id", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const existing = getLearningInstanceById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Learning Instance not found." });

  const { offeringTypeId, programmeId, courseId, status } = req.body;
  if (offeringTypeId !== undefined && offeringTypeId !== existing.offeringTypeId) {
    return res.status(400).json({ error: "offeringTypeId can't be changed after creation — cancel this instance and create a new one instead." });
  }
  if (programmeId !== undefined && (programmeId || null) !== existing.programmeId) {
    return res.status(400).json({ error: "programmeId can't be changed after creation — cancel this instance and create a new one instead." });
  }
  if (courseId !== undefined && (courseId || null) !== existing.courseId) {
    return res.status(400).json({ error: "courseId can't be changed after creation — cancel this instance and create a new one instead." });
  }
  if (status !== undefined && status !== existing.status) {
    return res.status(400).json({ error: "status can't be set directly — use /activate, /complete, /archive, or /cancel." });
  }

  const { name, startDate, endDate, participationStructure } = req.body;
  const nextStartDate = startDate !== undefined ? (startDate || null) : existing.startDate;
  const nextEndDate = endDate !== undefined ? (endDate || null) : existing.endDate;
  if (nextStartDate && nextEndDate && String(nextEndDate) < String(nextStartDate)) {
    return res.status(400).json({ error: "endDate can't be before startDate." });
  }
  if (participationStructure !== undefined) {
    const updatePsValidation = validateRunParticipationStructure(existing.offeringTypeId, existing.programmeId, participationStructure);
    if (updatePsValidation.error) return res.status(400).json({ error: updatePsValidation.error });
  }
  const nextParticipationStructure = participationStructure !== undefined ? (participationStructure || null) : existing.participationStructure;

  db.prepare(
    `UPDATE learning_instances SET name = ?, start_date = ?, end_date = ?, participation_structure = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(name !== undefined ? (name || null) : existing.name, nextStartDate, nextEndDate, nextParticipationStructure, req.params.id);

  // ABRS v2.1 Phase 5 prerequisite — same unconditional dual-write as
  // creation above, kept in sync whenever an edit changes which
  // Participation Structure this Run activates.
  if (existing.programmeId && nextParticipationStructure) {
    ensureLearningInstanceParticipationStructureActivation(req.params.id, existing.programmeId, nextParticipationStructure);
  }

  res.json(getLearningInstanceById(req.params.id));
});

// ---- Status transitions ---------------------------------------------
// Each of these moves the instance to exactly one target status, gated by
// the same ALLOWED_TRANSITIONS state machine, so e.g. "complete" always
// means "active -> completed" and can never be called on something that
// hasn't started yet.
function makeTransitionHandler(targetStatus) {
  return (req, res) => {
    const existing = getLearningInstanceById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Learning Instance not found." });

    const transitionError = assertTransitionAllowed(existing.status, targetStatus);
    if (transitionError) return res.status(409).json({ error: transitionError });

    if (targetStatus === "active") {
      // ABRS v2.2 amendment (concurrent Programme Runs): activating this
      // run no longer requires that none of its targets (primary or
      // secondary) are already claimed by another Active run — a
      // Programme/Course may have multiple concurrent Active runs (e.g.
      // separate cohorts per school/batch), each with its own Academic
      // Calendar, registration window, and Operational Groups. The old
      // findActiveInstanceConflictForTargets()/conflictResponse() guard
      // that used to sit here is intentionally removed, not just
      // relaxed — see the matching migrate.js note on the DB indexes that
      // used to back this same rule.

      // Admin Workflow Redesign — "Publish Programme Run" (ABRS §15) is
      // this transition (upcoming -> active). A Run missing any of its
      // own required configuration (§7.2/§16) should not be publishable.
      // Enforcement is opt-in per offering type (publishReadinessEnforced,
      // default false — same rollout posture as
      // participationStructuresV2Enabled/activatedCoursesV2Enabled), so
      // existing Runs and test fixtures that activate a minimally
      // configured Run for unrelated setup keep working until an
      // offering type's admins are ready to require full setup before
      // publishing.
      const offeringType = getOfferingTypeById(existing.offeringTypeId);
      if (offeringTypeEnforcesPublishReadiness(offeringType) && !existing.workflowStatus.readyToPublish) {
        return res.status(400).json({
          error: "This Programme Run isn't ready to publish yet — finish the remaining setup steps first.",
          missingSteps: existing.workflowStatus.missingSteps,
        });
      }
    }

    try {
      const transitionTxn = db.transaction(() => {
        db.prepare("UPDATE learning_instances SET status = ?, updated_at = datetime('now') WHERE id = ?").run(targetStatus, req.params.id);
        // Keep learning_instance_targets.instance_status in sync so the
        // DB-level "one Active run per target" backstop stays accurate.
        syncTargetStatuses(req.params.id, targetStatus);
      });
      transitionTxn();
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(e.message)) {
        return res.status(409).json({ error: "Only one Active Learning Instance is allowed per Programme/Module." });
      }
      throw e;
    }
    res.json(getLearningInstanceById(req.params.id));
  };
}

router.post("/:id/activate", requireAuth, requirePermission("learningInstances.edit"), makeTransitionHandler("active"));
router.post("/:id/complete", requireAuth, requirePermission("learningInstances.edit"), makeTransitionHandler("completed"));
router.post("/:id/archive", requireAuth, requirePermission("learningInstances.edit"), makeTransitionHandler("archived"));
router.post("/:id/cancel", requireAuth, requirePermission("learningInstances.edit"), makeTransitionHandler("cancelled"));

// ---- Targets (Stage 4C/4E: one Learning Instance, multiple Programmes/
// Modules) ----------------------------------------------------------
// A run's primary target (mirroring programme_id/course_id above) is set
// at creation and can't be changed here — these two endpoints only manage
// ADDITIONAL targets attached to an existing run.

router.post("/:id/targets", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });

  const { programmeId, courseId } = req.body;
  const hasProgramme = !!programmeId;
  const hasModule = !!courseId;
  if (hasProgramme === hasModule) {
    return res.status(400).json({ error: "Provide exactly one of programmeId or courseId." });
  }

  const result = addTarget(instance, { programmeId, courseId });
  if (result.error === "conflict") {
    return conflictResponse(res, { id: result.conflictInstanceId });
  }
  if (result.error) return res.status(400).json({ error: result.error });

  res.status(201).json(getLearningInstanceById(req.params.id));
});

router.delete("/:id/targets/:targetId", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });

  const result = removeTarget(instance, req.params.targetId);
  if (result.error) return res.status(400).json({ error: result.error });

  res.json(getLearningInstanceById(req.params.id));
});

// ---- Activated Courses (§8/§9) — Run-scoped review/edit ----------------
//
// ABRS v2.1 Phase 5 prerequisite (Appendix A-2). Every row here already
// exists — Checkpoint 3a's dual-write created one automatically the
// moment a Course was targeted on this Run (all defaulted to
// Active/Optional/not-Hidden/order 0/no instructor). This endpoint is
// what turns that automatic default into a deliberately reviewed state,
// which Checkpoint 3b's report named as the missing piece before any
// offering type could safely opt into activatedCoursesV2Enabled. The
// full current list is already embedded on the Learning Instance DTO
// (`activatedCourses`, from GET /:id or the list endpoint) — this PATCH
// is the corresponding write.
const ACTIVATED_COURSE_STATUSES = ["active", "inactive"];
router.patch("/:id/activated-courses/:activatedCourseId", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });

  const { status, isHidden, isCompulsory, sortOrder, instructorId } = req.body;

  if (status !== undefined && !ACTIVATED_COURSE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ACTIVATED_COURSE_STATUSES.join(", ")}` });
  }
  if (sortOrder !== undefined && sortOrder !== null && !Number.isInteger(sortOrder)) {
    return res.status(400).json({ error: "sortOrder must be a whole number." });
  }
  if (instructorId !== undefined && instructorId) {
    const instructor = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'instructor'").get(instructorId);
    if (!instructor) return res.status(400).json({ error: "instructorId does not match a known instructor." });
  }

  const updated = updateActivatedCourse(req.params.id, req.params.activatedCourseId, {
    status,
    isHidden,
    isCompulsory,
    sortOrder: sortOrder === undefined ? undefined : sortOrder || 0,
    instructorId,
  });
  if (!updated) return res.status(404).json({ error: "Activated Course not found on this Learning Instance." });

  res.json(updated);
});

// POST /api/learning-instances/:id/activated-courses — assign a reusable
// Course to this specific Learning Instance (many-to-many via
// learning_instance_courses).
router.post("/:id/activated-courses", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });

  const { courseId } = req.body;
  if (!courseId) return res.status(400).json({ error: "courseId is required." });

  const result = assignCourseToInstance(req.params.id, courseId);
  if (result.error) return res.status(400).json({ error: result.error });

  res.status(201).json(getLearningInstanceById(req.params.id));
});

// DELETE /api/learning-instances/:id/activated-courses/:activatedCourseId —
// deactivate a Course assignment on this Learning Instance (preserves the
// row for historical enrolment links).
router.delete("/:id/activated-courses/:activatedCourseId", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });

  const result = deactivateCourseFromInstance(req.params.id, req.params.activatedCourseId);
  if (result.error) return res.status(404).json({ error: result.error });

  res.json(getLearningInstanceById(req.params.id));
});

// ---- Academic Structure (Phase 4: semester -> exactly 2 periods, term ->
// exactly 3 periods) --------------------------------------------------

// PATCH /api/learning-instances/:id/academic-structure — { structure }
// Sets (or, while still 'upcoming', changes) this run's academic
// structure, generating its default-named periods. See
// utils/learningInstances.js's setAcademicStructure for the "why locked
// once active" reasoning.
router.patch("/:id/academic-structure", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });

  const { structure } = req.body;
  if (!structure) return res.status(400).json({ error: "structure is required." });

  const result = setAcademicStructure(instance, structure);
  if (result.error) return res.status(400).json({ error: result.error });

  res.json(getLearningInstanceById(req.params.id));
});

// PATCH /api/learning-instances/:id/academic-periods/:periodId — rename a
// period, or set/adjust its optional dates and school-wide Academic Term
// cross-reference. Can't change which sequence slot it occupies.
router.patch("/:id/academic-periods/:periodId", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });

  const { name, academicTermId, startDate, endDate } = req.body;
  const result = updateAcademicPeriod(instance, req.params.periodId, { name, academicTermId, startDate, endDate });
  if (result.error) return res.status(400).json({ error: result.error });

  res.json(getLearningInstanceById(req.params.id));
});

// ---- Operational configuration (v31 — Programme Run ownership; v32 adds
// Registration Window) --------------------------------------------------
// Delivery Modes, Campuses, Fee, Installments, Capacity, Instructor, and
// (as of v32) Registration Window now belong to the Programme Run — this
// is where an admin configures them going forward (Classes keep their own
// fields only as a legacy/per-batch override — see
// utils/learningInstances.js resolveClassOperationalConfig and
// migrate.js's v31/v32 comments). A Programme's own legacy
// registration_opens_at/registration_deadline/registration_force_closed/
// registration_force_open columns are untouched by this endpoint — they
// remain editable via routes/learningOfferings.js PATCH /programmes/:id
// and now act purely as the fallback for a Programme whose active Run
// hasn't set its own window (see resolveProgrammeRegistrationOpen()).
const OPERATIONAL_DELIVERY_MODES = ["ON_CAMPUS", "ONLINE", "HYBRID"];

router.patch("/:id/operational-config", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM learning_instances WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Learning Instance not found." });

  const { deliveryModes, campusIds, feeGHS, registrationFeeGHS, combineRegistrationWithFirstPeriod, installmentsEnabled, capacity, instructorId, registrationOpensAt, registrationDeadline, registrationForceClosed, registrationForceOpen } = req.body;

  let resolvedDeliveryModes = row.delivery_modes;
  if (deliveryModes !== undefined) {
    if (deliveryModes !== null && !Array.isArray(deliveryModes)) {
      return res.status(400).json({ error: "deliveryModes must be an array (or null to clear)." });
    }
    if (Array.isArray(deliveryModes)) {
      const invalid = deliveryModes.filter((m) => !OPERATIONAL_DELIVERY_MODES.includes(m));
      if (invalid.length) {
        return res.status(400).json({ error: `deliveryModes must only contain: ${OPERATIONAL_DELIVERY_MODES.join(", ")}.` });
      }
    }
    resolvedDeliveryModes = deliveryModes && deliveryModes.length ? JSON.stringify(deliveryModes) : null;
  }

  let resolvedCampusIds = row.campus_ids;
  if (campusIds !== undefined) {
    if (campusIds !== null && !Array.isArray(campusIds)) {
      return res.status(400).json({ error: "campusIds must be an array (or null to clear)." });
    }
    if (Array.isArray(campusIds) && campusIds.length) {
      const found = db
        .prepare(`SELECT id FROM campuses WHERE id IN (${campusIds.map(() => "?").join(",")}) AND active = 1`)
        .all(...campusIds);
      if (found.length !== campusIds.length) {
        return res.status(400).json({ error: "One or more campusIds are unknown or not active." });
      }
    }
    resolvedCampusIds = campusIds && campusIds.length ? JSON.stringify(campusIds) : null;
  }

  const resolvedFeeGHS = feeGHS !== undefined ? (feeGHS === null || feeGHS === "" ? null : Number(feeGHS)) : row.fee_ghs;
  // Registration Fee (§15.2) — the Programme Run's own one-time
  // registration charge, distinct from the recurring Tuition Fee above.
  // pricingEngine.js's resolveStandardBaseAmount() has always read
  // learning_instances.registration_fee_ghs first (falling back to the
  // legacy site_settings default only when this is NULL) — but until now
  // nothing ever wrote to this column after the one-time migration
  // backfill, so every Run was permanently frozen at whatever legacy
  // value it was backfilled to. Same "omit = unchanged, null/'' = clear"
  // convention as feeGHS immediately above.
  const resolvedRegistrationFeeGHS =
    registrationFeeGHS !== undefined ? (registrationFeeGHS === null || registrationFeeGHS === "" ? null : Number(registrationFeeGHS)) : row.registration_fee_ghs;
  // Combined Registration + First Period Payment — see migrate.js's
  // combine_registration_with_first_period comment. Same "omit = unchanged"
  // convention as every other field here; unlike registrationFeeGHS this
  // is a plain boolean with no "clear" state, matching
  // registrationForceClosed/registrationForceOpen below.
  const resolvedCombineRegistrationWithFirstPeriod =
    combineRegistrationWithFirstPeriod !== undefined ? (combineRegistrationWithFirstPeriod ? 1 : 0) : row.combine_registration_with_first_period;
  const resolvedInstallments =
    installmentsEnabled !== undefined ? (installmentsEnabled === null ? null : installmentsEnabled ? 1 : 0) : row.installments_enabled;
  const resolvedCapacity = capacity !== undefined ? (capacity === null || capacity === "" ? null : Number(capacity)) : row.capacity;

  let resolvedInstructorId = row.instructor_id;
  if (instructorId !== undefined) {
    if (instructorId) {
      const instructor = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'instructor'").get(instructorId);
      if (!instructor) return res.status(400).json({ error: "instructorId does not match a known instructor." });
    }
    resolvedInstructorId = instructorId || null;
  }

  // v32 — Registration Window ownership. Same "optional/independent,
  // omit to leave unchanged, pass null to clear" pattern as every other
  // field in this endpoint. See migrate.js's v32 comment and
  // utils/learningInstances.js's resolveProgrammeRegistrationOpen() for
  // how these are resolved (this Run's own window takes precedence over
  // the Programme's legacy fallback the moment any one of these four is
  // set).
  const resolvedRegistrationOpensAt =
    registrationOpensAt !== undefined ? (registrationOpensAt || null) : row.registration_opens_at;
  const resolvedRegistrationDeadline =
    registrationDeadline !== undefined ? (registrationDeadline || null) : row.registration_deadline;
  const resolvedRegistrationForceClosed =
    registrationForceClosed !== undefined ? (registrationForceClosed ? 1 : 0) : row.registration_force_closed;
  const resolvedRegistrationForceOpen =
    registrationForceOpen !== undefined ? (registrationForceOpen ? 1 : 0) : row.registration_force_open;

  db.prepare(
    `UPDATE learning_instances
     SET delivery_modes = ?, campus_ids = ?, fee_ghs = ?, registration_fee_ghs = ?, combine_registration_with_first_period = ?, installments_enabled = ?, capacity = ?, instructor_id = ?,
         registration_opens_at = ?, registration_deadline = ?, registration_force_closed = ?, registration_force_open = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    resolvedDeliveryModes,
    resolvedCampusIds,
    resolvedFeeGHS,
    resolvedRegistrationFeeGHS,
    resolvedCombineRegistrationWithFirstPeriod,
    resolvedInstallments,
    resolvedCapacity,
    resolvedInstructorId,
    resolvedRegistrationOpensAt,
    resolvedRegistrationDeadline,
    resolvedRegistrationForceClosed,
    resolvedRegistrationForceOpen,
    req.params.id
  );

  // Combine ON must never leave a first-period payment requirement that
  // was independently configured before combine was switched on sitting
  // around unnoticed — see clearStaleFirstPeriodPaymentConfigIfCombined's
  // comment. No-op whenever combine is OFF or the first period already
  // has nothing configured, so this is safe to call on every save.
  clearStaleFirstPeriodPaymentConfigIfCombined(req.params.id);

  res.json(getLearningInstanceById(req.params.id));
});


// ============================================================
// Operational Groups (ABRS v2.2 §11 / Appendix A-9). A Programme Run
// child that exists only to organize operational delivery — NOT a
// Programme Level, NOT a Participation Structure, NOT a Course (§11.2).
// Same permission model as every other Programme-Run-scoped mutation in
// this file: viewing follows the instructor-or-permission rule already
// used above; creating/editing/retiring requires learningInstances.edit
// — there is deliberately no separate "operationalGroups.*" permission,
// because owning the Run already means owning everything the Run owns
// (§8.2 lists Operational Groups as one of the things a Programme Run
// owns), and a second, parallel permission would only create a second
// place the same authorization decision could drift out of sync.
// ============================================================

// GET /api/learning-instances/:id/operational-groups
router.get("/:id/operational-groups", requireAuth, viewableByInstructorOrPermission, (req, res) => {
  const instance = db.prepare("SELECT id FROM learning_instances WHERE id = ?").get(req.params.id);
  if (!instance) return res.status(404).json({ error: "Programme Run not found." });
  const includeInactive = req.query.includeInactive === "true" && req.user.role !== "instructor";
  const groups = getOperationalGroupsForInstance(req.params.id, { includeInactive });
  // §21 — Reporting supports aggregation by Operational Group. A simple,
  // always-available dimension: how many current Enrollments sit in each
  // group right now, alongside every other field already returned. Never
  // used to gate/alter anything (§11.4/§22) — purely informational.
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM programme_enrollments WHERE operational_group_id = ? AND status IN ('active','pending_payment')");
  const withCounts = groups.map((g) => ({ ...g, enrolledCount: countStmt.get(g.id).n }));
  res.json({ operationalGroups: withCounts });
});

// POST /api/learning-instances/:id/operational-groups
router.post("/:id/operational-groups", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = db.prepare("SELECT id FROM learning_instances WHERE id = ?").get(req.params.id);
  if (!instance) return res.status(404).json({ error: "Programme Run not found." });
  const { name, displayLabel, sortOrder, feeGHS, capacity, instructorId, deliveryMode, campusId, registrationDeadline } = req.body;
  try {
    const group = createOperationalGroup(req.params.id, { name, displayLabel, sortOrder, feeGHS, capacity, instructorId, deliveryMode, campusId, registrationDeadline });
    res.status(201).json(group);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// PATCH /api/learning-instances/:id/operational-groups/:groupId
router.patch("/:id/operational-groups/:groupId", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const group = getOperationalGroupById(req.params.groupId);
  if (!group || group.learningInstanceId !== req.params.id) return res.status(404).json({ error: "Operational Group not found on this Programme Run." });
  try {
    res.json(updateOperationalGroup(req.params.groupId, req.body || {}));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// DELETE /api/learning-instances/:id/operational-groups/:groupId — retires
// (soft-deletes) if any Enrollment has ever referenced it, otherwise hard
// -deletes. Never touches programme_enrollments.operational_group_id on
// existing rows either way (§20.1 additive/non-destructive discipline);
// a retired group simply becomes unselectable for new assignments.
router.delete("/:id/operational-groups/:groupId", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const group = getOperationalGroupById(req.params.groupId);
  if (!group || group.learningInstanceId !== req.params.id) return res.status(404).json({ error: "Operational Group not found on this Programme Run." });
  try {
    res.json(retireOrDeleteOperationalGroup(req.params.groupId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});


// another period's — so this is a single "replace the whole set" PUT
// (an admin picking "same targets as another period" just resends that
// period's list; a genuinely different set is just a different list —
// there's no separate "inherit" path either way could accidentally hit).

function getPeriodOr404(req, res, instance) {
  const period = db.prepare("SELECT * FROM learning_instance_academic_periods WHERE id = ? AND learning_instance_id = ?").get(req.params.periodId, instance.id);
  if (!period) res.status(404).json({ error: "Academic period not found on this Learning Instance." });
  return period;
}

// GET /api/learning-instances/:id/academic-periods/:periodId/targets
router.get("/:id/academic-periods/:periodId/targets", requireAuth, viewableByInstructorOrPermission, (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });
  const period = getPeriodOr404(req, res, instance);
  if (!period) return;
  res.json({ targets: getPeriodTargets(period.id) });
});

// PUT /api/learning-instances/:id/academic-periods/:periodId/targets
// { targetIds: [...] } — replaces this period's full target set. Every id
// must already be one of this Learning Instance's own targets (see
// POST /:id/targets to attach a new Programme/Module to the run first).
router.put("/:id/academic-periods/:periodId/targets", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });
  const period = getPeriodOr404(req, res, instance);
  if (!period) return;

  const result = setPeriodTargets(instance, period, req.body.targetIds);
  if (result.error) return res.status(400).json({ error: result.error });

  res.json({ targets: result.targets });
});

// GET /api/learning-instances/:id/academic-periods/:periodId/learners/:learnerId/active-targets
// The concrete "which targets are actually active and available for this
// Learning Instance + academic period + learner" resolution: the period's
// configured targets, intersected with what this learner is actually
// enrolled in.
router.get("/:id/academic-periods/:periodId/learners/:learnerId/active-targets", requireAuth, requirePermission("learningInstances.view"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });
  const period = getPeriodOr404(req, res, instance);
  if (!period) return;

  res.json({ targets: getLearnerActiveTargetsInPeriod(period.id, req.params.learnerId) });
});

// ---- Period-specific payment requirements & enforcement (Phase 6) -----

// PATCH /api/learning-instances/:id/academic-periods/:periodId/payment-requirement
// { mode: 'full' | 'deposit' | null, requiredAmountGHS }
// Configures (or, passing mode: null, clears) this period's payment
// requirement. See utils/learningInstances.js's setPeriodPaymentRequirement
// for the exact validation rules.
router.patch("/:id/academic-periods/:periodId/payment-requirement", requireAuth, requirePermission("learningInstances.edit"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });
  const period = getPeriodOr404(req, res, instance);
  if (!period) return;

  const { mode, requiredAmountGHS } = req.body;
  const result = setPeriodPaymentRequirement(instance, period, { mode: mode === undefined ? null : mode, requiredAmountGHS });
  if (result.error) return res.status(400).json({ error: result.error });

  res.json({ period: result.period });
});

// GET /api/learning-instances/:id/academic-periods/:periodId/learners/:learnerId/payment-status
// The concrete "does this learner currently satisfy this period's payment
// requirement" resolution — required amount, amount paid, outstanding
// balance, mode, and whether access is currently satisfied.
router.get("/:id/academic-periods/:periodId/learners/:learnerId/payment-status", requireAuth, requirePermission("learningInstances.view"), (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });
  if (!getPeriodOr404(req, res, instance)) return;
  // getPeriodOr404 only confirms the period belongs to this instance (raw
  // row, id/instance ownership check only) — getPeriodPaymentStatus needs
  // the full camelCase DTO (paymentMode/requiredAmountGHS), so resolve
  // that separately via getAcademicPeriodById rather than reusing the raw
  // row here.
  const period = getAcademicPeriodById(instance.id, req.params.periodId);
  res.json(getPeriodPaymentStatus(req.params.learnerId, instance, period));
});

// GET /api/learning-instances/:id/current-period — resolves and returns
// this instance's "current" academic period (see
// utils/learningInstances.js's getCurrentAcademicPeriod), or null if no
// academic structure is configured.
router.get("/:id/current-period", requireAuth, viewableByInstructorOrPermission, (req, res) => {
  const instance = getLearningInstanceById(req.params.id);
  if (!instance) return res.status(404).json({ error: "Learning Instance not found." });
  res.json({ period: getCurrentAcademicPeriod(instance) });
});

module.exports = router;
