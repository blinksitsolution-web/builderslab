import { Card } from "../../components/ui";
import SectionHead from "./SectionHead";
import styles from "./PublicSections.module.css";
import { asUrl, asWhatsappLink, asTelLink } from "./publicUtils";

/**
 * Fallback hrefs of "#" for social links intentionally match legacy
 * index.html's own static markup — those are genuine placeholders in the
 * current site (no real social URLs configured yet), not something this
 * migration should invent.
 */
export default function ContactSection({ contact, campuses }) {
  const facebook = contact?.facebook ? { label: `${contact.facebook} — Facebook`, href: asUrl(contact.facebook) } : { label: "Dalijay Tech Hub — Facebook", href: "#" };
  const tiktok = contact?.tiktok ? { label: `${contact.tiktok} — TikTok`, href: asUrl(contact.tiktok) } : { label: "DalijayTech_Hub — TikTok", href: "#" };
  const whatsapp = contact?.whatsapp
    ? { label: `${contact.whatsapp} — WhatsApp`, href: asWhatsappLink(contact.whatsapp) }
    : { label: "(+233) 560 640 517 — WhatsApp", href: "#" };
  const phone = contact?.phone ? { label: contact.phone, href: asTelLink(contact.phone) } : { label: "(+233) 542 947 685", href: "#" };
  const email = contact?.email || "info@dalijaytechhub.online";

  const campusesWithContact = (campuses || []).filter((c) => c.contact_phone || c.contact_email || c.location);

  return (
    <section id="contact" className={styles.section}>
      <div className={styles.container}>
        <SectionHead eyebrow="// Get in touch" title="Contact us" />
        <div className="grid-2">
          <Card padding>
            <h4 style={{ marginTop: 0 }}>General enquiries</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <a href={facebook.href}>{facebook.label}</a>
              <a href={tiktok.href}>{tiktok.label}</a>
              <a href={whatsapp.href}>{whatsapp.label}</a>
              <a href={phone.href}>{phone.label}</a>
              <a href={`mailto:${email}`}>{email}</a>
            </div>
          </Card>
          <Card padding>
            <h4 style={{ marginTop: 0 }}>Campus contacts</h4>
            {!campuses && <p className="text-helper">Loading campus contacts&hellip;</p>}
            {campuses && campusesWithContact.length === 0 && <p className="text-helper">Reach us at any campus via the details above.</p>}
            {campuses && campusesWithContact.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
                {campusesWithContact.map((c) => (
                  <div key={c.id}>
                    <strong style={{ display: "block", color: "var(--color-primary-800)" }}>{c.name}</strong>
                    {c.location && <span className="text-helper" style={{ display: "block" }}>{c.location}</span>}
                    {c.contact_phone && (
                      <a href={`tel:${c.contact_phone}`} style={{ display: "block" }}>
                        {c.contact_phone}
                      </a>
                    )}
                    {c.contact_email && (
                      <a href={`mailto:${c.contact_email}`} style={{ display: "block" }}>
                        {c.contact_email}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
}
