import Button from "./Button";
import styles from "./StateBlock.module.css";

/**
 * @param {string} title
 * @param {string} [description]
 * @param {{ label: string, onClick: () => void }} [action] - a useful next step, when there is one
 */
export default function EmptyState({ title, description, action, icon }) {
  return (
    <div className={styles.wrap}>
      <span className={styles.icon}>
        {icon || (
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" fill="none" />
            <path d="M8 10h8M8 14h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        )}
      </span>
      <h3 className={styles.title}>{title}</h3>
      {description && <p className={styles.description}>{description}</p>}
      {action && (
        <div className={styles.action}>
          <Button variant="secondary" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
