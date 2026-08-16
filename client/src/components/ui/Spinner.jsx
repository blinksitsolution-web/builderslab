import styles from "./Spinner.module.css";

/** @param {"sm"|"md"|"lg"} [size] */
export default function Spinner({ size = "md", className = "", ...rest }) {
  return (
    <svg
      className={[styles.spinner, styles[size], className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      role="status"
      aria-label="Loading"
      {...rest}
    >
      <circle className={styles.track} cx="12" cy="12" r="10" fill="none" strokeWidth="3" />
      <circle className={styles.head} cx="12" cy="12" r="10" fill="none" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
