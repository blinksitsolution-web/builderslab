import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

export default function SectionHead({ eyebrow, title, description }) {
  return (
    <Reveal className={styles.sectionHead}>
      {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
      <h2 className={styles.sectionTitle}>{title}</h2>
      {description && <p className={styles.sectionDescription}>{description}</p>}
    </Reveal>
  );
}
