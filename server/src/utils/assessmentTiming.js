// ============================================================
// Shared Examination / Continuous Assessment timing + violation helper.
//
// Both assessment types gained the same three optional instructor-configured
// fields (closes_at, timed_enabled, duration_minutes) and the same attempt
// lifecycle (started_at / deadline_at / status / violation_count /
// ended_reason). The rules are identical for both, so this small stateless
// helper is shared — the actual DB tables (examinations/examination_attempts
// vs continuous_assessments/ca_attempts) are still owned separately by their
// own route files, per the "keep them separate unless a shared helper is
// clearly appropriate" instruction.
// ============================================================

// The deadline for a freshly-started attempt: the earlier of the assessment's
// closing date/time (if configured) and the timed-attempt duration counted
// from the moment the learner actually starts (if enabled). Returns null
// when neither restriction applies (no calendar deadline at all).
function computeDeadline(assessment, startedAtISO) {
  let deadlineMs = null;
  if (assessment.timed_enabled && assessment.duration_minutes) {
    deadlineMs = new Date(startedAtISO).getTime() + Number(assessment.duration_minutes) * 60000;
  }
  if (assessment.closes_at) {
    const closesMs = new Date(assessment.closes_at).getTime();
    if (deadlineMs === null || closesMs < deadlineMs) deadlineMs = closesMs;
  }
  return deadlineMs === null ? null : new Date(deadlineMs).toISOString();
}

// Whether "now" (or a supplied ISO timestamp) is past the assessment's
// closing date/time. Checked fresh (not from the attempt's frozen
// deadline_at) so an instructor tightening the closing date after a learner
// has already started still takes effect at submission time.
function isPastClosingDate(assessment, atISO) {
  if (!assessment.closes_at) return false;
  const at = atISO ? new Date(atISO).getTime() : Date.now();
  return at > new Date(assessment.closes_at).getTime();
}

// Whether an in-progress attempt's own stored deadline (timer and/or the
// closing date as it stood when the attempt started) has passed.
function isAttemptExpired(attempt, atISO) {
  if (!attempt.deadline_at) return false;
  const at = atISO ? new Date(atISO).getTime() : Date.now();
  return at > new Date(attempt.deadline_at).getTime();
}

// Single source of truth for "has this attempt's time run out", combining
// both checks above. Returns a reason string ('closing_date' | 'expired') or
// null if the attempt may still continue.
function expiryReason(assessment, attempt, atISO) {
  if (isPastClosingDate(assessment, atISO)) return "closing_date";
  if (isAttemptExpired(attempt, atISO)) return "expired";
  return null;
}

module.exports = { computeDeadline, isPastClosingDate, isAttemptExpired, expiryReason };
