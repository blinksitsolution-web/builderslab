import SectionHead from "./SectionHead";
import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

const FALLBACK_IMAGES = [
  { image_path: "/images/arduino.jpg", caption: "Learners wiring an Arduino breadboard circuit" },
  { image_path: "/images/a.jpg", caption: "A mentor guiding learners through a robotics build" },
  { image_path: "/images/ai.jpg", caption: "Learners celebrating a finished circuit project" },
  { image_path: "/images/program.jpg", caption: "A learner working through a coding exercise" },
];

export default function GallerySection({ gallery }) {
  const items = gallery && gallery.length ? gallery : FALLBACK_IMAGES;

  return (
    <section id="gallery" className={[styles.section, styles.sectionAlt].join(" ")}>
      <div className={styles.container}>
        <SectionHead eyebrow="// Life at the Lab" title="Gallery" />
        <div className={styles.galleryGrid}>
          {items.map((g, i) => (
            <Reveal key={i} delay={(i % 4) * 60}>
              <figure className={styles.galleryFigure}>
                <img src={g.image_path} alt={g.caption || "Gallery photo"} loading="lazy" />
                {g.caption && <figcaption className={styles.galleryCaption}>{g.caption}</figcaption>}
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
