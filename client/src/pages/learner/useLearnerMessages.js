import { useCallback, useEffect, useState } from "react";
import { fetchInstructorsForLearner, fetchThread, sendMessage as sendMessageApi } from "../../api/parent";
import { fetchModules } from "../../api/learner";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Messages (final gap-closing pass — see Topbar.jsx's notification bell).
 * The backend has always supported learner<->instructor direct messaging
 * (routes/messages.js's POST / explicitly allows the pair, gated by
 * isLearnerAssignedToInstructor) and GET /api/users/instructors-for/:id
 * already accepts the learner calling for themself (requireSelfParentOrStaff),
 * but no React page ever called any of it — a learner had no way to see
 * or send a message at all. Mirrors useParentMessages.js's contact-list-
 * plus-thread shape, just without the per-child loop: a learner's
 * contacts are simply their own assigned instructors, not "every
 * instructor teaching any linked child".
 */
export function useLearnerMessages() {
  const { user: authUser, refresh } = useAuth();
  const [status, setStatus] = useState("loading");
  const [contacts, setContacts] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [activeContactId, setActiveContactId] = useState(null);
  const [thread, setThread] = useState([]);
  const [threadStatus, setThreadStatus] = useState("idle");

  const loadContacts = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const [instructors, modules] = await Promise.all([fetchInstructorsForLearner(authUser.id), fetchModules()]);
      const contactsList = instructors.map((i) => ({
        id: i.id,
        name: i.name,
        subtitle: "Teaches: " + (i.courseIds || []).map((mid) => modules.find((m) => m.id === mid)?.title || mid).join(", "),
      }));
      setContacts(contactsList);
      setActiveContactId((current) => current || contactsList[0]?.id || null);
      setStatus("ready");
    } catch (e) {
      if (isUnauthorizedError(e)) {
        await refresh();
        return;
      }
      setErrorMessage(e.message);
      setStatus("error");
    }
  }, [authUser, refresh]);

  const loadThread = useCallback(async () => {
    if (!activeContactId) return;
    setThreadStatus("loading");
    try {
      const messages = await fetchThread(activeContactId);
      setThread(messages);
      setThreadStatus("ready");
    } catch {
      setThreadStatus("error");
    }
  }, [activeContactId]);

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    loadThread();
  }, [loadThread]);

  async function sendMessage(body) {
    if (!activeContactId || !body.trim()) return;
    await sendMessageApi({ to: activeContactId, body: body.trim() });
    await loadThread();
  }

  return { status, contacts, errorMessage, activeContactId, setActiveContactId, thread, threadStatus, sendMessage, reload: loadContacts };
}
