/* ==========================================================================
   Notification-bell refresh signal (Stage: Notification Read Counter).

   NotificationBell.jsx polls GET /api/messages/unread-count every
   POLL_INTERVAL_MS, but a message is actually marked read as a side
   effect of GET /api/messages/thread/:otherUserId (see
   server/src/routes/messages.js), called from the Messages pages —
   nowhere near the bell. Without this, reading the last unread message
   left the bell showing its last-polled (stale, nonzero) count until the
   next poll cycle instead of disappearing immediately.

   A plain EventTarget is enough here: there's exactly one event, no
   payload, and every subscriber just wants to know "unread counts may
   have changed, refetch". fetchThread() (api/parent.js, api/instructor.js)
   emits after each successful call; NotificationBell.jsx listens and
   refetches its count right away, in addition to its normal poll.
   ========================================================================== */
const target = new EventTarget();
const EVENT_NAME = "messages-read";

export function notifyMessagesRead() {
  target.dispatchEvent(new Event(EVENT_NAME));
}

export function onMessagesRead(callback) {
  target.addEventListener(EVENT_NAME, callback);
  return () => target.removeEventListener(EVENT_NAME, callback);
}
