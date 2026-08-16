# Phase 4 — Frontend Implementation (Registration & Admin UI)

Per ABRS v2.1 §19 Phase 4. Per §20, stopping here for review.

## Objective

Replace any remaining hardcoded-identifier assumptions in the registration
and admin UI (§2.2) with configuration-driven rendering.

## Audit performed

Searched `client/src` for `offeringTypeSlug === `, `offeringType === `,
`participationStructure === `, and direct string comparisons against the
four known offering-type slugs or three known Participation Structure
keys. Found exactly two live hits — both were the two items the original
Category 1 fix's own report explicitly deferred as LOW severity
(`server/docs/HARDCODED_IDENTIFIER_AUDIT.md`, Categories 2 and 3):

- **Category 2** (`client/src/pages/public/publicUtils.js`):
  `resolveEnrolDestination()` special-cased `offering.slug ===
  "corporate_training"` to route the Enrol button to `#contact` instead of
  self-service registration.
- **Category 3** (`client/src/pages/admin/AccountDetailDrawer.jsx`):
  `PARTICIPATION_STRUCTURE_OPTIONS` and `participationStructureLabel()`
  hardcoded the three Participation Structure keys and their display
  names for the admin's view/edit control on an enrolment.

No other hardcoded offering-type or Participation-Structure comparison was
found anywhere in the registration flow (`RegisterPage.jsx`) or the rest
of the admin UI — Phase 1's fix already closed everything else.

## Fixes

### Category 2 — Corporate Training CTA routing

No new flag was needed: `enrolDestination` has always been a fully
generic, admin-editable field every offering type already has (see
`OfferingTypeLandingPanel.jsx`). The fix backfills Corporate Training's
*own default value* for that existing field (`"#contact"`), then deletes
the hardcoded branch entirely — `resolveEnrolDestination()` no longer
knows any offering type's identity, only whether `enrolDestination` is
set.

- `server/src/db/migrate.js`: `behaviourBySlug.corporate_training` now
  includes `landing: { enrolDestination: "#contact" }` for brand-new
  databases; new **v36** migration block idempotently backfills the same
  value onto a pre-existing Corporate Training row whose settings predate
  it (same pattern as `v33`'s Category 1 backfill).
- `client/src/pages/public/publicUtils.js`: `resolveEnrolDestination()`'s
  `slug === "corporate_training"` branch removed.

### Category 3 — Participation Structure labels/options

This needed one new thing Phase 3 never built: a read endpoint exposing
`programme_participation_structures` (Phase 2) to the frontend. Also
needed: Phase 2's backfill was deliberately conservative (only creates a
config row for a Programme+key pair that real historical data already
used), which could leave a Programme's admin picker missing an option for
a Participation Structure it happens to have zero history with yet — v36
also closes that gap for kids_stem specifically (the only offering type
§10.2 defines Participation Structures for today).

- `server/src/db/migrate.js` (v36, continued): backfills all three
  canonical `programme_participation_structures` rows for every existing
  kids_stem Programme, regardless of which ones its own historical data
  happened to use.
- `server/src/routes/learningOfferings.js`: new
  `GET /api/learning-offerings/programmes/:id/participation-structures` —
  public (unauthenticated, same posture as the existing
  `/types/public`/`/programme-runs/registration-config` endpoints), returns
  `[]` for a Programme with none configured rather than erroring.
- `client/src/api/admin.js`: new `fetchProgrammeParticipationStructures(programmeId)`.
- `client/src/pages/admin/AccountDetailDrawer.jsx`: fetches the account's
  Programme's configured structures once the account loads; the Select's
  options and the read-only label are both built from that response
  instead of a hardcoded array/lookup. `participationStructureLabel()`
  now falls back to the raw key (never a guessed label) for any value not
  found in the fetched config, instead of assuming one of exactly three
  possible strings.

## Verification performed

- `node --check` on every edited backend file, and on `publicUtils.js` —
  all pass.
- `npm run build` (client) — succeeds, no errors, `AccountDetailDrawer`
  and the public pages bundle emit cleanly.
- Migration run on a fresh database — both backfills fire correctly
  (Category 2 skipped as already-set from the new `behaviourBySlug`
  default; Category 3 seeds 3 rows for Builders Lab).
- Migration re-run (idempotency) — row counts unchanged.
- **Simulated pre-existing database**: manually stripped
  `landing.enrolDestination` from Corporate Training's settings (to
  simulate a database created before this migration existed), then
  re-ran the migration — confirmed it correctly retroactively backfilled
  `"#contact"`.
- **Real server, end-to-end**: booted against a fresh seeded database and
  confirmed via `curl`:
  - `GET /api/learning-offerings/programmes/:id/participation-structures`
    for the Builders Lab Programme returns all three structures with
    correct names/flags.
  - `GET /api/learning-offerings/types/public` returns
    `enrolDestination: "#contact"` for `corporate_training` and `""` (the
    unchanged default) for the other three offering types.
- Full backend suite (`npm test`, 175 tests): **174/175 pass** — same
  pre-existing, unrelated `integration-boundary.test.js` failure as every
  prior report (no regression).

## Database changes

One additive migration (`v36`): one JSON key backfilled onto Corporate
Training's existing `settings` (if missing), and up to three
`programme_participation_structures` rows backfilled per existing
kids_stem Programme (if missing). No table, column, or constraint
added/removed/altered.

## API changes

One new endpoint:
`GET /api/learning-offerings/programmes/:id/participation-structures`.
Additive — nothing existing changed shape.

## Frontend changes

`publicUtils.js` (Category 2 fix) and `AccountDetailDrawer.jsx` (Category
3 fix) only. No other page touched. No visual/UX change for any existing
data — every currently-configured value resolves identically to before;
what changed is where the values come from, not what they currently are.

## Risks

Low. Both fixes replace a hardcoded comparison with a read from data that
either already existed and was already generic (`enrolDestination`) or
was purpose-built for exactly this in Phase 2
(`programme_participation_structures`). The new endpoint is read-only and
additive. `AccountDetailDrawer`'s fallback behavior for an empty/failed
config fetch (`[]`) degrades to "no options besides Unspecified" rather
than crashing or silently mis-labeling — worth knowing about, not a
functional risk, since Builders Lab is fully seeded by this same
migration.

## Rollback

Revert the four touched files. `v36`'s backfill can be left in place even
on rollback — it only ever adds rows/sets a previously-empty field, never
removes or alters pre-existing admin configuration, so there's nothing to
undo on the database side even if the code that reads it is reverted.

## Remaining work / next recommended phase

Per §19, **Phase 5 — Integration**: retire the legacy enum columns and
inference paths now that Phases 2–4 have proven the new tables
authoritative. Per the spec's own exit criteria, this requires confirming
zero writes to the legacy columns over a full monitoring window (at least
one academic term) before they're droppable — an operational/monitoring
step, not something to attempt in this session. Recommend treating Phase
5 as "scheduled, not executed yet" until that monitoring window has
actually elapsed in your real deployment.

Two smaller, non-phase follow-ups already flagged in earlier reports
remain open and are unaffected by this phase:
- Admin UI for reviewing/editing Activated Course rows (Checkpoint 3b).
- Instructor-authorization read cutover across the ~10 route files that
  still check `instructor_courses` directly (Checkpoint 3b, deferred).

Per §20, stopping here for your review.
