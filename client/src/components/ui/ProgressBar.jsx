import styles from "./ProgressBar.module.css";

/**
 * @param {number} value - 0-100
 * @param {"brand"|"success"} [tone]
 * @param {string} [label] - accessible label (e.g. "Module progress")
 */
export default function ProgressBar({ value, tone = "brand", label = "Progress" }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={styles.track} role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={[styles.fill, styles[tone]].join(" ")} style={{ width: `${pct}%` }} />
    </div>
  );
}
