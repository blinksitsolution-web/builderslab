const { v4: uuid } = require("uuid");
const db = require("../db/db");
const { moduleResult } = require("./transcriptEngine");
const { syncCourseCurriculumForClass, resolveConstitutionalTermIdForCourse } = require("./learningInstances");

// ============================================================
// Promotion Engine (ABRS v2.1 Section 12).
//
// Constitutional scope for this checkpoint — Promotion shall only:
//   1. Evaluate promotion eligibility.
//   2. Update the learner's Programme Level (users.class_id — nothing else).
//   3. Record the Promotion Log.
//   4. Preserve the learner's historical academic record (this module never
//      writes to grades, examinations, continuous_assessments, attendance,
//      projects, payments, or programme_enrollments).
//   5. Rely on the existing visibility mechanism
//      (learning_instance_courses.visible_class_ids, §8) so newly eligible
//      Courses become available and previous-level Courses stop being
//      presented as current — purely a read-time consequence of
//      users.class_id changing. This module never writes to `courses` or
//      `learning_instance_courses`, never archives a Course, and never
//      creates a learner-specific Course record.
//
// current_academic_year_id, campus, and enrollment/financial status are
// deliberately never touched here — those belong to Enrollment (§14),
// not Promotion (§12), even though the legacy /promote-class,
// /promote-learners, /transfer-campus and /graduate routes in
// routes/promotion.js still conflate some of this (flagged, not fixed,
// per this checkpoint's explicit scope — see the implementation report).
// ============================================================

function logPromotion({ learnerId, action, fromYearId, toYearId, details, performedBy, policySnapshot, reversedLogId }) {
  const id = uuid();
  db.prepare(
    `INSERT INTO promotion_log (id, learner_id, action, from_year_id, to_year_id, details, performed_by, policy_snapshot, reversed_log_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    learnerId,
    action,
    fromYearId || null,
    toYearId || null,
    details ? JSON.stringify(details) : null,
    performedBy,
    policySnapshot ? JSON.stringify(policySnapshot) : null,
    reversedLogId || null
  );
  return id;
}

// Promotion path is only ever meaningful within one Programme (sort_order
// is a per-Programme sequence — Foundation=0 -> Framework=1 -> Skyline=2
// for Kids STEM). Mirrors routes/promotion.js's existing nextClass/
// finalClass, kept here too so the eligibility engine and the apply step
// share one implementation rather than two copies drifting apart.
function nextClass(currentClassId) {
  const current = db.prepare("SELECT * FROM classes WHERE id = ?").get(currentClassId);
  if (!current) return null;
  return (
    db
      .prepare("SELECT * FROM classes WHERE sort_order = ? AND programme_id IS ? ORDER BY name ASC")
      .get(current.sort_order + 1, current.programme_id) || null
  );
}

function previousClass(currentClassId) {
  const current = db.prepare("SELECT * FROM classes WHERE id = ?").get(currentClassId);
  if (!current) return null;
  return (
    db
      .prepare("SELECT * FROM classes WHERE sort_order = ? AND programme_id IS ? ORDER BY name ASC")
      .get(current.sort_order - 1, current.programme_id) || null
  );
}

// ---- Promotion Policy (Programme-owned configuration, §12/§2.2) --------

function getProgrammePromotionPolicy(programmeId) {
  return db.prepare("SELECT * FROM promotion_policies WHERE programme_id = ?").get(programmeId) || null;
}

function upsertProgrammePromotionPolicy(programmeId, { minAverageScore, minAttendancePercent, requiresInstructorRecommendation, isActive }) {
  const existing = getProgrammePromotionPolicy(programmeId);
  if (existing) {
    db.prepare(
      `UPDATE promotion_policies
       SET min_average_score = ?, min_attendance_percent = ?, requires_instructor_recommendation = ?, is_active = ?, updated_at = datetime('now')
       WHERE programme_id = ?`
    ).run(
      minAverageScore == null ? null : minAverageScore,
      minAttendancePercent == null ? null : minAttendancePercent,
      requiresInstructorRecommendation ? 1 : 0,
      isActive === false ? 0 : 1,
      programmeId
    );
  } else {
    db.prepare(
      `INSERT INTO promotion_policies (id, programme_id, min_average_score, min_attendance_percent, requires_instructor_recommendation, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      programmeId,
      minAverageScore == null ? null : minAverageScore,
      minAttendancePercent == null ? null : minAttendancePercent,
      requiresInstructorRecommendation ? 1 : 0,
      isActive === false ? 0 : 1
    );
  }
  return getProgrammePromotionPolicy(programmeId);
}

