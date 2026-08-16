const db = require("../db/db");
const { moduleResult } = require("./transcriptEngine");

// ============================================================
// Retake Workflow — eligibility helpers.
// Retake eligibility is determined ONLY from the learner's transcript for
// a specific Academic Term — this delegates to the same
// transcriptEngine.moduleResult() used by the transcript itself, so
// "Retake" here always matches exactly what the transcript displays. The
// old standalone 50%-average rule this file used to implement has been
// replaced by the full Grade/Interpretation scheme (see
// utils/transcriptEngine.js), where interpretations 'E' and 'F' both mean
// "Retake".
//
// ABRS v2.2 Compliance Remediation: `termId` must now always be supplied
// by the caller, already resolved via the constitutional ownership chain
// (Programme Run -> Academic Period -> Academic Term —
// utils/learningInstances.js's resolveConstitutionalTermIdForCourse). This
// module no longer falls back to a school-wide "active" Academic Term —
// that fallback was a second, competing owner of a fact the owning
// Programme Run's Academic Period already determines (§2.1/§19).
// ============================================================

// 'Pass' | 'Retake' | null (null = not enough grade data yet to interpret,
// or no termId was resolvable for this module's Run).
function interpretationFor(userId, courseId, termId) {
  if (!termId) return null;
  return moduleResult(userId, courseId, termId).interpretation === "Retake" ? "Retake" : null;
}

// All learners enrolled in `courseId` whose transcript interpretation for
// `termId` is currently 'Retake'. This is what instructors see when
// creating a Retake Examination — and, since it's computed live from
// transcriptEngine, a learner who has since passed a Retake Examination
// (which updates their End of Term component for this term — see
// transcriptEngine.examComponent) naturally stops appearing here without
// any separate "remove from list" bookkeeping.
//
// `termId` must already be resolved by the caller through the ownership
// chain (see module header above) — an unresolvable/missing termId simply
// yields no eligible learners, never a silent fallback to some other term.
function retakeEligibleLearners(courseId, termId) {
  if (!termId) return [];

  const learners = db
    .prepare(
      `SELECT u.id, u.name, u.student_code, u.class_id
       FROM enrollments e
       JOIN users u ON u.id = e.user_id
       WHERE e.course_id = ? AND u.role = 'learner'`
    )
    .all(courseId);

  return learners
    .map((u) => {
      const result = moduleResult(u.id, courseId, termId);
      return { ...u, interpretation: result.interpretation, total: result.total, grade: result.grade };
    })
    .filter((u) => u.interpretation === "Retake");
}

module.exports = { interpretationFor, retakeEligibleLearners };
