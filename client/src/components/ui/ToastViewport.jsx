import { useToast } from "../../context/ToastContext";
import styles from "./Toast.module.css";

const TONE = { success: "success", danger: "danger", warning: "warning", info: "info" };

/**
 * Mounted once (in App.jsx). Non-disruptive: renders in a fixed corner,
 * doesn't block interaction with the rest of the page, and each toast
 * auto-dismisses (see ToastContext) while remaining manually dismissible.
 * `aria-live="polite"` announces new toasts without interrupting whatever
 * the screen reader user is currently doing.
 */
export default function ToastViewport() {
  const { toasts, dismiss } = useToast();

  return (
    <div className={styles.viewport} aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={[styles.toast, styles[TONE[t.variant] || "info"]].join(" ")} role="status">
          <div className={styles.body}>
            {t.title && <p className={styles.title}>{t.title}</p>}
            <p className={styles.message}>{t.message}</p>
          </div>
          <button type="button" className={styles.close} onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
