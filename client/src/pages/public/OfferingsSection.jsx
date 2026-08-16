import { Card, Badge } from "../../components/ui";
import SectionHead from "./SectionHead";
import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";
import { resolveEnrolDestination } from "./publicUtils";

export default function OfferingsSection({ offerings, home }) {
  return (
    <section id="offerings" className={styles.section}>
      <div className={styles.container}>
        <SectionHead eyebrow={home?.offeringsEyebrow || "// What we offer"} title={home?.offeringsTitle || "Our Learning Offerings"} />

        {!offerings && <p className="text-helper" style={{ textAlign: "center" }}>Loading learning offerings&hellip;</p>}
        {offerings && offerings.length === 0 && (
          <p className="text-helper" style={{ textAlign: "center" }}>
            Learning offerings coming soon.
          </p>
        )}
        {offerings && offerings.length > 0 && (
          <div className="grid-3">
            {offerings.map((o, i) => {
              const dest = resolveEnrolDestination(o);
              const target = o.enrolOpenBehavior === "new_tab" ? { target: "_blank", rel: "noopener" } : {};
              return (
                <Reveal key={o.id} delay={i * 70}>
                  <Card padding className={styles.hoverLift}>
                    {o.featureLevel === "featured" && (
                      <div style={{ marginBottom: "var(--space-2)" }}>
                        <Badge tone="brand">Featured</Badge>
                      </div>
                    )}
                    {o.imagePath ? (
                      <img src={o.imagePath} alt="" loading="lazy" style={{ width: "100%", height: 120, objectFit: "cover", borderRadius: "var(--radius-md)", marginBottom: "var(--space-3)" }} />
                    ) : (
                      <span className="text-caption">{o.icon || "★"}</span>
                    )}
                    <h3 style={{ marginTop: "var(--space-2)" }}>{o.name}</h3>
                    <p className="text-body">{o.tagline || o.landingDescription || o.description || ""}</p>
                    {o.features?.length > 0 && (
                      <ul style={{ paddingLeft: "1.1em", margin: "0 0 var(--space-3)" }}>
                        {o.features.map((f, i) => (
                          <li key={i} className="text-body" style={{ marginBottom: "var(--space-1)" }}>
                            {f}
                          </li>
                        ))}
                      </ul>
                    )}
                    {o.enrolVisible !== false && (
                      <a href={dest} {...target} className={[styles.linkButton, styles.linkButtonSecondary].join(" ")}>
                        {o.enrolButtonText || "Enrol now"}
                      </a>
                    )}
                  </Card>
                </Reveal>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
