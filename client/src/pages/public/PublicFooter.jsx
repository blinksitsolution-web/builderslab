import styles from "./PublicSections.module.css";

const FALLBACK_CAMPUSES = ["Woodbridge International School", "Morning Glory International School"];

export default function PublicFooter({ logoSrc, footer, campuses }) {
  const campusNames = campuses && campuses.length ? campuses.map((c) => c.name) : FALLBACK_CAMPUSES;

  return (
    <footer style={{ background: "var(--color-primary-900)", color: "rgba(255,255,255,0.8)", paddingTop: "var(--space-12)" }}>
      <div className={styles.container} style={{ display: "grid", gap: "var(--space-8)" }}>
        <div className="grid-3">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
              <img src={logoSrc} alt="Dalijay Tech Hub logo" style={{ width: 40, height: 40, borderRadius: "var(--radius-md)", objectFit: "cover" }} />
              <div style={{ fontFamily: "var(--font-display)", fontWeight: "var(--font-weight-semibold)", color: "var(--text-on-primary)" }}>
                Builders&rsquo; Lab
                <small style={{ display: "block", fontFamily: "var(--font-body)", fontWeight: "var(--font-weight-regular)", fontSize: "var(--font-size-xs)" }}>Dalijay Tech Hub</small>
              </div>
            </div>
            <p style={{ maxWidth: 280, fontSize: "var(--font-size-sm)" }}>
              {footer?.tagline || "Training kids and adults in STEM, Robotics, IoT, Web Development and Graphic Design — hosted inside partner school campuses across Takoradi."}
            </p>
          </div>
          <div>
            <h4 style={{ color: "var(--text-on-primary)" }}>Our Campuses</h4>
            {campusNames.map((n) => (
              <p key={n} style={{ fontSize: "var(--font-size-sm)", margin: "0 0 var(--space-1)" }}>
                {n}
              </p>
            ))}
          </div>
          <div>
            <h4 style={{ color: "var(--text-on-primary)" }}>Contact Us</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", fontSize: "var(--font-size-sm)" }}>
              <a href="mailto:info@dalijaytechhub.online">info@dalijaytechhub.online</a>
              <a href="https://www.dalijaytechhub.online">www.dalijaytechhub.online</a>
            </div>
          </div>
        </div>
        <div
          style={{ borderTop: "1px solid rgba(255,255,255,0.12)", padding: "var(--space-4) 0", textAlign: "center", fontSize: "var(--font-size-xs)" }}
          dangerouslySetInnerHTML={{ __html: footer?.copyrightText || "All rights reserved &copy; 2026 Dalijay Tech Hub" }}
        />
      </div>
    </footer>
  );
}
