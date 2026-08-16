import Button from "./Button";
import styles from "./StateBlock.module.css";

/**
 * @param {string} [title]
 * @param {string} [description] - a plain-language explanation, not a raw stack trace / error code
 * @param {{ label: string, onClick: () => void }} [action] - typically "Try again"
 */
export default function ErrorState({ title = "Something went wrong", description = "We couldn't load this. Please try again.", action }) {
  return (
    <div className={styles.wrap}>
      <span className={[styles.icon, styles.danger].join(" ")}>
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" fill="none" />
          <path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.description}>{description}</p>
      {action && (
        <div className={styles.action}>
          <Button variant="primary" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
