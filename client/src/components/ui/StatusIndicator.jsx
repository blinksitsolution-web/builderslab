import styles from "./StatusIndicator.module.css";

/**
 * Small dot + label, distinct from Badge (which is a pill for general
 * tagging) — this is specifically for on/off, live-state style status
 * (account active/suspended/pending, payment paid/unpaid, online/offline).
 * @param {"positive"|"neutral"|"caution"|"critical"} [tone]
 */
export default function StatusIndicator({ tone = "neutral", children }) {
  return (
    <span className={styles.wrap}>
      <span className={[styles.dot, styles[tone]].join(" ")} aria-hidden="true" />
      <span className={styles.label}>{children}</span>
    </span>
  );
}
