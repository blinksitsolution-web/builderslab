import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

const FALLBACK = [
  { b: "100%", label: "Hands-on curriculum" },
  { b: "Mobile Money", label: "Pay in minutes" },
  { b: "Parent portal", label: "Track progress live" },
  { b: "School-hosted", label: "No extra commute" },
];

export default function StatStrip({ home }) {
  const cmsCells = [home?.statStripLeft, home?.statStripSecond, home?.statStripThird, home?.statStripFourth].filter(Boolean);
  const cells = cmsCells.length
    ? cmsCells.map((cell) => {
        const [b, ...rest] = String(cell).split(" — ");
        return { b, label: rest.join(" — ") };
      })
    : FALLBACK;

  return (
    <div className={styles.statStrip}>
      {cells.map((c, i) => (
        <Reveal key={i} delay={i * 90}>
          <div className={styles.statCell}>
            <b>{c.b}</b>
            <span>{c.label}</span>
          </div>
        </Reveal>
      ))}
    </div>
  );
}
