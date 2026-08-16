import Reveal from "./Reveal";
import styles from "./PublicSections.module.css";

const FALLBACK_STEPS = [
  { icon: "01", title: "Register & pay registration fee", description: "Create a learner + parent account and pay securely via Mobile Money." },
  { icon: "02", title: "Learn on campus, revise online", description: "Lessons run inside your school's ICT lab; every video, slide and PDF is also on the portal." },
  { icon: "03", title: "Watch, quiz, build", description: "Each lesson unlocks the next only after it's watched in full and its quiz is passed." },
  { icon: "04", title: "Submit projects for grading", description: "Upload photos or clips of finished builds — instructors grade and give feedback." },
  { icon: "05", title: "Pay monthly, stay enrolled", description: "After registration, a simple monthly Mobile Money charge keeps access active." },
  { icon: "06", title: "Receive your transcript", description: "Midterm and end-of-term transcripts — with your star rating — are generated automatically." },
];

export default function PathwaySection({ home, howItWorks }) {
  const steps = howItWorks?.length ? howItWorks : FALLBACK_STEPS;

  return (
    <section id="pathway" className={styles.section}>
      <div className={styles.container}>
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div>
            <Reveal>
              <span className={styles.eyebrow}>{home?.howItWorksEyebrow || "// How enrolment works"}</span>
              <h2 style={{ marginBottom: "var(--space-5)" }}>{home?.howItWorksTitle || "From sign-up to certificate"}</h2>
            </Reveal>
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
              {steps.map((s, i) => (
                <Reveal as="li" key={i} delay={i * 90} className={styles.pathwayStep} style={{ display: "flex", gap: "var(--space-4)" }}>
                  <span
                    className={styles.pathwayStepNum}
                    style={{
                      flex: "none",
                      fontFamily: "var(--font-mono)",
                      fontWeight: "var(--font-weight-semibold)",
                      color: "var(--color-secondary-600)",
                    }}
                  >
                    {s.icon || String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <strong>{s.title}</strong>
                    <p className="text-body" style={{ margin: 0 }}>
                      {s.description}
                    </p>
                  </div>
                </Reveal>
              ))}
            </ol>
          </div>

          <Reveal delay={150} className={styles.pathwayImage} style={{ background: "var(--color-primary-800)", borderRadius: "var(--radius-lg)", overflow: "hidden", lineHeight: 0 }}>
            <img
              src={home?.howItWorksImagePath || "/images/stem-robotics-illustration.svg"}
              alt="African children learning and building robotics/STEM projects together"
              style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }}
            />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
