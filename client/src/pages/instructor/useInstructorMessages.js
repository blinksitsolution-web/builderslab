import { useCallback, useEffect, useState } from "react";
import {
  fetchLearners,
  fetchParents,
  fetchThread,
  fetchCampuses,
  sendMessage as sendMessageApi,
  broadcastLearners as broadcastLearnersApi,
} from "../../api/instructor";
import { isUnauthorizedError } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { useMyTeachingContext } from "./useMyTeachingContext";

/**
 * Instructor Messages — migrates legacy instructorMessages() /
 * renderMessagesPanel() / switchThread() / sendChat() /
 * broadcastToLearners() (dashboard.html).
 *
 * Contacts: learners (already scoped server-side to this instructor's
 * assigned classes/modules by GET /api/users — see api/instructor.js
 * header) plus parents (any parent, matching the legacy contact list,
 * which draws parents from the same unscoped GET /api/users role=parent
 * the legacy screen used).
 */
export function useInstructorMessages() {
  const { user: authUser, refresh } = useAuth();
  const teaching = useMyTeachingContext();
  const [status, setStatus] = useState("loading");
  const [contacts, setContacts] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [activeContactId, setActiveContactId] = useState(null);
  const [thread, setThread] = useState([]);
  const [threadStatus, setThreadStatus] = useState("idle");
  const [campuses, setCampuses] = useState([]);

  const loadContacts = useCallback(async () => {
    if (!authUser) return;
    setStatus("loading");
    try {
      const [parents, learners, campusesResult] = await Promise.all([fetchParents(), fetchLearners(), fetchCampuses()]);
      const learnerContacts = learners.map((l) => ({ id: l.id, name: l.name, subtitle: l.is_adult ? "Adult learner" : `Learner${l.className ? ` — ${l.className}` : ""}` }));
      const parentContacts = parents.map((p) => ({ id: p.id, name: p.name, subtitle: "Parent" }));
      const all = [...learnerContacts, ...parentContacts];
      setContacts(all);
      setCampuses(campusesResult);
      setActiveContactId((current) => current || all[0]?.id || null);
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
    } catch (e) {
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

  async function broadcastToLearners({ subject, body, moduleId, campus, audience, learningInstanceId, classId }) {
    return broadcastLearnersApi({ subject, body, moduleId, campus, audience, learningInstanceId, classId });
  }

  return {
    teaching,
    status,
    contacts,
    campuses,
    errorMessage,
    activeContactId,
    setActiveContactId,
    thread,
    threadStatus,
    sendMessage,
    broadcastToLearners,
    reload: loadContacts,
  };
}
