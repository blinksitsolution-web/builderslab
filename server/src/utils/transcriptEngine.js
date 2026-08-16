const db = require("../db/db");
const { getSetting } = require("./settings");

// ============================================================
// Shared Transcript Calculation Engine.
// Single source of truth for "what is this learner's result in this module,
// for this term" — used by routes/grades.js (transcripts), the Retake
// Workflow (utils/transcriptInterpretation.js), and the Certificate Engine
// (Highest Score / Highest Grade / Highest Interpretation). Nothing else
// should reimplement this math.
//
// Weights (10% Tests / 20% Midterm / 70% End of Term) and the grading scheme
// (score band -> grade -> interpretation) are read from site_settings
// (seeded by migrate.js as 'transcriptWeights' / 'gradingScheme') so admins
// can retune either without a code change.
// ============================================================

const DEFAULT_TRANSCRIPT_WEIGHTS = { tests: 10, midterm: 20, endOfTerm: 70 };
const DEFAULT_GRADING_SCHEME = [
  { min: 95, max: 100, grade: "A+", interpretation: "Mastery" },
  { min: 90, max: 94.99, grade: "A", interpretation: "Approaching Mastery" },
  { min: 85, max: 89.99, grade: "B+", interpretation: "Advanced" },
  { min: 80, max: 84.99, grade: "B", interpretation: "Proficient" },
  { min: 60, max: 79.99, grade: "C", interpretation: "Approaching Proficiency" },
  { min: 50, max: 59.99, grade: "D", interpretation: "Developing" },
  { min: 40, max: 49.99, grade: "E", interpretation: "Retake" },
  { min: 0, max: 39.99, grade: "F", interpretation: "Retake" },
];
// Sub-weights for combining the four components that make up the "Tests"
// bucket. Reuses the existing `assessmentWeights` setting (already seeded,
// previously unused) rather than introducing a second weights setting.
const DEFAULT_SUB_WEIGHTS = { aiQuiz: 10, continuousAssessment: 20, assignment: 10, project: 15 };

function transcriptWeights() {
  return getSetting("transcriptWeights", DEFAULT_TRANSCRIPT_WEIGHTS);
}

function gradingScheme() {
  const scheme = getSetting("gradingScheme", DEFAULT_GRADING_SCHEME);
  return Array.isArray(scheme) && scheme.length ? scheme : DEFAULT_GRADING_SCHEME;
}

// Grade + Interpretation for a numeric total, per the configured scheme.
// Returns { grade: null, interpretation: null } if total is null (not
// enough data yet) or doesn't fall in any configured band.
function gradeFor(total) {
  if (total == null) return { grade: null, interpretation: null };
  const band = gradingScheme().find((b) => total >= b.min && total <= b.max);
  return band ? { grade: band.grade, interpretation: band.interpretation } : { grade: null, interpretation: null };
}

// Weighted average of whichever of the four Tests sub-components have data
// for this learner/module/term — same "only average what's present" rule
// already used elsewhere in this codebase (see moduleAverage in
// transcriptInterpretation.js), just extended to four weighted inputs
// instead of two equal ones.
// `learningInstanceId` (Phase 9) is optional — when omitted, behavior is
// byte-for-byte identical to before (every existing caller: retake
// eligibility, the Certificate Engine's Highest Score scan, and the default
// non-period-scoped transcript). When provided (a period-scoped transcript
// request — see routes/grades.js), every underlying query additionally
// requires `(learning_instance_id = ? OR learning_instance_id IS NULL)` —
// the same "match this run OR predates the run concept entirely" pattern
// already used for term_id above — so a record that genuinely belongs to a
// DIFFERENT run of the same module (e.g. a re-take cohort) can never bleed
// into this run's period-scoped transcript, while historical records that
// predate Learning Instances altogether keep counting exactly as they
// always have.
function testsComponent(userId, courseId, termId, learningInstanceId) {
  const subWeights = { ...DEFAULT_SUB_WEIGHTS, ...getSetting("assessmentWeights", {}) };
  const liClause = learningInstanceId ? "AND (learning_instance_id = ? OR learning_instance_id IS NULL)" : "";
  const liArgs = learningInstanceId ? [learningInstanceId] : [];

  const aiQuizAvg = avgOf(
    db
      .prepare(
        `SELECT quiz_score FROM progress
         WHERE user_id = ? AND course_id = ? AND (term_id = ? OR term_id IS NULL) AND quiz_score IS NOT NULL ${liClause}`
      )
      .all(userId, courseId, termId, ...liArgs)
      .map((r) => r.quiz_score)
  );

  const caAvg = avgOf(
    db
      .prepare(
        `SELECT a.percentage FROM ca_attempts a
         JOIN continuous_assessments c ON c.id = a.assessment_id
         WHERE a.user_id = ? AND c.course_id = ? AND (a.term_id = ? OR a.term_id IS NULL)
           ${learningInstanceId ? "AND (a.learning_instance_id = ? OR a.learning_instance_id IS NULL)" : ""}`
      )
      .all(userId, courseId, termId, ...liArgs)
      .map((r) => r.percentage)
  );

  const assignmentAvg = avgOf(
    db
      .prepare(
        `SELECT s.mark FROM assignment_submissions s
         JOIN notes n ON n.id = s.note_id
         WHERE s.user_id = ? AND n.course_id = ? AND (s.term_id = ? OR s.term_id IS NULL) AND s.mark IS NOT NULL
           ${learningInstanceId ? "AND (s.learning_instance_id = ? OR s.learning_instance_id IS NULL)" : ""}`
      )
      .all(userId, courseId, termId, ...liArgs)
      .map((r) => r.mark)
  );

  const projectAvg = avgOf(
    db
      .prepare(
        `SELECT mark FROM projects
         WHERE user_id = ? AND course_id = ? AND (term_id = ? OR term_id IS NULL) AND mark IS NOT NULL ${liClause}`
      )
      .all(userId, courseId, termId, ...liArgs)
      .map((r) => r.mark)
  );

  return weightedAverage([
    { value: aiQuizAvg, weight: subWeights.aiQuiz },
    { value: caAvg, weight: subWeights.continuousAssessment },
    { value: assignmentAvg, weight: subWeights.assignment },
    { value: projectAvg, weight: subWeights.project },
  ]);
}

