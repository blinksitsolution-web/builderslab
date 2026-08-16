import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchUnreadMessageCount, fetchRecentMessages } from "../api/notifications";
import { onMessagesRead } from "../api/notificationEvents";
import IconButton from "../components/ui/IconButton";
import styles from "./NotificationBell.module.css";

const POLL_INTERVAL_MS = 45000;

// Where "View all" sends someone, per role — parent and instructor
// already have a full inbox page; learner now does too (see
// LearnerMessagesPage.jsx, built alongside this bell since it was a
// real gap). Admin has none: admins broadcast far more than they
// receive individual replies, and building a full admin inbox page
// wasn't part of what made the bell itself not work — this is a
// deliberate scope line, not an oversight, so admin's dropdown just
// shows more items inline instead of linking anywhere.
const MESSAGES_PAGE_BY_ROLE = { parent: "/app/parent/messages", instructor: "/app/instructor/messages", learner: "/app/learner/messages" };

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr.replace(" ", "T") + "Z").getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Real notification bell, replacing what used to be a purely decorative
 * placeholder (no onClick, no data — see Topbar.jsx's prior version).
 * Reuses the existing `messages` table (server/src/routes/messages.js's
 * new /unread-count and /recent) rather than a separate notifications
 * system — every "notification" in this app today is a message someone
 * sent, so there was no need to invent a second concept.
 */
export default function NotificationBell({ role }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [recent, setRecent] = useState(null); // null = not loaded yet
  const rootRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    function loadCount() {
      fetchUnreadMessageCount()
        .then((c) => !cancelled && setCount(c))
        .catch(() => {});
    }
    loadCount();
    const interval = setInterval(loadCount, POLL_INTERVAL_MS);
    const unsubscribe = onMessagesRead(loadCount);
    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    fetchRecentMessages(role === "admin" ? 15 : 5)
      .then(setRecent)
      .catch(() => setRecent([]));
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, role]);

  const viewAllPath = MESSAGES_PAGE_BY_ROLE[role];

  return (
    <div className={styles.root} ref={rootRef}>
      <IconButton label={`Notifications${count > 0 ? ` (${count} unread)` : ""}`} className={styles.bellWrap} onClick={() => setOpen((v) => !v)}>
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 8a5 5 0 0 1 10 0v3l1.4 2.5H3.6L5 11V8Z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
          <path d="M8 15.5a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
        {count > 0 && <span className={styles.badge}>{count > 9 ? "9+" : count}</span>}
      </IconButton>

      {open && (
        <div className={styles.panel} role="menu">
          <div className={styles.panelHeader}>Notifications</div>
          {recent === null && <div className={styles.empty}>Loading…</div>}
          {recent && recent.length === 0 && <div className={styles.empty}>You're all caught up.</div>}
          {recent &&
            recent.map((m) => (
              <button
                key={m.id}
                type="button"
                className={[styles.item, m.is_read ? "" : styles.unread].join(" ")}
                onClick={() => {
                  setOpen(false);
                  if (viewAllPath) navigate(viewAllPath);
                }}
              >
                <span className={styles.itemTop}>
                  <span className={styles.from}>{m.from_name}</span>
                  <span className={styles.time}>{timeAgo(m.date)}</span>
                </span>
                {m.subject && <span className={styles.subject}>{m.subject}</span>}
                <span className={styles.snippet}>{m.body}</span>
              </button>
            ))}
          {viewAllPath && (
            <button type="button" className={styles.viewAll} onClick={() => { setOpen(false); navigate(viewAllPath); }}>
              View all messages
            </button>
          )}
        </div>
      )}
    </div>
  );
}
