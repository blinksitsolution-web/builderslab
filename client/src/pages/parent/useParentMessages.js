import { useCallback, useEffect, useState } from "react";
import { useParentChildren } from "./useParentChildren";
import { fetchInstructorsForLearner, fetchThread, sendMessage as sendMessageApi, fetchModules } from "../../api/parent";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

/**
 * Messages (Phase 22) — migrates legacy parentMessages() /
 * renderMessagesPanel() (dashboard.html): contacts are every instructor
 * teaching any linked child (GET /api/users/instructors-for/:learnerId
 * per child, deduplicated — same as legacy's `perChild.flat()` +
 * `Map`), each thread via GET /api/messages/thread/:otherUserId. Parents
 * don't broadcast (that's instructor/admin-only), so unlike
 * InstructorMessagesPage this is chat-only.
 */
export function useParentMessages() {
  const { refresh } = useAuth();
  const { status: childrenStatus, errorMessage: childrenError, availableWards, reload: reloadChildren } = useParentChildren();
  const [status, setStatus] = useState("loading");
  const [contacts, setContacts] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [activeContactId, setActiveContactId] = useState(null);
  const [thread, setThread] = useState([]);
  const [threadStatus, setThreadStatus] = useState("idle");

  const loadContacts = useCallback(async () => {
    if (childrenStatus !== "ready") return;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const [perChild, modules] = await Promise.all([
        Promise.all(availableWards.map((w) => fetchInstructorsForLearner(w.id).catch(() => []))),
        fetchModules(),
      ]);
      const byId = new Map();
      perChild.flat().forEach((i) => byId.set(i.id, i));
      const contactsList = Array.from(byId.values()).map((i) => ({
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
  }, [childrenStatus, availableWards, refresh]);

  const loadThread = useCallback(async () => {
    if (!activeContactId) return;
    setThreadStatus("loading");
    try {
      const messages = await fetchThread(activeContactId);
      setThread(messages);
      setThreadStatus("ready");
    } catch (e) {
      setThreadStatus("error");
    }
  }, [activeContactId]);

  useEffect(() => {
    loadContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childrenStatus, availableWards.map((w) => w.id).join(",")]);

  useEffect(() => {
    loadThread();
  }, [loadThread]);

  async function sendMessage(body) {
    if (!activeContactId || !body.trim()) return;
    await sendMessageApi({ to: activeContactId, body: body.trim() });
    await loadThread();
  }

  return {
    childrenStatus,
    childrenError,
    reloadChildren,
    status,
    contacts,
    errorMessage,
    activeContactId,
    setActiveContactId,
    thread,
    threadStatus,
    sendMessage,
    reload: loadContacts,
  };
}