// Midterm / End of Term score for one module. For End of Term specifically,
// a Retake Examination attempt (term_type = 'retake') for this exact
// module+term takes priority over the original End of Term attempt — this
// is what makes "after a learner passes a Retake Examination, recalculate
// the transcript/grade/interpretation" happen automatically on every read,
// with no separate write-back step: the retake score simply supersedes the
// score that made the module Retake-eligible in the first place, for this
// term only. Falls back to an actual Examination-panel attempt for the
// requested term_type, then to the legacy grades.midterm/end_of_term columns
// (manual instructor entry) when neither exists, so nothing already in use
// breaks.
function examComponent(userId, courseId, termId, termType, legacyColumn, learningInstanceId) {
  const liArgs = learningInstanceId ? [learningInstanceId] : [];
  const eaLiClause = learningInstanceId ? "AND (ea.learning_instance_id = ? OR ea.learning_instance_id IS NULL)" : "";
  const gradesLiClause = learningInstanceId ? "AND (learning_instance_id = ? OR learning_instance_id IS NULL)" : "";

  if (termType === "end_of_term") {
    const retake = db
      .prepare(
        `SELECT ea.score FROM examination_attempts ea
         JOIN examinations e ON e.id = ea.examination_id
         WHERE ea.user_id = ? AND e.course_id = ? AND e.term_type = 'retake'
           AND (ea.term_id = ? OR ea.term_id IS NULL) ${eaLiClause}
         ORDER BY ea.submitted_at DESC LIMIT 1`
      )
      .get(userId, courseId, termId, ...liArgs);
    if (retake) return retake.score;
  }

  const attempt = db
    .prepare(
      `SELECT ea.score FROM examination_attempts ea
       JOIN examinations e ON e.id = ea.examination_id
       WHERE ea.user_id = ? AND e.course_id = ? AND e.term_type = ?
         AND (ea.term_id = ? OR ea.term_id IS NULL) ${eaLiClause}
       ORDER BY ea.submitted_at DESC LIMIT 1`
    )
    .get(userId, courseId, termType, termId, ...liArgs);
  if (attempt) return attempt.score;

  const legacy = db
    .prepare(`SELECT ${legacyColumn} as v FROM grades WHERE user_id = ? AND course_id = ? AND (term_id = ? OR term_id IS NULL) ${gradesLiClause}`)
    .get(userId, courseId, termId, ...liArgs);
  return legacy ? legacy.v : null;
}

function avgOf(values) {
  const nums = values.filter((v) => v != null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Weighted average over whichever {value, weight} entries have a non-null
// value, renormalizing so missing components don't silently drag the score
// toward zero — same principle as the two-input version this replaces.
// Used ONLY for the Tests bucket's internal sub-components (AI Quiz/CA/
// Assignment/Project) — NOT for the top-level Total (see fixedWeightTotal).
function weightedAverage(entries) {
  const present = entries.filter((e) => e.value != null && e.weight > 0);
  if (!present.length) return null;
  const totalWeight = present.reduce((sum, e) => sum + e.weight, 0);
  return present.reduce((sum, e) => sum + (e.value * e.weight) / totalWeight, 0);
}

// The top-level Total is Tests + Midterm + End of Term, each held to its
// full configured weight — an unrecorded component defaults to 0 rather
// than being dropped out and having the remaining components renormalized
// to cover its share. This is deliberately NOT weightedAverage(): a module
// missing its (heaviest-weighted) End of Term score must never show a Total
// computed as if End of Term didn't apply. Returns null only when NOTHING
// has been recorded at all (so an entirely ungraded module still reads as
// "not graded," not as a graded 0), and null-only inputs are excluded from
// the sum but still count toward `anyRecorded`.
function fixedWeightTotal(entries) {
  const anyRecorded = entries.some((e) => e.value != null);
  if (!anyRecorded) return null;
  const configuredWeight = entries.reduce((sum, e) => sum + (e.weight || 0), 0);
  if (!configuredWeight) return null;
  const sum = entries.reduce((acc, e) => acc + (e.value == null ? 0 : e.value) * e.weight, 0);
  return sum / configuredWeight;
}

// Full module result for one learner: the three transcript components, the
// weighted Total, and the resulting Grade/Interpretation. This is what
// every consumer (transcript, retake eligibility, certificates) should call.
function moduleResult(userId, courseId, termId, learningInstanceId) {
  const weights = transcriptWeights();
  const tests = testsComponent(userId, courseId, termId, learningInstanceId);
  const midterm = examComponent(userId, courseId, termId, "midterm", "midterm", learningInstanceId);
  const endOfTerm = examComponent(userId, courseId, termId, "end_of_term", "end_of_term", learningInstanceId);

  const total = fixedWeightTotal([
    { value: tests, weight: weights.tests },
    { value: midterm, weight: weights.midterm },
    { value: endOfTerm, weight: weights.endOfTerm },
  ]);
  const { grade, interpretation } = gradeFor(total);

  return { tests, midterm, endOfTerm, total, grade, interpretation };
}

module.exports = {
  transcriptWeights,
  gradingScheme,
  gradeFor,
  testsComponent,
  examComponent,
  moduleResult,
};
