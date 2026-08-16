import styles from "./Alert.module.css";

const ICONS = {
  success: (
    <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  danger: (
    <>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" />
      <path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2 20h20L12 3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" fill="none" />
      <path d="M12 9v5M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" />
      <path d="M12 11v5M12 7h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
};

/**
 * @param {"info"|"success"|"warning"|"danger"} [variant]
 * @param {string} [title]
 * @param {() => void} [onDismiss] - shows a close button when provided
 */
export default function Alert({ variant = "info", title, onDismiss, children, className = "" }) {
  return (
    <div className={[styles.alert, styles[variant], className].filter(Boolean).join(" ")} role="alert">
      <svg className={styles.icon} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        {ICONS[variant]}
      </svg>
      <div className={styles.body}>
        {title && <p className={styles.title}>{title}</p>}
        <div className={styles.message}>{children}</div>
      </div>
      {onDismiss && (
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
