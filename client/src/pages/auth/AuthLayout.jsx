import styles from "./AuthLayout.module.css";

/**
 * Reuses the Hero pattern's visual language (blueprint-grid texture on a
 * navy gradient, copper eyebrow accent — see components/hero/Hero.jsx)
 * for a dedicated split auth layout: a branded panel plus a centered form
 * card. Built as its own component rather than literally wrapping <Hero/>
 * because a login screen's second column needs to hold the form, not an
 * (optional, often absent) photograph — the same brand pattern, applied
 * to what an auth screen actually needs.
 */
export default function AuthLayout({ eyebrow, title, description, children }) {
  return (
    <div className={styles.page}>
      <aside className={styles.branding}>
        <div className={styles.pattern} aria-hidden="true" />
        <div className={styles.brandingContent}>
          {/* Links back to the public site — there used to be no way back
             to the landing page from the login/register/forgot-password
             flow at all (see also Sidebar.jsx/Topbar.jsx for the
             signed-in-portal side of the same fix). */}
          <a href="/" className={styles.brandMark}>
            <span className={styles.mark} aria-hidden="true">
              BL
            </span>
            <span className={styles.wordmark}>The Builders&rsquo; Lab</span>
          </a>
          {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
          <h1 className={styles.title}>{title}</h1>
          {description && <p className={styles.description}>{description}</p>}
        </div>
      </aside>
      <main className={styles.formPanel}>
        <div className={styles.formPanelInner}>
          <a href="/" className={styles.backLink}>
            ← Back to website
          </a>
          {children}
        </div>
      </main>
    </div>
  );
}
