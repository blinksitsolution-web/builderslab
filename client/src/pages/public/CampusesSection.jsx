import { Card } from "../../components/ui";
import SectionHead from "./SectionHead";
import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

export default function CampusesSection({ campuses, offerings, home }) {
  const offeringById = {};
  (offerings || []).forEach((o) => {
    offeringById[o.id] = o;
  });

  return (
    <section id="campuses" className={[styles.section, styles.sectionAlt].join(" ")}>
      <div className={styles.container}>
        <SectionHead
          eyebrow={home?.campusesEyebrow || "// Where we build"}
          title={home?.campusesTitle || "Our partner campuses"}
          description={home?.campusesBody || "The Builders' Lab runs directly inside our partner schools' ICT labs — talk to us about hosting a Builders' Lab at your school."}
        />
        {!campuses && <p className="text-helper" style={{ textAlign: "center" }}>Loading campuses&hellip;</p>}
        {campuses && campuses.length > 0 && (
          <div className="grid-2">
            {campuses.map((c, i) => {
              const offeringNames = (c.offeringTypeIds || []).map((id) => offeringById[id]?.name).filter(Boolean);
              return (
                <Reveal key={c.id} delay={i * 80}>
                  <Card padding className={styles.hoverLift}>
                    {c.image_path && (
                      <img src={c.image_path} alt="" loading="lazy" style={{ width: "100%", height: 160, objectFit: "cover", borderRadius: "var(--radius-md)", marginBottom: "var(--space-3)" }} />
                    )}
                    <h3>{c.name}</h3>
                    <p className="text-body">{c.location || "Ask us about session times and open tracks at this campus."}</p>
                    {c.partner_school_name && (
                      <p className="text-body">
                        <strong>Partner school:</strong> {c.partner_school_name}
                      </p>
                    )}
                    {offeringNames.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                        {offeringNames.map((n) => (
                          <span key={n} className="text-caption">
                            {n}
                          </span>
                        ))}
                      </div>
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
