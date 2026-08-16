/* ==========================================================================
   Minimal country list for registration's Country field.

   The only country this platform has ever actually supported payment for
   is Ghana — this list exists so an international learner can identify
   where they're registering from, not to imply every listed country has
   a working payment path yet (see RegisterPage's payment-boundary notice
   for non-Ghana registrants).

   Deliberately a short, curated list rather than a full ~250-country ISO
   3166-1 table or a library dependency — small enough to hand-maintain,
   big enough to cover Ghana plus the countries most likely to actually
   show up (West Africa, other frequent diaspora/remote-learner origins),
   with a generic "Other" fallback for everyone else. Every code here is a
   real ISO 3166-1 alpha-2 code except "OT" ("Other"), a deliberate
   placeholder for "not in this short list" — still exactly two letters,
   so it passes the same server-side shape check as a real code, and still
   correctly routes through the non-Ghana / international-contact path.
   ========================================================================== */

export const DEFAULT_COUNTRY = "GH";

export const COUNTRIES = [
  { code: "GH", name: "Ghana" },
  { code: "NG", name: "Nigeria" },
  { code: "CI", name: "Côte d'Ivoire" },
  { code: "TG", name: "Togo" },
  { code: "BJ", name: "Benin" },
  { code: "SN", name: "Senegal" },
  { code: "KE", name: "Kenya" },
  { code: "ZA", name: "South Africa" },
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "DE", name: "Germany" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "OT", name: "Other" },
];

export function countryName(code) {
  const match = COUNTRIES.find((c) => c.code === code);
  return match ? match.name : code;
}
