import { Card } from "../../components/ui";
import SectionHead from "./SectionHead";
import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

/** Renders nothing when there are no CMS-provided stories — no invented testimonials. */
export default function StoriesSection({ stories, home }) {
  if (!stories || stories.length === 0) return null;

  return (
    <section id="stories" className={styles.section}>
      <div className={styles.container}>
        <SectionHead eyebrow={home?.storiesEyebrow || "// Our success stories"} title={home?.storiesTitle || "Discover our impact journey"} />
        <div className="grid-3">
          {stories.map((s, i) => {
            const initials = s.name
              .split(" ")
              .map((w) => w[0])
              .slice(0, 2)
              .join("");
            return (
              <Reveal key={i} delay={i * 80}>
                <Card padding className={styles.hoverLift} style={s.highlighted ? { borderColor: "var(--color-secondary-300)" } : undefined}>
                  <p className="text-body" style={{ fontStyle: "italic" }}>
                    &ldquo;{s.quote}&rdquo;
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
                    {s.avatar_path ? (
                      <img src={s.avatar_path} alt="" style={{ width: 40, height: 40, borderRadius: "var(--radius-full)", objectFit: "cover" }} />
                    ) : (
                      <span
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: "var(--radius-full)",
                          background: "var(--color-primary-100)",
                          color: "var(--color-primary-700)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: "var(--font-weight-semibold)",
                          flex: "none",
                        }}
                      >
                        {initials}
                      </span>
                    )}
                    <div>
                      <strong style={{ display: "block" }}>{s.name}</strong>
                      <span className="text-helper">{s.role || ""}</span>
                    </div>
                  </div>
                </Card>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
