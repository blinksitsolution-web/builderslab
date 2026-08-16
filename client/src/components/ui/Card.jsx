import styles from "./Card.module.css";

/** @param {"flat"|"raised"} [variant] */
export default function Card({ variant = "raised", padding = true, className = "", children, ...rest }) {
  return (
    <div className={[styles.card, styles[variant], padding ? styles.padded : "", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions, className = "" }) {
  return (
    <div className={[styles.header, className].filter(Boolean).join(" ")}>
      <div>
        <h3 className={styles.title}>{title}</h3>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}

export function CardFooter({ className = "", children }) {
  return <div className={[styles.footer, className].filter(Boolean).join(" ")}>{children}</div>;
}
