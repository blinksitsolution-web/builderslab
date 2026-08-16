import Spinner from "./Spinner";
import styles from "./LoadingState.module.css";

/** Section/page-level loading indicator. For a button's own loading state, use Button's `loading` prop instead. */
export default function LoadingState({ label = "Loading…" }) {
  return (
    <div className={styles.wrap} role="status">
      <Spinner size="lg" />
      <p className={styles.label}>{label}</p>
    </div>
  );
}
