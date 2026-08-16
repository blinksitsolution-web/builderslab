import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

export default function CtaBand({ home, enrolHref }) {
  return (
    <section className={styles.section}>
      <div className={styles.container}>
        <Reveal className={styles.ctaBand}>
          <h2 style={{ color: "var(--text-on-primary)", marginBottom: "var(--space-3)" }}>{home?.ctaTitle || "Ready to build the future?"}</h2>
          <p style={{ color: "rgba(255,255,255,0.85)", maxWidth: "50ch", margin: "0 auto var(--space-6)" }}>
            {home?.ctaBody || "Registration takes five minutes and payment is by Mobile Money — no bank visit required."}
          </p>
          <a href={enrolHref} className={styles.ctaButton}>
            Enrol a learner now
          </a>
        </Reveal>
      </div>
    </section>
  );
}
