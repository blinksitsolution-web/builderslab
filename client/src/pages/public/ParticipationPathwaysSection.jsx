import { Card, Badge } from "../../components/ui";
import SectionHead from "./SectionHead";
import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

// Static, deliberately generic copy — per the spec, the landing page
// explains the programme and its pathways, while the actual currently
// active Learning Instances / Courses / delivery modes / fees only ever
// show up in the registration flow, where they can't go stale or
// conflict with what's really configured in Admin.
const PATHWAYS = [
  {
    tag: "School Club",
    title: "Structured Builders' Lab Journey",
    description:
      "A continuing journey through Foundation, Framework and Skyline, delivered as a Builders' Lab club inside your school. One account carries the learner through every promotion — no re-registering, no starting over.",
  },
  {
    tag: "Elsewhere",
    title: "Structured Journey, Another Way",
    description:
      "The same Foundation → Framework → Skyline journey, followed outside a school club — online, on-campus, or hybrid, wherever it's currently available.",
  },
  {
    tag: "One Course",
    title: "Individual Builders' Lab Course",
    description:
      "Enrol in a single Builders' Lab course for a defined term, without joining the full structured journey — a focused way to try one subject at a time.",
  },
];

const LEVELS = ["Foundation", "Framework", "Skyline"];

export default function ParticipationPathwaysSection({ home }) {
  return (
    <section id="pathways" className={styles.section}>
      <div className={styles.container}>
        <SectionHead
          eyebrow={home?.pathwaysEyebrow || "// Three ways to build with us"}
          title={home?.pathwaysTitle || "One programme. Choose how you join it."}
        />
        <p className="text-body" style={{ textAlign: "center", maxWidth: 640, margin: "0 auto var(--space-6)" }}>
          Builders' Lab is one programme with several ways to participate — each with its own registration, fees and
          pace. Actual availability, delivery modes and fees depend on what's currently open; you'll see the specifics
          when you register.
        </p>

        <div className="grid-3">
          {PATHWAYS.map((p, i) => (
            <Reveal key={p.title} delay={i * 80}>
              <Card padding className={styles.hoverLift}>
                <Badge tone="brand">{p.tag}</Badge>
                <h3 style={{ marginTop: "var(--space-2)" }}>{p.title}</h3>
                <p className="text-body">{p.description}</p>
              </Card>
            </Reveal>
          ))}
        </div>

        <div
          style={{
            marginTop: "var(--space-6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexWrap: "wrap",
            gap: "var(--space-3)",
          }}
        >
          {LEVELS.map((level, i) => (
            <span key={level} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: "var(--font-weight-semibold)",
                  padding: "6px 16px",
                  borderRadius: 999,
                  border: "1px solid var(--color-border, #d1d5db)",
                }}
              >
                {level}
              </span>
              {i < LEVELS.length - 1 && <span aria-hidden="true">→</span>}
            </span>
          ))}
        </div>
        <p className="text-helper" style={{ textAlign: "center", marginTop: "var(--space-3)" }}>
          This is the progression for the structured journey. Individual courses are a separate, focused way to join —
          they don't require following this path.
        </p>

        {(home?.deliveryModesNote !== false) && (
          <p className="text-helper" style={{ textAlign: "center", marginTop: "var(--space-2)" }}>
            Where currently available, learning can be delivered Online, On-Campus, or Hybrid.
          </p>
        )}
      </div>
    </section>
  );
}
