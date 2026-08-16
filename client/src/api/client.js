/* ==========================================================================
   React API client foundation.

   Mirrors the contract already established by the legacy /api.js (see
   Phase 1 analysis):
     - same-origin, cookie-based session (httpOnly JWT set by the server) —
       every request sends credentials:"include" and never reads/writes the
       token itself.
     - JSON body by default; raw FormData passed through untouched so the
       browser sets the multipart boundary (mirrors DTL's `isForm` flag).
     - Non-2xx responses throw a normalized Error with `.status` and `.code`
       (matches DTL's req() so ACCESS_RESTRICTED / 401 / 403 handling below
       behaves identically to the legacy frontend).

   This file intentionally does NOT reimplement every method from api.js —
   per Phase 2 scope, only the client architecture is established here.
   Endpoint modules (e.g. src/api/auth.js) are added incrementally as each
   portal is migrated.
   ========================================================================== */

const API_BASE = ""; // same-origin in production; proxied by Vite in dev (see vite.config.js)

export class ApiError extends Error {
  constructor(message, { status, code, extra } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (extra && typeof extra === "object") Object.assign(this, extra);
  }
}

/**
 * Low-level request helper. Mirrors DTL's req(method, url, body, isForm).
 *
 * @param {string} method
 * @param {string} url - path beginning with /api/...
 * @param {object|FormData} [body]
 * @param {{ isForm?: boolean }} [options]
 */
export async function apiRequest(method, url, body, { isForm = false } = {}) {
  const opts = { method, credentials: "include" };

  if (body !== undefined && body !== null) {
    if (isForm) {
      opts.body = body; // FormData — browser sets the multipart boundary itself
    } else {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
  }

  const res = await fetch(API_BASE + url, opts);

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* no body / not JSON */
  }

  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    const { error, code, ...extra } = data || {};
    throw new ApiError(message, { status: res.status, code, extra });
  }

  return data;
}

// Convenience verb helpers — thin wrappers, kept intentionally minimal.
export const apiGet = (url) => apiRequest("GET", url);
export const apiPost = (url, body, options) => apiRequest("POST", url, body, options);
export const apiPatch = (url, body, options) => apiRequest("PATCH", url, body, options);
export const apiPut = (url, body, options) => apiRequest("PUT", url, body, options);
export const apiDelete = (url) => apiRequest("DELETE", url);

// Shared predicate for the payment/access-restriction gate the backend
// returns as { error, code: "ACCESS_RESTRICTED" } on 403 (see Phase 1:
// requireActiveAccess* middleware). Callers (e.g. AuthContext, future
// per-portal data hooks) check this instead of re-deriving the rule.
export function isAccessRestrictedError(err) {
  return !!err && err.code === "ACCESS_RESTRICTED";
}

export function isUnauthorizedError(err) {
  return !!err && err.status === 401;
}

export function isForbiddenError(err) {
  return !!err && err.status === 403;
}
