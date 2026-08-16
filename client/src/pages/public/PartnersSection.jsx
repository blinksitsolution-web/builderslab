import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

export default function PartnersSection({ partners }) {
  if (!partners || partners.length === 0) return null;

  return (
    <section className={styles.section} style={{ paddingTop: "var(--space-8)", paddingBottom: "var(--space-8)" }}>
      <div className={styles.container} style={{ display: "flex", gap: "var(--space-10)", justifyContent: "center", flexWrap: "wrap", alignItems: "center" }}>
        {partners.map((p, i) => (
          <Reveal key={i} delay={(i % 6) * 50} style={{ display: "flex" }}>
            {p.logo_path ? (
              <a href={p.url || "#"} target="_blank" rel="noopener">
                <img src={p.logo_path} alt={p.name} className={styles.partnerLogo} />
              </a>
            ) : (
              <span className="text-caption">{p.name}</span>
            )}
          </Reveal>
        ))}
      </div>
    </section>
  );
}
