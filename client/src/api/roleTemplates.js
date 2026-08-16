/* ==========================================================================
   RBAC: Role Templates & Custom Permissions (Phase 19). Migrates legacy
   adminAccessControl() / renderRoleTemplateTable() / openRoleTemplateEditor()
   / manageAdminAccess() (dashboard.html) — same GET/POST/PATCH/DELETE
   endpoints, methods, request bodies, and response shapes as api.js's
   DTL.roleTemplates / DTL.permissionCatalog / DTL.createRoleTemplate /
   DTL.updateRoleTemplate / DTL.duplicateRoleTemplate /
   DTL.setRoleTemplateActive / DTL.deleteRoleTemplate /
   DTL.assignRoleTemplate / DTL.setCustomPermissions (see Phase 1 analysis
   and server/src/routes/roleTemplates.js, server/src/routes/users.js).

   Kept as its own module rather than folded into admin.js: this is a
   distinct, Super-Administrator-only surface (every route here is gated
   server-side by requireSuperAdmin — see roleTemplates.js and users.js),
   not part of the general Manage Accounts listing/actions api/admin.js
   already covers.
   ========================================================================== */
import { apiGet, apiPost, apiPatch, apiDelete } from "./client";

// GET /api/role-templates/permission-catalog — every permission checkable
// anywhere in the LMS, grouped by module (server/src/utils/permissions.js
// PERMISSION_GROUPS). Same shape DTL.permissionCatalog() returns, and the
// only source of truth for what a permission checkbox grid can offer —
// never hand-typed/duplicated client-side.
export async function fetchPermissionCatalog() {
  const { groups } = await apiGet("/api/role-templates/permission-catalog");
  return groups;
}

export async function fetchRoleTemplates() {
  const { templates } = await apiGet("/api/role-templates");
  return templates;
}

export async function createRoleTemplate(payload) {
  return apiPost("/api/role-templates", payload);
}

// { description?, permissions?, isActive? } — the backend itself refuses to
// let the Super Administrator template's permissions shrink (see
// server/src/routes/roleTemplates.js), so callers may omit `permissions`
// entirely for that one template rather than re-deriving the rule here.
export async function updateRoleTemplate(id, payload) {
  return apiPatch(`/api/role-templates/${id}`, payload);
}

export async function duplicateRoleTemplate(id) {
  return apiPost(`/api/role-templates/${id}/duplicate`);
}

// Matches DTL.setRoleTemplateActive(id, active) exactly — two distinct
// backend routes (enable/disable), not a single PATCH with a body.
export async function setRoleTemplateActive(id, active) {
  return apiPatch(`/api/role-templates/${id}/${active ? "enable" : "disable"}`);
}

export async function deleteRoleTemplate(id) {
  return apiDelete(`/api/role-templates/${id}`);
}

// PATCH /api/users/:userId/role-template — assign a predefined Role
// Template (Option 1). corporateClientId is only meaningful (and only
// required by the backend) when the template is "Corporate Coordinator"
// and the target doesn't already have one — see
// server/src/routes/users.js. campus is only meaningful (and required by
// the backend) when the template is "Campus Administrator". Pass
// null/undefined for whichever doesn't apply.
export async function assignRoleTemplate(userId, roleTemplateId, corporateClientId, campus) {
  return apiPatch(`/api/users/${userId}/role-template`, { roleTemplateId, corporateClientId, campus });
}

// PATCH /api/users/:userId/campus-assignment — change an existing Campus
// Administrator's assigned campus without touching their Role
// Template/permissions (see server/src/routes/users.js).
export async function assignAdminCampus(userId, campus) {
  return apiPatch(`/api/users/${userId}/campus-assignment`, { campus });
}

// PATCH /api/users/:userId/permissions — assign a Custom Permission Set
// (Option 2). Fully overrides the template for this administrator only;
// the backend does not merge it with any template (server/src/utils/rbac.js
// effectivePermissions()).
export async function setCustomPermissions(userId, permissions) {
  return apiPatch(`/api/users/${userId}/permissions`, { permissions });
}

// GET /api/learning-offerings/corporate-clients?all=true — needed only to
// populate the Corporate Client select the Manage Access modal shows when
// the "Corporate Coordinator" template is selected (matching legacy
// manageAdminAccess()'s own Promise.all fetch). Narrow, direct dependency
// of role-template assignment, not a broader Corporate Clients management
// migration (out of scope for this phase).
export async function fetchCorporateClientsForRoleAssignment() {
  const { corporateClients } = await apiGet("/api/learning-offerings/corporate-clients?all=true");
  return corporateClients;
}
