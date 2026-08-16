import { useState } from "react";
import { useInstructorMessages } from "./useInstructorMessages";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { PageHeader, Card, Button, FormField, Input, Textarea, Select, Skeleton, EmptyState, ErrorState } from "../../components/ui";
import styles from "./InstructorMessagesPage.module.css";

function BroadcastPanel({ teaching, campuses, onBroadcast }) {
  const toast = useToast();
  const [moduleId, setModuleId] = useState("");
  const [classId, setClassId] = useState("");
  const [campus, setCampus] = useState("all");
  const [audience, setAudience] = useState("both");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  // Instructor Context Selection (Issue #4) — same "which run/cohort?"
  // pattern InstructorNotesPage/InstructorExaminationsPage already use:
  // `eligibleInstances` only appears on a module (GET /api/modules/mine)
  // when this instructor has more than one currently-Active Run assigned
  // to it for that Course, so the picker only shows up when there's an
  // actual choice to make.
  const selectedModule = teaching.modules.find((m) => m.id === moduleId);
  const eligibleInstances = selectedModule?.eligibleInstances || [];
  const [learningInstanceId, setLearningInstanceId] = useState("");

  function handleModuleChange(id) {
    setModuleId(id);
    const nextModule = teaching.modules.find((m) => m.id === id);
    const nextEligible = nextModule?.eligibleInstances || [];
    setLearningInstanceId(nextEligible.length === 1 ? nextEligible[0].id : "");
    setClassId("");
  }

  async function handleSend() {
    if (!body.trim()) return toast.error("Write a message first.");
    if (!moduleId) return toast.error("Choose which module this message is for.");
    if (eligibleInstances.length > 1 && !learningInstanceId) return toast.error("Choose which run/cohort this is for.");
    setSending(true);
    try {
      const result = await onBroadcast({
        subject: subject.trim(),
        body: body.trim(),
        moduleId,
        audience,
        classId: classId || undefined,
        learningInstanceId: learningInstanceId || undefined,
        campus: campus !== "all" ? campus : undefined,
      });
      toast.success(`Sent to ${result.sentTo} learner(s).`);
      setSubject("");
      setBody("");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Card padding>
      <h3 style={{ marginTop: 0 }}>Message all learners at once</h3>
      <div className="grid-2">
        <FormField label="Module">
          <Select value={moduleId} onChange={(e) => handleModuleChange(e.target.value)}>
            <option value="">Choose…</option>
            {teaching.modules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </FormField>
        {eligibleInstances.length > 1 && (
          <FormField label="Which run/cohort?" helperText="You're assigned to more than one active run of this module.">
            <Select value={learningInstanceId} onChange={(e) => setLearningInstanceId(e.target.value)}>
              <option value="">Choose…</option>
              {eligibleInstances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name || i.id}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        {teaching.classes.length > 0 && (
          <FormField label="Class" helperText="Optional — leave unset to reach every class in this module">
            <Select value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">All classes</option>
              {teaching.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Campus" helperText="Optional">
          <Select value={campus} onChange={(e) => setCampus(e.target.value)}>
            <option value="all">All campuses</option>
            {campuses.map((c) => (
              <option key={c.id || c.name} value={c.name}>
                {c.name} only
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      {/* A module can be taught to Child and Adult learners at once (see
         Stage 3) — let the instructor narrow who actually receives it
         rather than always messaging both. Server-enforced, not just this
         dropdown (see routes/messages.js). */}
      <FormField label="Send to" helperText="Only learners in this module">
        <Select value={audience} onChange={(e) => setAudience(e.target.value)}>
          <option value="both">Child and Adult learners</option>
          <option value="child">Child learners only</option>
          <option value="adult">Adult learners only</option>
        </Select>
      </FormField>
      <FormField label="Subject">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </FormField>
      <FormField label="Message">
        <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </FormField>
      <Button variant="primary" size="sm" loading={sending} onClick={handleSend}>
        Send to matching learners
      </Button>
    </Card>
  );
}

function ChatPanel({ contacts, activeContactId, setActiveContactId, thread, threadStatus, onSend, currentUserId }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!draft.trim()) return;
    setSending(true);
    try {
      await onSend(draft);
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  if (contacts.length === 0) {
    return <EmptyState title="No contacts yet" description="Learners and parents you're connected to will appear here." />;
  }

  return (
    <div className={styles.shell}>
      <div className={styles.list}>
        {contacts.map((c) => (
          <button key={c.id} className={[styles.contact, c.id === activeContactId ? styles.active : ""].join(" ")} onClick={() => setActiveContactId(c.id)}>
            <span>{c.name}</span>
            {c.subtitle && <span className={styles.subtitle}>{c.subtitle}</span>}
          </button>
        ))}
      </div>
      <div className={styles.body}>
        <div className={styles.messages}>
          {threadStatus === "loading" && <Skeleton height={16} width="50%" />}
          {threadStatus === "error" && <ErrorState title="Couldn't load this conversation" />}
          {threadStatus === "ready" && thread.length === 0 && <p className="text-helper">No messages yet — say hello!</p>}
          {threadStatus === "ready" &&
            thread.map((m) => (
              <div key={m.id} className={[styles.bubble, m.from_id === currentUserId ? styles.me : styles.them].join(" ")}>
                {m.body}
              </div>
            ))}
        </div>
        <div className={styles.inputRow}>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type a message…"
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
          />
          <Button variant="primary" size="sm" loading={sending} onClick={handleSend}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Instructor Messages (Phase 12). Migrates legacy instructorMessages() /
 * renderMessagesPanel() / broadcastToLearners() (dashboard.html) — same
 * endpoints (GET /api/messages/thread/:id, POST /api/messages, POST
 * /api/messages/broadcast-learners). Direct instructor<->learner messages
 * are further restricted server-side to assigned pairs (see
 * server/src/routes/messages.js) — not re-derived here.
 */
export default function InstructorMessagesPage() {
  const { user } = useAuth();
  const { teaching, status, contacts, campuses, errorMessage, activeContactId, setActiveContactId, thread, threadStatus, sendMessage, broadcastToLearners, reload } =
    useInstructorMessages();

  if (status === "loading" || teaching.status === "loading") {
    return (
      <div>
        <PageHeader title="Messages" />
        <Skeleton height={200} width="100%" />
      </div>
    );
  }

  if (status === "error") {
    return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  }

  return (
    <div>
      <PageHeader title="Messages" description="Direct messages with learners & parents" />
      <BroadcastPanel teaching={teaching} campuses={campuses} onBroadcast={broadcastToLearners} />
      <div style={{ marginTop: "var(--space-6)" }}>
        <ChatPanel
          contacts={contacts}
          activeContactId={activeContactId}
          setActiveContactId={setActiveContactId}
          thread={thread}
          threadStatus={threadStatus}
          onSend={sendMessage}
          currentUserId={user.id}
        />
      </div>
    </div>
  );
}
