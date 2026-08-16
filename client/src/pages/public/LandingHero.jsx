import styles from "./LandingHero.module.css";

/**
 * Built as its own component rather than the shared <Hero/> because the
 * legacy hero's second column is a live "modules open now" status panel,
 * not a photograph — <Hero/>'s image-or-nothing slot doesn't fit that.
 * This reuses the same visual language (blueprint-grid texture, navy
 * gradient, copper eyebrow, the same tokens) established by
 * components/hero/Hero.jsx in Phase 3, applied to what this page actually
 * needs, matching how AuthLayout (Phase 4) already adapted the same
 * pattern for its own second-column contract.
 */
export default function LandingHero({ eyebrow, title, lead, enrolHref, moduleCount, campusCount, modules }) {
  return (
    <section className={styles.hero}>
      <div className={styles.pattern} aria-hidden="true" />
      <div className={styles.inner}>
        <div className={styles.content}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1 className={styles.title} dangerouslySetInnerHTML={{ __html: title }} />
          <p className={styles.lead} dangerouslySetInnerHTML={{ __html: lead }} />
          <div className={styles.actions}>
            <a href={enrolHref} className={styles.primaryCta}>
              Enrol a learner
            </a>
            <a href="#pathway" className={styles.secondaryCta}>
              See how it works <span className={styles.secondaryCtaArrow} aria-hidden="true">→</span>
            </a>
          </div>
          <div className={styles.stats}>
            <div className={styles.statCell} style={{ animationDelay: "80ms" }}>
              <span className={styles.statNum}>6+</span>
              <span className={styles.statLbl}>Starting age</span>
            </div>
            <div className={styles.statCell} style={{ animationDelay: "160ms" }}>
              <span className={styles.statNum}>{moduleCount}</span>
              <span className={styles.statLbl}>Builder modules</span>
            </div>
            <div className={styles.statCell} style={{ animationDelay: "240ms" }}>
              <span className={styles.statNum}>{campusCount}</span>
              <span className={styles.statLbl}>Partner campuses</span>
            </div>
          </div>
        </div>

        <div className={styles.panel}>
          {!modules && <div className={styles.row}>Loading modules&hellip;</div>}
          {modules &&
            modules.map((m, i) => (
              <div key={m.id} className={styles.row} style={{ animationDelay: `${300 + i * 60}ms` }}>
                <span>
                  <span className={[styles.dot, m.isOpen ? styles.dotOpen : styles.dotClosed].join(" ")} aria-hidden="true" />
                  {m.title}
                </span>
                <span>{m.isOpen ? "Open now" : "Coming up"}</span>
              </div>
            ))}
        </div>
      </div>

      <a href="#about" className={styles.scrollCue} aria-label="Scroll to learn more">
        <span aria-hidden="true" />
      </a>
    </section>
  );
}
