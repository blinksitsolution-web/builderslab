import { useState } from "react";
import { broadcastToParents } from "../../api/admin";

/**
 * Broadcast Messages (final admin migration pass). Migrates legacy
 * adminBroadcast()/sendBroadcast() (dashboard.html) — same
 * POST /api/messages/broadcast contract (see api/admin.js and
 * server/src/routes/messages.js). Admin Broadcast is a single-form
 * "send to all parents" tool, same as legacy; no other admin broadcast
 * surface exists in dashboard.html's admin nav.
 */
export function useAdminBroadcast() {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    if (!body.trim()) throw new Error("Write a message first.");
    setSending(true);
    try {
      const result = await broadcastToParents({ subject, body });
      setSubject("");
      setBody("");
      return result.sentTo;
    } finally {
      setSending(false);
    }
  }

  return { subject, setSubject, body, setBody, sending, send };
}
