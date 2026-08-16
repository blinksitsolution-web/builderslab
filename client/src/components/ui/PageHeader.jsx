import styles from "./PageHeader.module.css";

/**
 * @param {string} title
 * @param {string} [description]
 * @param {React.ReactNode} [breadcrumbs] - a <Breadcrumbs/> element
 * @param {React.ReactNode} [actions] - primary/secondary page-level actions
 */
export default function PageHeader({ title, description, breadcrumbs, actions }) {
  return (
    <header className={styles.header}>
      {breadcrumbs}
      <div className={styles.row}>
        <div>
          <h1 className={styles.title}>{title}</h1>
          {description && <p className={styles.description}>{description}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </header>
  );
}
