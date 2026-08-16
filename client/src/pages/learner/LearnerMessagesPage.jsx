import { useState } from "react";
import { useLearnerMessages } from "./useLearnerMessages";
import { PageHeader, Input, Button, Skeleton, EmptyState, ErrorState } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";
import styles from "../parent/ParentMessagesPage.module.css";

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
    return <EmptyState title="No contacts yet" description="Instructors teaching your modules will appear here." />;
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
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message…" onKeyDown={(e) => e.key === "Enter" && handleSend()} />
          <Button variant="primary" size="sm" loading={sending} onClick={handleSend}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Messages (final gap-closing pass — see Topbar.jsx's notification bell
 * and useLearnerMessages.js for why this page never existed before now:
 * the backend has always supported it, nothing in React ever called it).
 * Same shape as ParentMessagesPage.jsx/InstructorMessagesPage.jsx — a
 * contact list of the learner's own assigned instructors, chat-only (no
 * broadcast, matching parents).
 */
export default function LearnerMessagesPage() {
  const { user } = useAuth();
  const { status, contacts, errorMessage, activeContactId, setActiveContactId, thread, threadStatus, sendMessage, reload } = useLearnerMessages();

  if (status === "loading") {
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
      <PageHeader title="Messages" description="Direct messages with your instructors" />
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
  );
}
