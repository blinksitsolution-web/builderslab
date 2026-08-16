import { Card } from "../../components/ui";
import styles from "./CertificateCard.module.css";

/**
 * Renders one issued certificate — migrates legacy certAdapt() +
 * certificateHtml() (dashboard.html), same fields (module/course title,
 * learner name, grade, skills, issue date, certificate number,
 * institution branding/signature), restyled with this app's design
 * system instead of the legacy inline-HTML template. Nothing about what
 * data is shown or how a certificate is issued changes — this is a
 * read-only view of the immutable snapshot the backend already returns.
 *
 * Admin's own copy (Phase 26) of the parent portal's identical component
 * (see pages/parent/CertificateCard.jsx, Phase 22) — same presentation,
 * kept as a separate file per this project's existing per-role page
 * organization (no page folder currently imports another role's
 * components) rather than introducing a new shared/ location this phase.
 */
export default function CertificateCard({ certificate }) {
  const d = certificate.data || {};
  const b = certificate.branding || {};
  const moduleTitle = d.module_name || d.course_name || "";
  const learnerName = d.student_name || "";
  const grade = d.grade != null ? d.grade : null;
  const skills = d.skills || "";
  const issued = (certificate.issued_at || "").slice(0, 10);
  const certificateNumber = certificate.certificate_number || "";
  const learningInstanceName = certificate.learningInstance ? certificate.learningInstance.name : null;
  // Phase 10 — same live-resolved academicPeriod metadata Phase 9 added to
  // the certificate GET/list endpoints; null for pre-Phase-9 certificates
  // or a Learning Instance with no academic structure.
  const academicPeriodName = certificate.academicPeriod ? certificate.academicPeriod.name : null;

  // Prefer the org-level signature(s) an admin configures once (Site
  // Settings -> Certificate Settings) over the older per-campus signature
  // — same precedence certAdapt() applies, so certificates for offering
  // types with no campus (Adult Professional, Corporate, Bootcamp) still
  // show a signature.
  const org = b.orgSignatures;
  let signatures = [];
  if (org && Number(org.count) === 2) {
    signatures = [org.signature1, org.signature2].filter(Boolean);
  } else if (org && org.signature1) {
    signatures = [org.signature1];
  } else if (b.adminSignatureName || b.signaturePath) {
    signatures = [{ name: b.adminSignatureName, path: b.signaturePath }];
  }

  // Institution logo (b.logoPath) is mandatory and always resolved from
  // the platform's single authoritative branding config — see
  // server/routes/certificates.js brandingFor(). Partner/Campus logo
  // (b.partner_logo_path) is a separate, optional, campus-owned asset
  // (Site Settings → Campus Branding) that only appears when that campus
  // has one configured — its presence is never a prerequisite for the
  // Institution logo, and vice versa.
  const hasPartnerLogo = !!b.partner_logo_path;

  return (
    <Card className={styles.certificate}>
      {(b.logoPath || hasPartnerLogo) && (
        <div className={styles.logoRow}>
          {b.logoPath && <img src={b.logoPath} alt="" className={styles.logo} />}
          {hasPartnerLogo && <img src={b.partner_logo_path} alt="" className={styles.logo} />}
        </div>
      )}
      <div className={styles.kicker}>The Builders' Lab · Certificate of Completion</div>
      <h2 className={styles.title}>{moduleTitle}</h2>
      <p className={styles.hint}>This certifies that</p>
      <div className={styles.name}>{learnerName}</div>
      <p className={styles.hint}>
        has successfully completed this module{grade != null ? ` with an overall grade of ${grade}%` : ""}.
      </p>
      {skills && <p className={styles.skills}>{skills}</p>}
      {learningInstanceName && (
        <p className={styles.hint}>
          Run: {learningInstanceName}
          {academicPeriodName ? ` — ${academicPeriodName}` : ""}
        </p>
      )}
      <div className={styles.footer}>
        <div>
          <p className={styles.hint}>Issued</p>
          <strong>{issued}</strong>
          {certificateNumber && <p className={styles.certNumber}>{certificateNumber}</p>}
        </div>
        <div className={styles.signatures}>
          {signatures.map((sig, i) => (
            <div key={i} className={styles.signature}>
              {sig.path ? <img src={sig.path} alt="" className={styles.signatureImg} /> : <div className={styles.signatureLine} />}
              <p className={styles.hint}>{sig.name || "Admin"}</p>
              {sig.title && <p className={styles.signatureTitle}>{sig.title}</p>}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
