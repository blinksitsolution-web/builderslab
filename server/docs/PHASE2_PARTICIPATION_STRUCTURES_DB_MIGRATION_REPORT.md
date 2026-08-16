# Phase 2 — Database Migration: Participation Structures as Programme-Owned Configuration Data

Per ABRS v2.1 §19 Phase 2 and Appendix Item A-1 (CRITICAL). Per §20 (AI
Delivery Protocol), stopping here for review before Phase 3 begins.

## Objective

Close Appendix A-1: replace the fixed `TEXT CHECK` enum for Participation
Structure (`structured_school_club` / `structured_other` /
`individual_course`) with Programme-scoped, admin-editable configuration
data — without turning Participation Structures into a new standalone
entity type (they remain Programme-owned configuration per §10.1) and
without introducing any architectural layer forbidden by §11.4.

Per Phase 2's own scope in §19, this is **database-only**. No backend
route, no frontend component, and no business-logic branch was touched.

## Database changes

One new migration block (`v34`) in `server/src/db/migrate.js`, additive
only:

### New table: `programme_participation_structures`
The Programme-owned definition. One row per Participation Structure a
Programme has defined for itself. Columns: `id`, `programme_id`, `key`
(stable machine key), `name`, `uses_programme_levels`, `uses_promotion`,
`requires_course_selection`, `registrant_role`, `uses_long_term_enrollment`,
`auto_assigns_entry_level`, `is_active`, `sort_order`, timestamps.
`UNIQUE(programme_id, key)`. Column set matches §19 Phase 2's Affected
Entities list plus the extra §10.2 behaviour flags Structured School Club
needs (long-term enrollment, auto Entry Level assignment).

### New table: `learning_instance_participation_structures`
The join recording which of a Programme's defined Participation Structures
a given Programme Run has **activated** (§10.1: Runs activate, they never
define). Deliberately a join, not a column on `learning_instances`, so a
Run can activate more than one Participation Structure at once (§10.1's
own example — a full-year Run activating all three).

### Structural enforcement
Two triggers (`trg_lips_same_programme_insert`, `trg_lips_same_programme_update`)
reject any row in the join table whose Participation Structure doesn't
belong to the same Programme as the Learning Instance activating it — the
"enforced structurally" requirement in §19 Phase 2's Affected Entities
list, at the database layer rather than only in application code (the same
posture Appendix A-5 already sets as the reference example).

### Legacy columns
`programme_enrollments.participation_structure` and
`learning_instances.participation_structure` (added in `v29`) are
**untouched** — not renamed, altered, or dropped. They were already
nullable, so no column change was needed; they remain the columns every
existing route reads and writes today.

### Backfill
One-time, idempotent, run inside `v34`:
1. For every distinct `(programme_id, participation_structure)` pair
   actually present in `programme_enrollments` or `learning_instances`
   (non-null, non-null `programme_id`), insert exactly one
   `programme_participation_structures` row, using name/behaviour metadata
   sourced from §10.2's table (the only three legal enum values are
   `structured_school_club` / `structured_other` / `individual_course`,
   so this metadata is closed and known, not guessed).
2. For every Learning Instance that already named a
   `participation_structure`, insert the one join row that legacy state
   implies (a Run's old enum value **is** the one Participation Structure
   it was already "activating" — there was no way to express more than
   one under the old column).
3. Nothing is invented for a Programme/value combination that has never
   appeared in real data — the same "never reinterpret history" posture
   every other backfill in `migrate.js` (e.g. the `v33` and `usesModules`
   backfills) already takes.

## Verification performed

Per §20 point 2 (only changes-relevant testing at non-milestone
checkpoints), but full backend suite was also re-run for confidence since
it's cheap on this codebase:

- `node --check src/db/migrate.js` — passes.
- Migration run on a **fresh** database — clean, all tables/triggers
  created, backfill correctly reports "nothing to backfill."
- Migration **re-run** on the same fresh database (idempotency) — no
  errors, no duplicate rows, identical `CREATE TABLE`/trigger SQL on
  re-inspection.
- Migration run against a database seeded with a **Run-level** legacy
  `participation_structure` (`structured_school_club`) — correctly
  backfilled one `programme_participation_structures` row and one
  `learning_instance_participation_structures` activation row, with the
  correct `uses_programme_levels`/`uses_promotion`/`uses_long_term_enrollment`/
  `auto_assigns_entry_level` flags per §10.2.
- Migration run against a database seeded with only an **enrollment-level**
  legacy `participation_structure` (`individual_course`, no Run ever set
  it) — correctly backfilled one config row and **zero** activation rows
  (there is nothing for it to activate against), with
  `requires_course_selection = 1` and `registrant_role = 'parent_or_self'`
  per §10.2.
- Re-running migration against that seeded database a second time — row
  count unchanged (still exactly 1), confirming the backfill is
  idempotent even with real data present, not only on a fresh database.
- Full backend suite (`npm test`, 175 tests): **174/175 pass** — same
  pre-existing, unrelated failure as the Category 1 fix report
  (`integration-boundary.test.js`, missing legacy root `index.html` in
  this delivered snapshot; confirmed not a regression).

## API changes

None. No route reads or writes the new tables yet — that is Phase 3.

## Frontend changes

None.

## Risks

Low, matching §19 Phase 2's own risk assessment. Both new tables are
additive with zero existing readers; the legacy enum columns and every
route that uses them are completely unaffected. The backfill only ever
inserts rows implied by data that already exists — it cannot corrupt or
reinterpret a historical record, and inserts are `INSERT OR IGNORE` against
`UNIQUE` constraints, so even an unexpected re-run mid-deployment can't
duplicate rows.

## Rollback

Per §19 Phase 2: drop `learning_instance_participation_structures` and
`programme_participation_structures` (in that order, for the FK). The
legacy enum columns were never touched, so rollback carries zero data-loss
risk — this is a straightforward two-table `DROP`.

## Exit criteria (§19 Phase 2) — met

- New tables exist and are seeded. ✅
- Provably in sync with legacy enum data (verified above against both a
  Run-level and an enrollment-level legacy value). ✅
- No reader yet depends on them (grep-verified: only `migrate.js`
  references the two new table names). ✅

## Remaining work / next recommended phase

**Phase 3 — Backend Implementation** (§19): cut `routes/auth.js`,
`routes/enrolments.js`, `routes/learningInstances.js`,
`routes/learningOfferings.js`, and `utils/learningInstances.js`'s
`PARTICIPATION_STRUCTURES` / `isValidParticipationStructure` over to read
Participation Structure behaviour from `programme_participation_structures`
instead of the hardcoded enum array (§2.2) — behind a feature flag, with
dual-write during the transition, per §19 Phase 3's own spec. Phase 3 also
implements Activated Courses (§8/§9, Appendix A-2) as a first-class table,
and folds in Appendix A-4 (normalizing Individual Course's JSON-encoded
Course selections into a joinable table) alongside it, per §19's own
grouping of A-2/A-4 into Phase 3.

Per §20, stopping here for your review before proceeding.
