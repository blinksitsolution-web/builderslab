import { Card, Badge } from "../../components/ui";
import SectionHead from "./SectionHead";
import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

export default function ModulesSection({ modules }) {
  return (
    <section id="modules" className={[styles.section, styles.sectionAlt].join(" ")}>
      <div className={styles.container}>
        <SectionHead
          eyebrow="Course curriculum"
          title="What's inside the Builders' Lab Courses"
          description="Each Builders' Lab Course is built from a sequence of hands-on modules — Hardware & Software, then Programming, then IoT & Robotics, then Graphic Design, with AI Essentials and Web Development as electives. Only modules currently &ldquo;in season&rdquo; are open for new enrolment."
        />
        {!modules && <p className="text-helper" style={{ textAlign: "center" }}>Loading modules&hellip;</p>}
        {modules && (
          <div className="grid-3">
            {modules.map((m, i) => (
              <Reveal key={m.id} delay={i * 70}>
                <Card padding className={styles.hoverLift}>
                  <span className="text-caption">{m.courseGroupName || m.id}</span>
                  {m.isOpen && (
                    <span style={{ marginLeft: "var(--space-2)" }}>
                      <Badge tone="success">Enrolling now</Badge>
                    </span>
                  )}
                  <h3 style={{ marginTop: "var(--space-2)" }}>{m.title}</h3>
                  <p className="text-body">{m.blurb || ""}</p>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-xs)", color: "var(--text-muted)" }}>
                    <span>Ages {m.ages || "—"}</span>
                    <span>{m.weeks || "—"} weeks</span>
                  </div>
                </Card>
              </Reveal>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
