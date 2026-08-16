import { useState } from "react";
import { useParentMessages } from "./useParentMessages";
import { PageHeader, Input, Button, Skeleton, EmptyState, ErrorState } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";
import styles from "./ParentMessagesPage.module.css";

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
    return <EmptyState title="No contacts yet" description="Instructors teaching your linked children will appear here." />;
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
 * Messages (Phase 22) — migrates legacy parentMessages() /
 * renderMessagesPanel() (dashboard.html): direct messages with every
 * instructor teaching a linked child. Same endpoints as
 * InstructorMessagesPage (GET /api/messages/thread/:id, POST
 * /api/messages) but no broadcast panel — parents don't broadcast in
 * legacy either.
 */
export default function ParentMessagesPage() {
  const { user } = useAuth();
  const { childrenStatus, childrenError, reloadChildren, status, contacts, errorMessage, activeContactId, setActiveContactId, thread, threadStatus, sendMessage, reload } =
    useParentMessages();

  if (childrenStatus === "loading" || status === "loading") {
    return (
      <div>
        <PageHeader title="Messages" />
        <Skeleton height={200} width="100%" />
      </div>
    );
  }

  if (childrenStatus === "error") {
    return <ErrorState description={childrenError} action={{ label: "Try again", onClick: reloadChildren }} />;
  }

  if (status === "error") {
    return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  }

  return (
    <div>
      <PageHeader title="Messages" description="Direct messages with your children's instructors" />
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
