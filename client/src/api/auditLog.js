/* ==========================================================================
   Audit Trail — read-only API. Super-Administrator-only surface: every
   route here is gated server-side by requireSuperAdmin (see
   server/src/routes/auditLog.js). Nothing here writes anything — audit
   rows are produced by the backend itself (utils/auditLog.js /
   middleware/auditTrail.js) as a side effect of other actions, never by a
   direct client call.
   ========================================================================== */
import { apiGet } from "./client";

// GET /api/audit-log?actorId=&entityType=&action=&search=&from=&to=&page=&pageSize=
// Returns { entries, total, page, pageSize, totalPages }.
export async function fetchAuditLog(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  const qs = query.toString();
  return apiGet(`/api/audit-log${qs ? `?${qs}` : ""}`);
}

// GET /api/audit-log/filters — distinct entity types/actions currently in
// the trail, to populate the filter dropdowns with only values that will
// actually return something.
export async function fetchAuditLogFilters() {
  return apiGet("/api/audit-log/filters");
}
