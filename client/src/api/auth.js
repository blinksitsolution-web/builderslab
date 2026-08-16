/* ==========================================================================
   Auth endpoints — backs AuthContext's session restoration, login, logout
   (Phase 2), the migrated React login page (Phase 4), the migrated React
   registration page (Group 1), and the migrated React password-reset flow
   (Group 2 — final non-admin migration). Paths and response shapes match
   server/src/routes/auth.js and server/src/routes/users.js exactly.
   ========================================================================== */
import { apiGet, apiPost, ApiError } from "./client";

// GET /api/auth/me — returns { user } when signed in.
// Mirrors DTL.currentUser(): resolves to `null` (not a thrown error) when
// there's no session, since "not signed in" is an expected, common state,
// not a failure the caller needs to catch.
export async function fetchCurrentUser() {
  try {
    const { user } = await apiGet("/api/auth/me");
    return user;
  } catch (e) {
    return null;
  }
}

// POST /api/auth/login — returns { user } on success.
export async function login(email, password) {
  const { user } = await apiPost("/api/auth/login", { email, password });
  return user;
}

// POST /api/auth/logout
export async function logout() {
  await apiPost("/api/auth/logout");
}

// POST /api/auth/register — same two-step trust boundary as legacy
// register.html: this only creates the account (status='pending_payment')
// and signs the caller in (server sets the session cookie in the same
// response — see auth.js issueSession()); it does not itself charge or
// activate anything. Accepts the exact payload shape server/src/routes/
// auth.js's /register handler expects — `kind: "parent-learner"` (with
// `parent` + `learners[]`) or `kind: "adult"` (with `adult`) — passed
// straight through, not reshaped here. On success the response also
// carries the server-calculated registrationBreakdown/registrationTotalGHS
// and, for parent-learner, one generated login per learner — used as-is
// by RegisterPage, never recomputed client-side.
export async function registerAccount(payload) {
  return apiPost("/api/auth/register", payload);
}

// POST /api/payments/:userId/initiate — the same Mobile Money charge
// contract api/parent.js's initiateMonthlyPayment() uses (see
// PayMonthlyFeeModal), just with type: "registration" for the charge
// created immediately after registerAccount() above. userId is the
// parent's id (one combined charge covering every pending-payment ward —
// see routes/payments.js) or the adult learner's own id. Requires the
// session registerAccount() just established.
//
// `method` defaults to "MOBILE_MONEY" if omitted — every pre-existing
// caller of this function keeps working unchanged. Pass "CARD" for the
// international hosted-checkout path (see routes/payments.js); in that
// case network/momoNumber are ignored server-side and the response
// carries `authorizationUrl` instead of a MoMo status.
export async function initiateRegistrationPayment(userId, { method, network, momoNumber } = {}) {
  return apiPost(`/api/payments/${userId}/initiate`, { type: "registration", method: method || "MOBILE_MONEY", network, momoNumber });
}

/**
 * Classifies a login failure into what the UI needs to say, without
 * inventing any authorization logic of its own — every distinction here
 * comes straight from server/src/routes/auth.js's actual responses (see
 * Phase 1 analysis):
 *   - 401 "Incorrect email or password." -> invalid credentials
 *   - 403 "This account has been suspended..." -> restricted/suspended account
 *   - anything else with a response -> generic API error, show its message
 *   - no response at all (fetch itself threw) -> network/backend-unavailable
 *
 * The server's `error` string is always the message shown — this never
 * substitutes its own wording for what the backend actually said, so it
 * can't drift from the real account-status logic.
 */
export function classifyAuthError(err) {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return { kind: "invalid_credentials", message: err.message };
    }
    if (err.status === 403) {
      return { kind: "restricted", message: err.message };
    }
    return { kind: "api_error", message: err.message, status: err.status };
  }
  // fetch() itself rejected (offline, DNS failure, backend process down) —
  // there is no server response to read a message from.
  return { kind: "network", message: "Unable to reach the server. Check your connection and try again." };
}

// POST /api/users/forgot-password — always responds 200 with the same
// generic { ok, message } regardless of whether the email matches an
// account (see server/src/routes/users.js), so this can never surface
// "that email doesn't exist" — same privacy guarantee as legacy
// login.html's doForgot(). In non-production, the response also carries
// a devResetLink (a real, usable token link) since no email service is
// wired up yet — ForgotPasswordPage surfaces it as-is, never fabricated
// client-side.
export async function requestPasswordReset(email) {
  return apiPost("/api/users/forgot-password", { email });
}

// POST /api/users/reset-password — consumes a single-use, 1-hour token
// (see server/src/routes/users.js). token is only ever read from the URL
// and forwarded here — never logged, stored, or persisted client-side.
export async function resetPassword(token, newPassword, confirmNewPassword) {
  return apiPost("/api/users/reset-password", { token, newPassword, confirmNewPassword });
}
