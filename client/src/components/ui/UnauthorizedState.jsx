import Button from "./Button";
import styles from "./StateBlock.module.css";

/**
 * Purely presentational — for when the server has already returned a
 * 401/403 (or the frontend already knows access is restricted, e.g.
 * `accessRestricted` from PermissionContext) and the UI needs to show
 * that clearly. Does not itself decide who is or isn't authorized.
 *
 * @param {string} [title]
 * @param {string} [description]
 * @param {{ label: string, onClick: () => void }} [action]
 */
export default function UnauthorizedState({
  title = "You don't have access to this",
  description = "Your account doesn't have permission to view this page. If you think this is a mistake, contact your administrator.",
  action,
}) {
  return (
    <div className={styles.wrap}>
      <span className={[styles.icon, styles.warning].join(" ")}>
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" fill="none" />
        </svg>
      </span>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.description}>{description}</p>
      {action && (
        <div className={styles.action}>
          <Button variant="ghost" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
