# Hardcoded Business-Identifier Audit — ABRS v2.1 Phase 1

Source of authority: `ARCHITECTURE_BUSINESS_RULES_SPECIFICATION_v2.1.md`, §2.2
"Configuration Before Code" and Appendix Item A-8.

This is the grep-and-review pass Appendix A-8 calls for, converting that
appendix item from "not yet catalogued" into a concrete, itemized list. It
was produced during Roadmap **Phase 1 — Architecture Alignment** and is
**read-only**: nothing in this document changes runtime behaviour. Every item
below is a candidate for remediation in **Phase 3 (backend)** and
**Phase 4 (frontend)**, once the Programme-owned configuration tables that
should replace these comparisons exist (Phase 2).

Search scope: `server/src/**`, `client/src/**`, for literal comparisons
against `participation_structure` values and Learning Offering Type slugs.
No literal comparisons against Programme names (e.g. `"Builders Lab"`) or
Programme Level names (`"Foundation"`/`"Framework"`/`"Skyline"`) were found —
those two categories are currently clean.

## Category 1 — Duplicated, hardcoded `kids_stem` self-registration override

**Severity: HIGH.** This is the most significant finding: the same
business rule — "Kids STEM must always allow public self-registration,
regardless of what `settings.enrollment.selfRegistrationAllowed` says,
because the flag was introduced after Kids STEM's flagship flow already
existed and must not accidentally gate it" — is implemented independently,
via a hardcoded slug comparison, in **five separate places**. This is a
double violation: it is a Configuration Before Code (§2.2) violation on its
own, and because the same fact is asserted independently in five locations
that could drift out of agreement with each other (and with the `settings`
flag they're overriding), it is also a Single Ownership Principle (§2.1)
violation — there are effectively six competing "owners" of the answer to
"can this offering self-register?" (the settings flag, plus five hardcoded
overrides of it).

| File | Line | Snippet |
|---|---|---|
| `server/src/utils/offeringTypeSettings.js` | 235 | `if (type.slug === "kids_stem") return true;` |
| `server/src/routes/enrolments.js` | 114 | `.filter((t) => t.slug === "kids_stem" \|\| t.settings.enrollment.selfRegistrationAllowed !== false)` |
| `server/src/routes/learningOfferings.js` | 115 | `.filter((t) => t.slug === "kids_stem" \|\| t.settings.enrollment.selfRegistrationAllowed !== false)` |
| `server/src/routes/users.js` | 1017 | `const isKidsStem = !targetOfferingType \|\| targetOfferingType.slug === "kids_stem";` |
| `client/src/pages/auth/RegisterPage.jsx` | 67, 331, 359 | `.find((t) => t.slug === "kids_stem")`, `slug === "kids_stem" && ...`, `const isKidsStem = !!(type && type.slug === "kids_stem");` |

The code's own comments (`offeringTypeSettings.js` lines ~228–234) already
self-identify this as a known workaround, explicitly naming two of the other
locations it must stay in sync with — meaning the team already recognizes
this as fragile before this audit, which is exactly the situation §2.2 exists
to prevent from spreading further.

**Recommended remediation (Phase 2/3):** give `kids_stem`'s
always-self-registrable behaviour a real configuration home — e.g. a
`legacyAlwaysSelfRegistrable` (or similarly named) flag inside the offering
type's own `settings` JSON, defaulted to `true` only for the `kids_stem` row
at seed time — so every caller resolves the same single flag through
`offeringTypeSettings.js` and the slug comparison disappears from all five
locations at once, including the module whose entire purpose is to prevent
this exact pattern.

## Category 2 — Public-site display routing on offering slug

**Severity: LOW.**

| File | Line | Snippet |
|---|---|---|
| `client/src/pages/public/publicUtils.js` | 16 | `if (offering && offering.slug === "corporate_training") return "#contact";` |

This routes Corporate Training's public "Enrol" button to a contact anchor
instead of the registration flow, which matches Corporate Training's
`settings.enrollment.selfRegistrationAllowed: false` configuration (per the
seed defaults in `migrate.js`) — but it re-derives that same fact from the
slug directly instead of reading it from `settings`. Low severity because it
is presentational (a button destination) rather than a security or
data-integrity boundary, but it is the same category of violation and should
be resolved the same way as Category 1: read `selfRegistrationAllowed`
(or a dedicated public-CTA setting) from configuration instead of the slug.

## Category 3 — Participation Structure display-label lookup

**Severity: LOW.**

| File | Line | Snippet |
|---|---|---|
| `client/src/pages/admin/AccountDetailDrawer.jsx` | 22–24 | `if (value === "structured_school_club") return "..."`, etc. (three lines) |

This is a value→display-label mapping for the admin UI, not a business-rule
branch — it doesn't change what happens, only what an admin reads. It is
still, technically, a hardcoded comparison against the current enum's
literal values, and will need to change shape once Phase 2 replaces the enum
with a Programme-owned configuration table (Section 10) — at that point the
display label should come from the configuration row's own `name` field
(already part of the shape proposed in Roadmap Phase 2) rather than from a
switch/if-chain in this component.

## Category 4 — False positive, no action needed

| File | Line | Snippet |
|---|---|---|
| `server/src/routes/classes.js` | 62 | `return rows.some((r) => r.offering_type_id === offeringTypeId);` |

`offeringTypeId` here is a function parameter (dynamic value), not a literal
business identifier — this is an ordinary equality check, not a Configuration
Before Code violation. Included here only to show it was reviewed and ruled
out, not overlooked.

## Summary for Phase 3/4 planning

| Category | Severity | Files affected | Fix depends on |
|---|---|---|---|
| 1 — `kids_stem` self-registration override | HIGH | 5 | Phase 2 (or can be fixed standalone, sooner — see note below) |
| 2 — Corporate Training public CTA routing | LOW | 1 | Phase 2 |
| 3 — Participation Structure display labels | LOW | 1 | Phase 2 |
| 4 — false positive | — | 1 | N/A |

**Note:** Category 1 does not strictly require the full Phase 2 Participation
Structure migration to fix — it only requires adding one new settings field
to the existing `offeringTypeSettings.js` module, which is a much smaller,
independently shippable change. Recommend fixing Category 1 as an early,
low-risk deliverable at the start of Phase 2 rather than bundling it with the
larger Participation Structures migration, since it removes the
highest-severity finding from this audit well before the rest of Phase 2/3
lands.