// ---- Instructor recommendation ------------------------------------------

function recordInstructorRecommendation({ learnerId, classId, instructorId, recommends, note }) {
  const id = uuid();
  db.prepare(
    `INSERT INTO promotion_recommendations (id, learner_id, class_id, instructor_id, recommends, note) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, learnerId, classId, instructorId, recommends ? 1 : 0, note || null);
  return db.prepare("SELECT * FROM promotion_recommendations WHERE id = ?").get(id);
}

function latestRecommendation(learnerId, classId) {
  return db
    .prepare(
      `SELECT * FROM promotion_recommendations WHERE learner_id = ? AND class_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(learnerId, classId) || null;
}

// Checkpoint 4 report, Remaining work item 5: bound attendance evaluation
// by "since last Programme Level change" rather than all-time, so a
// learner who repeats a level doesn't carry the previous attempt's
// attendance record into the new one. Finds the most recent promotion_log
// entry that actually landed the learner on their CURRENT class_id — a
// 'promote'/'auto_promote'/'manual_promote' that moved them here, or a
// 'reversal' that restored them here — and returns its created_at as the
// lower bound. Returns null (no bound, same as previous all-time
// behaviour) when the learner has never had a recorded level change into
// their current level, e.g. they are still at their original Entry Level
// (§13.2) and no promotion_log row exists yet to bound against.
function currentLevelStartDate(learnerId, classId) {
  const rows = db
    .prepare(
      `SELECT created_at, details FROM promotion_log
       WHERE learner_id = ? AND action IN ('promote','auto_promote','manual_promote','reversal')
       ORDER BY created_at DESC, rowid DESC`
    )
    .all(learnerId);
  for (const row of rows) {
    let details;
    try {
      details = JSON.parse(row.details || "{}");
    } catch (e) {
      details = {};
    }
    if (details.toClassId === classId) return row.created_at;
  }
  return null;
}

// ---- Eligibility evaluation ---------------------------------------------
// Reads only: users, classes, enrollments (current course set), grades/
// examinations/continuous_assessments/assignment_submissions/projects (via
// transcriptEngine.moduleResult, unchanged), attendance, and this module's
// own policy/recommendation tables. Writes nothing.
function evaluateLearnerPromotionEligibility(learnerId) {
  const learner = db.prepare("SELECT id, name, class_id FROM users WHERE id = ? AND role = 'learner'").get(learnerId);
  if (!learner) return { learnerId, eligible: false, blocked: true, reasons: ["Learner not found."], breakdown: null };

  const primaryEnrollment = db
    .prepare("SELECT participation_structure FROM programme_enrollments WHERE user_id = ? AND is_primary = 1")
    .get(learnerId);
  if (primaryEnrollment && primaryEnrollment.participation_structure === "individual_course") {
    return { learnerId, eligible: false, blocked: true, reasons: ["Promotion is not applicable for Individual Course learners."], breakdown: null };
  }

  if (!learner.class_id) {
    return { learnerId, eligible: false, blocked: true, reasons: ["Learner has no current Programme Level assigned."], breakdown: null };
  }

  const currentClass = db.prepare("SELECT * FROM classes WHERE id = ?").get(learner.class_id);
  const target = nextClass(learner.class_id);
  if (!target) {
    return {
      learnerId,
      eligible: false,
      blocked: true,
      reasons: ["Learner is already at the final Programme Level for this Programme — use /graduate, not Promotion."],
      breakdown: null,
    };
  }

  const policy = currentClass.programme_id ? getProgrammePromotionPolicy(currentClass.programme_id) : null;
  const activePolicy = policy && policy.is_active ? policy : null;

  const courseIds = db
    .prepare("SELECT DISTINCT course_id FROM enrollments WHERE user_id = ?")
    .all(learnerId)
    .map((r) => r.course_id);

  // ABRS v2.2 Compliance Remediation: a learner's enrolled modules can
  // legitimately belong to different Programme Runs with different
  // current Academic Periods/Terms (e.g. a repeated module from an older
  // Run alongside modules from the current one) — so each module's Total
  // must be looked up against ITS OWN module's Active Programme Run ->
  // Academic Period -> Academic Term (§8.2/§19), never one
  // institution-wide "active term" applied uniformly across every module.
  const totals = courseIds
    .map((courseId) => {
      const termId = resolveConstitutionalTermIdForCourse(courseId);
      return termId ? moduleResult(learnerId, courseId, termId).total : null;
    })
    .filter((t) => t != null);
  const averageScore = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;

  const levelStartAt = currentLevelStartDate(learnerId, learner.class_id);
  // attendance.date is a plain yyyy-mm-dd; promotion_log.created_at is a
  // full datetime — comparing on the date portion is enough to exclude
  // attendance recorded before this level began, without needing exact
  // same-day precision either way.
  const attendanceSinceDate = levelStartAt ? levelStartAt.slice(0, 10) : null;
  const attendanceRows = courseIds.length
    ? db
        .prepare(
          `SELECT status FROM attendance WHERE learner_id = ? AND course_id IN (${courseIds.map(() => "?").join(",")})${
            attendanceSinceDate ? " AND date >= ?" : ""
          }`
        )
        .all(learnerId, ...courseIds, ...(attendanceSinceDate ? [attendanceSinceDate] : []))
    : [];
  const attendancePercent = attendanceRows.length
    ? (attendanceRows.filter((r) => r.status === "present" || r.status === "late").length / attendanceRows.length) * 100
    : null;

  const recommendation = latestRecommendation(learnerId, learner.class_id);

  const reasons = [];
  let eligible = true;

  if (activePolicy && activePolicy.min_average_score != null) {
    if (averageScore == null) {
      eligible = false;
      reasons.push(`No graded record yet to evaluate against the minimum average score of ${activePolicy.min_average_score}.`);
    } else if (averageScore < activePolicy.min_average_score) {
      eligible = false;
      reasons.push(`Average score ${averageScore.toFixed(1)} is below the required minimum of ${activePolicy.min_average_score}.`);
    }
  }

  if (activePolicy && activePolicy.min_attendance_percent != null) {
    if (attendancePercent == null) {
      eligible = false;
      reasons.push(`No attendance record yet to evaluate against the minimum attendance of ${activePolicy.min_attendance_percent}%.`);
    } else if (attendancePercent < activePolicy.min_attendance_percent) {
      eligible = false;
      reasons.push(`Attendance ${attendancePercent.toFixed(1)}% is below the required minimum of ${activePolicy.min_attendance_percent}%.`);
    }
  }

  if (activePolicy && activePolicy.requires_instructor_recommendation) {
    if (!recommendation || !recommendation.recommends) {
      eligible = false;
      reasons.push("A positive instructor recommendation is required and has not been given.");
    }
  }

  return {
    learnerId,
    learnerName: learner.name,
    fromClassId: learner.class_id,
    fromClassName: currentClass ? currentClass.name : null,
    toClassId: target.id,
    toClassName: target.name,
    eligible,
    blocked: false,
    reasons,
    breakdown: {
      averageScore,
      attendancePercent,
      attendanceSince: attendanceSinceDate,
      instructorRecommendation: recommendation ? !!recommendation.recommends : null,
      policy: activePolicy
        ? {
            minAverageScore: activePolicy.min_average_score,
            minAttendancePercent: activePolicy.min_attendance_percent,
            requiresInstructorRecommendation: !!activePolicy.requires_instructor_recommendation,
          }
        : null,
    },
  };
}

// ---- Apply / reverse (the only two functions that write to users.class_id) --

// Level-only mutation. Deliberately does NOT touch current_academic_year_id,
// campus, or any enrollment/financial field (§12). syncCourseCurriculumForClass
// is pre-existing curriculum-unlock plumbing (module/lesson access by class),
// not a Course-record mutation — it grants the learner access rows, it does
// not alter any `courses` or `learning_instance_courses` row.
function applyPromotion({ learnerId, toClassId, performedBy, action, policySnapshot }) {
  const learner = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'learner'").get(learnerId);
  if (!learner) throw new Error("Learner not found.");

  const primaryEnrollment = db
    .prepare("SELECT participation_structure FROM programme_enrollments WHERE user_id = ? AND is_primary = 1")
    .get(learnerId);
  if (primaryEnrollment && primaryEnrollment.participation_structure === "individual_course") {
    throw new Error("Promotion is not applicable for Individual Course learners.");
  }
  const fromClassId = learner.class_id;

  db.prepare("UPDATE users SET class_id = ? WHERE id = ?").run(toClassId, learnerId);
  db.prepare("UPDATE programme_enrollments SET class_id = ?, updated_at = datetime('now') WHERE user_id = ? AND is_primary = 1").run(toClassId, learnerId);

  const primaryEnrollmentDetails = db.prepare("SELECT learning_instance_id, academic_period_id FROM programme_enrollments WHERE user_id = ? AND is_primary = 1").get(learnerId);

  const addedModuleIds = syncCourseCurriculumForClass(learnerId, toClassId);

  const logId = logPromotion({
    learnerId,
    action,
    details: {
      fromClassId,
      toClassId,
      learningInstanceId: primaryEnrollmentDetails ? primaryEnrollmentDetails.learning_instance_id : null,
      academicPeriodId: primaryEnrollmentDetails ? primaryEnrollmentDetails.academic_period_id : null,
      curriculumModulesAdded: addedModuleIds
    },
    performedBy,
    policySnapshot,
  });

  notifyParentOfPromotion(learner, fromClassId, toClassId, performedBy);

  return { logId, fromClassId, toClassId };
}

function reversePromotion({ logId, performedBy }) {
  const original = db.prepare("SELECT * FROM promotion_log WHERE id = ?").get(logId);
  if (!original) throw new Error("Promotion log entry not found.");
  if (!["promote", "auto_promote", "manual_promote"].includes(original.action)) {
    throw new Error("Only a promote/auto_promote/manual_promote entry can be reversed.");
  }
  let details;
  try {
    details = JSON.parse(original.details || "{}");
  } catch (e) {
    details = {};
  }
  if (!details.fromClassId) throw new Error("This log entry has no recorded prior Programme Level to reverse to.");

  const learner = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'learner'").get(original.learner_id);
  if (!learner) throw new Error("Learner not found.");

  db.prepare("UPDATE users SET class_id = ? WHERE id = ?").run(details.fromClassId, original.learner_id);
  // Reversal restores prior curriculum access too (best-effort — access
  // already granted for the level being reversed away from is left as-is;
  // nothing here revokes previously granted access, only re-grants the
  // prior level's, matching this module's "never archive/remove" rule).
  syncCourseCurriculumForClass(original.learner_id, details.fromClassId);

  const logId2 = logPromotion({
    learnerId: original.learner_id,
    action: "reversal",
    details: { fromClassId: learner.class_id, toClassId: details.fromClassId, reversalOf: logId },
    performedBy,
    reversedLogId: logId,
  });

  notifyParentOfPromotion(learner, learner.class_id, details.fromClassId, performedBy, true);

  return { logId: logId2, fromClassId: learner.class_id, toClassId: details.fromClassId };
}

function notifyParentOfPromotion(learner, fromClassId, toClassId, performedBy, isReversal) {
  if (!learner.parent_id) return;
  const fromClass = fromClassId ? db.prepare("SELECT name FROM classes WHERE id = ?").get(fromClassId) : null;
  const toClass = db.prepare("SELECT name FROM classes WHERE id = ?").get(toClassId);
  const subject = isReversal ? "Programme Level update reversed" : "Your child has been promoted";
  const body = isReversal
    ? `${learner.name}'s Programme Level has been reverted${fromClass ? ` from ${fromClass.name}` : ""} to ${toClass ? toClass.name : "a prior level"}.`
    : `Congratulations! ${learner.name} has been promoted${fromClass ? ` from ${fromClass.name}` : ""} to ${toClass ? toClass.name : "the next level"}.`;
  db.prepare(
    `INSERT INTO messages (id, from_id, from_name, to_id, subject, body, date) VALUES (?, ?, 'Admin', ?, ?, ?, datetime('now'))`
  ).run(uuid(), performedBy, learner.parent_id, subject, body);
}

module.exports = {
  nextClass,
  previousClass,
  currentLevelStartDate,
  getProgrammePromotionPolicy,
  upsertProgrammePromotionPolicy,
  recordInstructorRecommendation,
  latestRecommendation,
  evaluateLearnerPromotionEligibility,
  applyPromotion,
  reversePromotion,
  logPromotion,
};
