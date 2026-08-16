/* ==========================================================================
   Notifications — thin wrappers around the existing messages system
   (server/src/routes/messages.js's /unread-count and /recent), used by
   layout/Topbar.jsx's bell. Kept in its own file rather than folded into
   api/parent.js since this is genuinely cross-role (every portal has a
   Topbar), unlike most of that file's contents.
   ========================================================================== */
import { apiGet } from "./client";

export async function fetchUnreadMessageCount() {
  const { count } = await apiGet("/api/messages/unread-count");
  return count;
}

export async function fetchRecentMessages(limit = 5) {
  const { messages } = await apiGet(`/api/messages/recent?limit=${limit}`);
  return messages;
}
