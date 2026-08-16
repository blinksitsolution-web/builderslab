import SectionHead from "./SectionHead";
import styles from "./PublicSections.module.css";

export default function FaqSection({ faqs }) {
  if (!faqs || faqs.length === 0) return null;

  return (
    <section id="faq" className={[styles.section, styles.sectionAlt].join(" ")}>
      <div className={styles.container}>
        <SectionHead eyebrow="// Good to know" title="Frequently asked questions" />
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {faqs.map((f, i) => (
            <details
              key={i}
              style={{ background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}
            >
              <summary style={{ cursor: "pointer", fontWeight: "var(--font-weight-semibold)" }}>{f.question}</summary>
              <p className="text-body" style={{ marginTop: "var(--space-3)", marginBottom: 0 }}>
                {f.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
