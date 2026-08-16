import { Card, Badge } from "../../components/ui";
import SectionHead from "./SectionHead";
import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

export default function NewsSection({ blog, home }) {
  return (
    <section id="news" className={styles.section}>
      <div className={styles.container}>
        <SectionHead eyebrow={home?.newsEyebrow || "// From the Hub"} title={home?.newsTitle || "News & updates"} />
        {(!blog || blog.length === 0) && (
          <p className="text-helper" style={{ textAlign: "center" }}>
            No news posted yet — check back soon.
          </p>
        )}
        {blog && blog.length > 0 && (
          <div className="grid-3">
            {blog.map((p, i) => (
              <Reveal key={i} delay={i * 70}>
                <Card padding className={styles.hoverLift}>
                  {p.featured && (
                    <div style={{ marginBottom: "var(--space-2)" }}>
                      <Badge tone="brand">Featured</Badge>
                    </div>
                  )}
                  {p.cover_path && (
                    <img src={p.cover_path} alt="" loading="lazy" style={{ width: "100%", height: 140, objectFit: "cover", borderRadius: "var(--radius-md)", marginBottom: "var(--space-3)" }} />
                  )}
                  {p.category && <span className="text-caption">{p.category}</span>}
                  <h3 style={{ marginTop: "var(--space-2)" }}>{p.title}</h3>
                  <p className="text-body" style={{ whiteSpace: "pre-line" }}>
                    {p.body || ""}
                  </p>
                  {p.video_url && (
                    <a href={p.video_url} target="_blank" rel="noopener" className="text-helper">
                      ▶ Watch video
                    </a>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--space-3)", fontSize: "var(--font-size-xs)", color: "var(--text-muted)" }}>
                    <span>{(p.date || "").slice(0, 10)}</span>
                    <span>{p.author || ""}</span>
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
