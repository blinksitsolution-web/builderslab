import { useState } from "react";
import { Link } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import { requestPasswordReset } from "../../api/auth";
import { isValidEmail } from "../../utils/validators";
import { Button, Input, FormField, Alert, Card } from "../../components/ui";

/**
 * Request-a-reset-link step of the password-reset flow (Group 2, final
 * non-admin migration) — a React port of legacy login.html's #forgotPanel
 * / doForgot(). Talks to the same POST /api/users/forgot-password
 * endpoint, which always responds with the same generic message whether
 * or not the email matches an account (a privacy guarantee this page
 * preserves by displaying the server's message verbatim, never inferring
 * success/failure from it).
 *
 * Reachable from LoginPage's "Forgot your password?" link. The
 * token-consuming step lives at /app/reset-password (see
 * ResetPasswordPage.jsx), reached via the emailed link — or, in
 * non-production, via the devResetLink this page surfaces directly when
 * the backend returns one (no email service configured yet).
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { message, devResetLink? }
  const [apiError, setApiError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setApiError("");
    setResult(null);
    const trimmed = email.trim();
    if (!trimmed) return setFieldError("Enter your account email.");
    if (!isValidEmail(trimmed)) return setFieldError("Enter a valid email address.");
    setFieldError("");
    setSubmitting(true);
    try {
      const data = await requestPasswordReset(trimmed);
      setResult(data);
    } catch (err) {
      // A genuine network/server failure — the endpoint itself never
      // rejects for an unrecognized email (see api/auth.js comment).
      setApiError(err.message || "Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Account recovery"
      title="Reset your password"
      description="Enter your account email — if it exists, we'll generate a reset link."
    >
      <Card>
        <h2 style={{ marginBottom: "var(--space-1)" }}>Reset your password</h2>
        <p className="text-helper" style={{ marginBottom: "var(--space-5)" }}>
          Enter your account email — if it exists, we'll generate a reset link.
        </p>

        {apiError && (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Alert variant="danger" onDismiss={() => setApiError("")}>
              {apiError}
            </Alert>
          </div>
        )}

        {result && (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Alert variant="info">
              {result.message}
              {result.devResetLink && (
                <>
                  <br />
                  <br />
                  <strong>Dev mode</strong> (no email service configured yet) — use this link directly:{" "}
                  <a href={result.devResetLink}>{result.devResetLink}</a>
                </>
              )}
            </Alert>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <FormField label="Email" required error={fieldError}>
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              disabled={submitting}
            />
          </FormField>

          <Button type="submit" variant="primary" fullWidth loading={submitting}>
            Send reset link
          </Button>
        </form>

        <p className="text-caption" style={{ textAlign: "center", marginTop: "var(--space-4)" }}>
          <Link to="/app/login">← Back to sign in</Link>
        </p>
      </Card>
    </AuthLayout>
  );
}
