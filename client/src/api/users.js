/* ==========================================================================
   GET /api/users/:id — shared across portals (learner viewing themself,
   parent viewing themself or a linked child; server enforces the actual
   boundary via requireSelfParentOrStaff, see Phase 1/6 analysis). Kept in
   its own module rather than duplicated per-portal since it's a single
   generic endpoint, not learner- or parent-specific behavior.
   ========================================================================== */
import { apiGet, apiPatch, apiPost } from "./client";

export async function fetchUser(id) {
  const { user } = await apiGet(`/api/users/${id}`);
  return user;
}

// PATCH /api/users/:userId/profile — name/phone, self-only (server also
// accepts a parent/staff caller per requireSelfParentOrStaff, but rejects
// with 403 unless req.user.id === userId — see routes/users.js. This is
// the self-service path every account uses on their own Profile page.)
export async function updateProfile(userId, { name, phone }) {
  return apiPatch(`/api/users/${userId}/profile`, { name, phone });
}

// POST /api/users/:userId/avatar — multipart upload, self-only.
export async function uploadAvatar(userId, file) {
  const fd = new FormData();
  fd.append("avatar", file);
  return apiPost(`/api/users/${userId}/avatar`, fd, { isForm: true });
}

// POST /api/users/:userId/password — self-only, requires the current
// password (verified server-side via bcrypt.compareSync).
export async function changePassword(userId, { currentPassword, newPassword, confirmNewPassword }) {
  return apiPost(`/api/users/${userId}/password`, { currentPassword, newPassword, confirmNewPassword });
}
