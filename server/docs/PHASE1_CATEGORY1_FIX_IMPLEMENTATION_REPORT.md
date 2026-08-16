# Standalone Fix — Hardcoded-Identifier Audit Category 1 (kids_stem) — Implementation Report

Per ABRS v2.1 §20 (AI Delivery Protocol) and the Phase 1 implementation
report's own recommendation: "Recommend fixing Category 1 as an early,
low-risk deliverable at the start of Phase 2 rather than bundling it with
the larger Participation Structures migration."

## Objective

Close Appendix Item A-8 / HARDCODED_IDENTIFIER_AUDIT.md's Category 1
(HIGH): the five duplicated `slug === "kids_stem"` overrides, per ABRS
§2.2 (Configuration Before Code).

## Finding during implementation: Category 1 was actually two rules, not one

The Phase 1 audit described all five locations as encoding "the same
business rule." On closer inspection while implementing the fix, two of
the five (`routes/users.js`, and the corresponding logic in
`RegisterPage.jsx`) do not gate self-registration at all — they gate a
different rule: whether the classic Parent + Child flow requires selecting
individual Courses up front ("Choose at least one module"). Giving both
rules the same configuration flag would have traded one Single Ownership
Principle violation for another (one flag silently answering two
questions). Each rule now has its own flag:

- `settings.enrollment.legacyAlwaysSelfRegistrable` — the actual
  self-registration override (3 locations: `offeringTypeSettings.js`,
  `routes/enrolments.js`, `routes/learningOfferings.js`).
- `settings.academicStructure.legacyRequiresCourseSelectionAtRegistration`
  — the course-selection requirement (2 locations: `routes/users.js`,
  `RegisterPage.jsx`).

Both default `false` and are seeded `true` only for `kids_stem`, so
today's behaviour is unchanged for every existing offering type.

## Files modified

- `server/src/utils/offeringTypeSettings.js` — added both flags to
  `DEFAULT_SETTINGS`; added `offeringTypeAllowsSelfRegistration(type)` and
  `offeringTypeRequiresCourseSelectionAtRegistration(type)`;
  `programmeAllowsSelfRegistration()` now delegates to the former instead
  of comparing `type.slug`. Both new functions exported.
- `server/src/db/migrate.js` — `behaviourBySlug.kids_stem` now seeds both
  flags `true` for brand-new databases; new **v33** migration block
  idempotently backfills both flags `true` onto a pre-existing kids_stem
  row whose `settings` JSON predates them (same pattern as the existing
  `usesModules` backfill).
- `server/src/routes/enrolments.js` — `GET /eligible-offerings`'s filter
  now calls `offeringTypeAllowsSelfRegistration(t)` instead of
  `t.slug === "kids_stem" || t.settings.enrollment.selfRegistrationAllowed
  !== false`.
- `server/src/routes/learningOfferings.js` — `GET /types/registration`'s
  filter uses the same shared resolver; its response now also includes
  `requiresCourseSelectionAtRegistration` per offering, resolved via
  `offeringTypeRequiresCourseSelectionAtRegistration(t)`, so the frontend
  no longer has to re-derive that fact from the slug either.
- `server/src/routes/users.js` — `POST` child-registration route's
  `isKidsStem` gate replaced with
  `offeringTypeRequiresCourseSelectionAtRegistration(targetOfferingType)`,
  preserving the existing `!targetOfferingType` fallback unchanged.
- `client/src/pages/auth/RegisterPage.jsx`:
  - `kidsStemType` (slug lookup) replaced with `defaultParentOfferingType`
    — the lowest-`sort_order` parent-eligible offering, the same "default"
    convention already used server-side by
    `getDefaultProgrammeForOfferingSlug`. Resolves identically to today's
    data (Kids STEM, `sort_order: 0`) without a literal identifier.
  - The `?offeringTypeSlug=kids_stem` deep-link special case now checks
    whether the URL's slug matches the (single, in the no-picker case)
    configured parent offering, instead of comparing to the literal string.
  - `parentSelectedIsKidsStem` / `setParentSelectedIsKidsStem` renamed to
    `parentRequiresCourseSelection` / `setParentRequiresCourseSelection`,
    and now set from `type.requiresCourseSelectionAtRegistration` (from
    the API) instead of `type.slug === "kids_stem"`.
  - `parentPathIsKidsStem()` renamed to
    `parentPathRequiresCourseSelection()` and simplified to read directly
    off `parentRequiresCourseSelection` (previously it separately
    hardcoded the no-picker case to `true`, which was the same rule
    encoded a second time). All 8 call sites updated.

## Files NOT modified (in scope, deliberately deferred)

Categories 2 and 3 of the same audit (`publicUtils.js`'s Corporate
Training CTA routing; `AccountDetailDrawer.jsx`'s Participation Structure
display labels) are untouched, as agreed — both are LOW severity and
tied to Phase 2's Programme-owned configuration table, per the original
audit's recommendation.

## Database changes

One idempotent, additive migration (v33): backfills two new JSON keys
onto the existing `kids_stem` row's `settings` column only, if not already
present. No table, column, or constraint added/removed/altered. No other
row touched.

## API changes

`GET /api/learning-offerings/types/registration` response now includes one
new field per offering: `requiresCourseSelectionAtRegistration` (boolean).
Additive — existing consumers reading the response ignore unknown fields.

## Frontend changes

`RegisterPage.jsx` only, as detailed above. No visual/UX change — every
renamed variable/function keeps its existing behaviour, verified by the
build and test results below.

## Verification performed

- `node --check` on every edited backend file — all pass.
- `npm run build` (client) — succeeds, `RegisterPage` bundle emitted with
  no errors.
- Targeted test run (registration/enrolment-related suites — 37 tests
  across `country-registration`, `town-registration`,
  `delivery-mode-registration`, `registration-window-and-instructor-
  assignment`, `admin-registration-view`, `enrolment-duplicate-
  prevention`, `enrollment-activation`, `module-access-enrollment`,
  `period-target-registration`): **37/37 pass**.
- `builderslab-architecture.test.js` (3 tests, including the one
  explicitly checking the Course/Module-selection gate is config-driven,
  not a hardcoded Kids STEM check): **3/3 pass**.
- Full backend suite (`npm test`, 175 tests): **174/175 pass.** The one
  failure (`integration-boundary.test.js`, "static-file boundary") is
  unrelated to this fix — it expects a legacy `index.html` at the project
  root, which this delivered project snapshot doesn't include (confirmed:
  no `.html` files exist anywhere outside `client/`). This is a pre-
  existing environment/packaging gap, not a regression; nothing in this
  fix touches static file serving. Recommend confirming in your own
  environment, where the legacy public files are presumably present.

## Risks

Low. Both new flags default `false` and only `kids_stem` is seeded `true`
for either — every other current or future offering type is completely
unaffected unless an admin explicitly sets one of these flags via the
`settings` JSON (no admin UI exposes them yet, by design; they exist only
to replace the removed hardcoding, not to become new user-facing toggles
prematurely).

## Remaining work

- Categories 2 and 3 of the original audit — deferred to Phase 2, as
  originally scoped.
- `legacyRequiresCourseSelectionAtRegistration`'s own docstring already
  notes its intended retirement once Phase 2/3 land Programme-owned
  Participation Structures (ABRS §10) and Individual Course's
  `requiresCourseSelection` behaviour properly subsumes it.

## Next recommended phase

**Phase 2 — Database Migration (Participation Structures as Programme-Owned
Configuration Data)**, per ABRS v2.1 §19 — the same recommendation the
Phase 1 report ended on. Per §20, stopping here for your review before
proceeding.
