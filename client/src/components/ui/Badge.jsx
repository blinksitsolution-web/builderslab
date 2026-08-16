import styles from "./Badge.module.css";

/** @param {"neutral"|"success"|"warning"|"danger"|"info"|"brand"} [tone] */
export default function Badge({ tone = "neutral", className = "", children }) {
  return <span className={[styles.badge, styles[tone], className].filter(Boolean).join(" ")}>{children}</span>;
}
