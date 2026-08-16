import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { getPostLoginRoute } from "../../routing/postLoginRoute";
import { Button, Input, FormField, Alert, Card } from "../../components/ui";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ERROR_PRESENTATION = {
  invalid_credentials: { variant: "danger", title: "Incorrect email or password" },
  restricted: { variant: "warning", title: "Account restricted" },
  network: { variant: "danger", title: "Connection problem" },
  api_error: { variant: "danger", title: "Sign-in failed" },
};

/**
 * Migrated login experience (Phase 4). Talks to the existing
 * POST /api/auth/login endpoint exactly as api.js's DTL.login() does —
 * same path, same body, same httpOnly-cookie session — nothing about the
 * backend contract changes here. See api/auth.js `login()` /
 * `classifyAuthError()` for how the 401 (invalid credentials) vs 403
 * (suspended account) vs network-failure distinction is made, straight
 * from the server's own responses.
 */
export default function LoginPage() {
  const { login, authError, clearAuthError, isAuthenticated, isLoading, user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  // Already signed in (e.g. session restored on load, or the user
  // navigated back to /app/login by hand) — go straight to their portal
  // rather than showing them a login form again.
  useEffect(() => {
    clearAuthError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isLoading && isAuthenticated) {
    const from = location.state?.from?.pathname;
    return <Navigate to={from || getPostLoginRoute(user)} replace />;
  }

  function validate() {
    const errors = {};
    if (!email.trim()) errors.email = "Enter your email address.";
    else if (!EMAIL_PATTERN.test(email.trim())) errors.email = "Enter a valid email address.";
    if (!password) errors.password = "Enter your password.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const loggedInUser = await login(email.trim(), password);
      toast.success(`Welcome back, ${loggedInUser.name?.split(" ")[0] || "there"}.`);
      const from = location.state?.from?.pathname;
      navigate(from || getPostLoginRoute(loggedInUser), { replace: true });
    } catch (err) {
      // authError is already set by AuthContext.login(); nothing further
      // to do here besides releasing the button's loading state.
    } finally {
      setSubmitting(false);
    }
  }

  const errorPresentation = authError ? ERROR_PRESENTATION[authError.kind] || ERROR_PRESENTATION.api_error : null;

  return (
    <AuthLayout
      eyebrow="Welcome back"
      title="Sign in to continue your learning"
      description="Access your lessons, assignments, grades, and everything else in one place — built for learners, parents, instructors, and administrators alike."
    >
      <Card>
        <h2 style={{ marginBottom: "var(--space-1)" }}>Sign in</h2>
        <p className="text-helper" style={{ marginBottom: "var(--space-5)" }}>
          Enter your account email and password.
        </p>

        {errorPresentation && (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Alert variant={errorPresentation.variant} title={errorPresentation.title} onDismiss={clearAuthError}>
              {authError.message}
            </Alert>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <FormField label="Email" required error={fieldErrors.email}>
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={submitting}
            />
          </FormField>

          <FormField label="Password" required error={fieldErrors.password}>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={submitting}
            />
          </FormField>

          <Button type="submit" variant="primary" fullWidth loading={submitting}>
            Sign in
          </Button>
        </form>

        <p className="text-helper" style={{ marginTop: "var(--space-5)", textAlign: "center" }}>
          Need an account? <Link to="/app/register">Register here</Link>.
        </p>
        <p className="text-caption" style={{ textAlign: "center" }}>
          <Link to="/app/forgot-password">Forgot your password?</Link>
        </p>
      </Card>
    </AuthLayout>
  );
}
