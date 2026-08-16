import { useState } from "react";
import styles from "./Hero.module.css";

/**
 * Reusable hero/entry pattern — establishes the layout now for later use
 * on the login screen, learner dashboard welcome banner, or a learning
 * area's entry point. Not wired into any real page yet (Phase 3 scope).
 *
 * Deliberately resilient to missing imagery: if `imageSrc` is omitted or
 * fails to load, it falls back to the brand's blueprint-grid pattern
 * rather than an empty/broken box — "no decorative images merely to fill
 * space" also means never leaving a visibly broken one.
 *
 * @param {string} eyebrow - small label above the heading (e.g. "Welcome back")
 * @param {string} title
 * @param {string} [description]
 * @param {string} [imageSrc]
 * @param {string} [imageAlt]
 * @param {React.ReactNode} [actions]
 * @param {"left"|"center"} [align]
 */
export default function Hero({ eyebrow, title, description, imageSrc, imageAlt = "", actions, align = "left", children }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = imageSrc && !imageFailed;

  return (
    <section className={[styles.hero, styles[align]].join(" ")}>
      <div className={styles.pattern} aria-hidden="true" />
      <div className={styles.content}>
        {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
        <h1 className={styles.title}>{title}</h1>
        {description && <p className={styles.description}>{description}</p>}
        {actions && <div className={styles.actions}>{actions}</div>}
        {children}
      </div>
      {showImage && (
        <div className={styles.imageWrap}>
          <img src={imageSrc} alt={imageAlt} loading="lazy" className={styles.image} onError={() => setImageFailed(true)} />
          <div className={styles.overlay} aria-hidden="true" />
        </div>
      )}
    </section>
  );
}
