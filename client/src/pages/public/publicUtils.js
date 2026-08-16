/**
 * Faithful ports of the small helper functions in legacy index.html's
 * inline <script> (see Phase 9 analysis) — same logic, same fallback
 * destinations, nothing reinterpreted.
 */

// Resolves where a Learning Offering's Enrol button should go. An admin
// override (enrolDestination) always wins; otherwise every offering type
// falls back to the standard self-service registration route. Group 1 of
// the final non-admin migration replaced the legacy register.html
// destination with the React registration route (/app/register), same
// ?offeringTypeSlug= deep-link param RegisterPage reads (see
// routing/AppRoutes.jsx, pages/auth/RegisterPage.jsx).
//
// ABRS v2.1 Phase 4 (Category 2 audit fix): this used to also hardcode
// `offering.slug === "corporate_training"` -> "#contact" here. That's now
// just Corporate Training's own seeded default value for the
// already-generic enrolDestination field (see migrate.js's v36 comment) —
// this function no longer needs to know any offering type's identity at
// all, only whether an enrolDestination has been configured.
export function resolveEnrolDestination(offering) {
  if (offering && offering.enrolDestination) return offering.enrolDestination;
  return offering && offering.slug ? `/app/register?offeringTypeSlug=${encodeURIComponent(offering.slug)}` : "/app/register";
}

// A bare handle/URL typed into the CMS (e.g. "facebook.com/DalijayTechHub")
// is normalized to a full https:// URL; a value that's already a full URL
// is left as-is.
export function asUrl(v) {
  return /^https?:\/\//i.test(v) ? v : "https://" + String(v).replace(/^\/+/, "");
}

// wa.me needs a bare international number with no leading 0/+/spaces;
// Ghana numbers are stored locally (e.g. "0560640517") so the leading 0
// is swapped for the country code.
export function asWhatsappLink(v) {
  const digits = String(v).replace(/[^\d]/g, "");
  const intl = digits.replace(/^0/, "233");
  return "https://wa.me/" + intl;
}

export function asTelLink(v) {
  return "tel:" + String(v).replace(/[^\d+]/g, "");
}
