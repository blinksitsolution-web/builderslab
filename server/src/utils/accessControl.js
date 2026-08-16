// ============================================================
// Access Control — payment/account-status gating for learner academic
// content (Notes, Assignments, Assessments, Exams, Video lessons, Progress,
// Messages, Certificates, Transcripts, and any other learner-facing
// academic content), plus the parent view of the same for their ward(s).
//
// Deliberately reuses the existing users.status / users.payment_status
// columns (no new enum, no breaking migration) and adds three new,
// nullable/defaulted columns for an admin-controlled override:
//   access_override             INTEGER (0/1)
//   access_override_reason      TEXT
//   access_override_expires_at  TEXT (ISO datetime, nullable = never expires)
//
// Rules (per spec):
//   - status === 'suspended' always blocks — access_override can NEVER
//     bypass a suspension. A suspended account must be reactivated by an
//     admin (users.status back to 'active') before override even matters.
//   - Otherwise, a live access_override bypasses payment/status-pending
//     restrictions.
//   - Otherwise, restricted when payment_status isn't 'current' (covers
//     the existing 'unpaid'/'partial' values already used across the app,
//     plus 'owing'/'pending_payment' in case either is ever stored there
//     directly) OR when status isn't 'active' (covers 'pending_payment').
//
// Sponsorship (see PATCH /api/users/:userId/sponsor, routes/users.js):
// attaching a sponsor ONLY records who is responsible for a learner's
// fees — it is NOT a payment event and never touches payment_status or
// status. A sponsored learner is gated by exactly the same
// payment_status/status rules as anyone else, until a real payment is
// recorded against their account (Paystack, or an admin manually
// confirming one). There is no general sponsor-payment waiver.
// 'waived' remains a legal (legacy) payment_status value — it is
// deliberately NOT added to RESTRICTED_PAYMENT_STATUSES below, that set
// being a blocklist rather than an allowlist — but nothing in the current
// codebase sets it anymore; it only exists so that data waived under a
// prior build keeps behaving the same way. The one and only mechanism
// that grants free access with no payment at all is a Hub/admin Access
// Override (access_override, below) — always distinguishable from
// sponsorship since it's a completely separate column.
// ============================================================

const RESTRICTED_PAYMENT_STATUSES = new Set(["unpaid", "partial", "owing", "pending_payment"]);

const RESTRICTION_MESSAGE =
  "Your account currently has restricted access due to an outstanding balance or account status. Please complete payment or contact administration to restore access.";

function hasActiveOverride(user) {
  if (!user || !user.access_override) return false;
  if (!user.access_override_expires_at) return true; // no expiry = indefinite override
  return new Date(user.access_override_expires_at).getTime() > Date.now();
}

// Returns { restricted: boolean, reason: 'suspended' | 'payment' | null }
function accessRestriction(user) {
  if (!user) return { restricted: true, reason: "not_found" };
  if (user.status === "suspended") return { restricted: true, reason: "suspended" };
  if (hasActiveOverride(user)) return { restricted: false, reason: null };
  const paymentIssue = RESTRICTED_PAYMENT_STATUSES.has(user.payment_status);
  const statusIssue = user.status !== "active";
  if (paymentIssue || statusIssue) return { restricted: true, reason: "payment" };
  return { restricted: false, reason: null };
}

function isRestricted(user) {
  return accessRestriction(user).restricted;
}

module.exports = { accessRestriction, isRestricted, hasActiveOverride, RESTRICTION_MESSAGE };
