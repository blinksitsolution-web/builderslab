// Every value below is a direct backend vocabulary word (attempt.status /
// attempt.endedReason, see toPublicAttempt/toPublicCaAttempt in
// server/src/routes/exams.js and continuousAssessments.js) — nothing here
// invents a new state, it only supplies a human-readable label and a
// Badge tone for one that already exists.
export const ENDED_REASON_LABELS = {
  submitted: "Submitted",
  expired: "Time expired — submitted automatically",
  closing_date: "Closing date passed — submitted automatically",
  violation: "Ended — you left the assessment twice",
};

export function endedReasonLabel(reason) {
  return ENDED_REASON_LABELS[reason] || "Completed";
}

export function endedReasonTone(reason) {
  if (reason === "violation") return "danger";
  if (reason === "expired" || reason === "closing_date") return "warning";
  return "success";
}

// A single myAttempt object (or null/undefined — never attempted) reduced
// to one of a small, fixed set of UI states. This is presentation-only
// bucketing of backend-provided facts, not a new eligibility/authorization
// rule — every one of these still requires the corresponding backend call
// to actually agree before anything happens (see the Start/Resume/Submit
// handlers in useLearnerExaminationAttempt.js / useLearnerContinuousAssessmentAttempt.js).
export function attemptPhase(myAttempt) {
  if (!myAttempt) return "not_started";
  if (myAttempt.status === "in_progress") return "in_progress";
  return "ended";
}
