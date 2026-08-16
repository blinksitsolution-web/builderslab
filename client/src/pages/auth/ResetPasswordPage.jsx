import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import { resetPassword as resetPasswordRequest } from "../../api/auth";
import { isStrongPassword, passwordMessage } from "../../utils/validators";
import { Button, Input, FormField, Alert, Card } from "../../components/ui";

const REDIRECT_DELAY_MS = 3000;

/**
 * Token-consuming step of the password-reset flow (Group 2, final
 * non-admin migration) — a React port of legacy reset-password.html's
 * doReset(). Reads `token` from the URL and forwards it, unmodified and
 * un-persisted, to the same POST /api/users/reset-password endpoint —
 * the token is never written to storage, state beyond this render, or
 * logged. Same client-side password validation legacy added (shared
 * validators, matching the server's own rules exactly — see
 * utils/validators.js), so a weak password or mismatched confirmation is
 * caught before the round-trip.
 *
 * Reached via the link the backend emails (or, in non-production, the
 * devResetLink ForgotPasswordPage surfaces directly — see
 * server/src/routes/users.js and api/auth.js requestPasswordReset()).
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => navigate("/app/login", { replace: true }), REDIRECT_DELAY_MS);
    return () => clearTimeout(t);
  }, [success, navigate]);

  async function handleSubmit(e) {
    e.preventDefault();
    setFieldError("");
    if (!isStrongPassword(newPassword)) return setFieldError(passwordMessage(newPassword));
    if (newPassword !== confirmPassword) return setFieldError("Your password and confirmation don't match.");
    setSubmitting(true);
    try {
      await resetPasswordRequest(token, newPassword, confirmPassword);
      setSuccess(true);
    } catch (err) {
      setFieldError(err.message || "Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Account recovery"
      title="Choose a new password"
      description="This link only works once and expires an hour after it was requested, for your account's safety."
    >
      <Card>
        <h2 style={{ marginBottom: "var(--space-1)" }}>Reset your password</h2>

        {!token && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Alert variant="danger">This reset link is missing its token — request a new one from the sign-in page.</Alert>
            <p className="text-caption" style={{ textAlign: "center", marginTop: "var(--space-4)" }}>
              <Link to="/app/forgot-password">Request a new reset link</Link>
            </p>
          </div>
        )}

        {token && success && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Alert variant="success">Password updated — redirecting you to sign in…</Alert>
            <Button fullWidth style={{ marginTop: "var(--space-4)" }} onClick={() => navigate("/app/login", { replace: true })}>
              Sign in now
            </Button>
          </div>
        )}

        {token && !success && (
          <form onSubmit={handleSubmit} noValidate style={{ marginTop: "var(--space-4)" }}>
            <FormField label="New password (8+ chars, letters & numbers)" required>
              <Input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                disabled={submitting}
              />
            </FormField>
            <FormField label="Confirm new password" required>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                disabled={submitting}
              />
            </FormField>

            {fieldError && (
              <div style={{ marginBottom: "var(--space-4)" }}>
                <Alert variant="danger">{fieldError}</Alert>
              </div>
            )}

            <Button type="submit" variant="primary" fullWidth loading={submitting}>
              Set new password
            </Button>
          </form>
        )}
      </Card>
    </AuthLayout>
  );
}
