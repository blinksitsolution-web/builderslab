/**
 * Pure check used at server startup to fail loudly instead of silently
 * starting with an unsafe/missing credentialed CORS origin in production.
 * Extracted into its own module (no Express/process dependency baked in —
 * `env` is passed in explicitly) so it's unit-testable without booting the
 * server. Logic is unchanged from what previously lived inline.
 */
function isProductionCorsMisconfigured(env) {
  return env.NODE_ENV === "production" && !env.APP_URL;
}

module.exports = { isProductionCorsMisconfigured };
