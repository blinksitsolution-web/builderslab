/**
 * Pure error-response shaping used by the central Express error handler in
 * server.js. Extracted into its own module (no Express dependency) purely
 * so the production-sanitization behavior can be unit-tested without
 * booting the server — the logic itself is unchanged from what previously
 * lived inline in the error-handling middleware.
 */
function buildErrorResponse(err, isProduction) {
  const status = err.status || 500;
  if (isProduction) {
    // Never leak SQL errors, filesystem paths, stack traces, or other
    // internal implementation details to the client in production. 4xx
    // errors thrown deliberately by route handlers (e.g. validation) still
    // carry their intended message; anything else (typically a 500 from an
    // unexpected/internal failure) collapses to a generic message.
    const safeMessage = status < 500 && err.message ? err.message : "Something went wrong.";
    return { status, body: { error: safeMessage } };
  }
  return { status, body: { error: err.message || "Something went wrong.", stack: err.stack } };
}

module.exports = { buildErrorResponse };
