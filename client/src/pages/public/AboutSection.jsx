import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

const FALLBACK = {
  eyebrow: "// Who we are",
  title: "About Dalijay Tech Hub",
  body: "Dalijay Tech Hub runs The Builders' Lab — hands-on STEM, Robotics, IoT, Web Development and Graphic Design training delivered inside partner school ICT labs across Ghana, for kids and adults alike.",
};

export default function AboutSection({ about }) {
  const eyebrow = about?.eyebrow || FALLBACK.eyebrow;
  const title = about?.title || FALLBACK.title;
  const body = about?.body || FALLBACK.body;
  const imageSrc = about?.imagePath || "/images/a.jpg";

  return (
    <section id="about" className={styles.section}>
      <div className={styles.container} style={{ display: "grid", gap: "var(--space-8)", alignItems: "center" }}>
        <div className="grid-2" style={{ alignItems: "center" }}>
          <Reveal>
            <span className={styles.eyebrow}>{eyebrow}</span>
            <h2 style={{ marginBottom: "var(--space-3)" }}>{title}</h2>
            <p className="text-body">{body}</p>
          </Reveal>
          <Reveal delay={120}>
            <img
              src={imageSrc}
              alt="A mentor guiding learners through a robotics build"
              loading="lazy"
              className={styles.aboutImage}
              style={{ width: "100%", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-md)", objectFit: "cover", maxHeight: 360 }}
            />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
