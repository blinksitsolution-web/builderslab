# Phase 5 Prerequisite (1 of 2) — Participation Structure Backend Cutover

Per ABRS v2.1 §19 and Appendix Item A-1. Per §20, stopping here for review
before the second prerequisite (Activated Courses admin UI + staged pilot).

## Why this checkpoint exists

Phase 5's own premise is "now that Phases 2–4 have proven the new tables
authoritative." Auditing the codebase before starting Phase 5 found that
premise wasn't actually true for Participation Structures: Phase 2 built
`programme_participation_structures` / `learning_instance_participation_structures`
(database-only, as scoped), but the backend cutover Phase 2's own report
named as the next step — `routes/auth.js`, `routes/enrolments.js`,
`routes/learningInstances.js`, and `utils/learningInstances.js`'s
`isValidParticipationStructure`/`PARTICIPATION_STRUCTURES` reading from
configuration instead of the hardcoded enum — never happened. Checkpoints
3a/3b implemented a different, adjacent initiative (Activated Courses,
Appendix A-2/A-4) instead. Phase 4 only added a read endpoint for the
admin label UI, which never touches validation or the write path.

This checkpoint delivers the missing piece: the actual Participation
Structure business-logic cutover, flag-gated and dual-written, matching
the posture §19 Phase 3 always specified for this kind of change.

## What this delivers

### New shared metadata module
`server/src/utils/participationStructureMetadata.js` — the three legacy
Participation Structure keys' §10.2 metadata, in one place, so
`utils/learningInstances.js`'s new auto-create logic doesn't duplicate the
same literals `migrate.js`'s v34/v36 backfills already embedded (those stay
frozen and untouched — a migration's historical behaviour must never
change on re-run).

### New config-driven functions (`utils/learningInstances.js`)
- `getProgrammeParticipationStructures(programmeId)` — a Programme's active
  Participation Structures (§10.2), read from `programme_participation_structures`.
  `routes/learningOfferings.js`'s existing Phase 4 admin-label endpoint now
  reads through this same function instead of its own copy of the query.
- `resolveParticipationStructureConfig(programmeId, key)` — a single
  structure's config row, or null.
- `ensureProgrammeParticipationStructure(programmeId, key)` — dual-write
  helper; auto-creates a Programme's config row from the known legacy
  metadata the first time that Programme uses a recognized key, never
  invents metadata for an unrecognized one.
- `ensureLearningInstanceParticipationStructureActivation(learningInstanceId, programmeId, key)` —
  Run-level dual-write into the `learning_instance_participation_structures`
  join table (§10.1's "activation"), mirroring Checkpoint 3a's
  `ensureActivatedCourse` pattern.

### New feature flag
`settings.academicStructure.participationStructuresV2Enabled` (default
`false` for every offering type), resolver
`offeringTypeUsesParticipationStructuresV2(type)` — same shape and same
default-off posture as Checkpoint 3a's `activatedCoursesV2Enabled`.

### Validation cutover (flag-gated)
- `routes/auth.js` — both the parent-learner and adult self-registration
  paths (they share one validation block). When the resolved offering
  type has the flag on, `participationStructure` is validated against
  that Programme's own config instead of the hardcoded 3-value enum, with
  an error message built from what that Programme actually has
  configured. **Also fixes a real bug**, flag-gated: the legacy
  `requiresModuleSelection` check hardcoded `!== "structured_school_club"`,
  which incorrectly required a Course selection step for "Structured
  Online Journey" too — per §10.2's own table, that structure's Course
  Selection is "No (whole curriculum)", same as School Club. With the
  flag on, this is now read from the matched structure's own
  `requiresCourseSelection` flag; with the flag off, the historical
  (buggy) heuristic is preserved byte-for-byte.
- `routes/enrolments.js` — the additional-programme `POST /` and the
  admin `PATCH /:id/participation-structure` correction endpoint now both
  call one shared `validateParticipationStructureForProgramme()` helper
  instead of two independent copies of the same hardcoded check (§17.2 —
  one capability, one implementation). The PATCH endpoint's `SELECT` was
  extended to also fetch `programme_id`, needed to resolve the offering
  type for the flag check.
- `routes/learningInstances.js` — Run creation and edit share one
  `validateRunParticipationStructure()` helper, same flag-gated pattern.

### Dual-write (unconditional — not behind the flag)
Whenever a Programme Run's `participation_structure` column is set
(create or edit, `routes/learningInstances.js`), the Run-level activation
join row is also written via `ensureLearningInstanceParticipationStructureActivation`,
same rationale as Checkpoint 3a's Activated Course dual-write: nothing
reads this for business logic yet unless the flag is on, so writing it
unconditionally gives it real, trustworthy history by the time any
offering type opts in, rather than only whatever gets written after a
future flag flip.

Enrollment-level `participation_structure` (`programme_enrollments`) has
**no** matching dual-write into a new table — there isn't a new table to
write to. Per §2.1's Single Ownership Principle, Enrollment already owns
that fact; a second table recording "which structure this enrollment
selected" would itself be a Single Ownership violation, not a fix for
one. Only its *validation* moved to config; its storage location didn't
change, correctly.

## Verification performed

- `node --check` on every edited/created file — all pass.
- Full backend suite (`npm test`, 175 tests): **174/175 pass** — same
  pre-existing, unrelated `integration-boundary.test.js` failure as every
  prior report (no regression).
- Migration run on a fresh database — clean (no migration changes were
  needed for this checkpoint; the flag is a new `DEFAULT_SETTINGS` key,
  which `deepMerge` supplies at read time with no backfill required, same
  as `activatedCoursesV2Enabled` needed none).
- **Real server, end-to-end**, booted against a freshly seeded database:
  1. Created an Active Programme Run for Builders Lab with no
     `participationStructure` set.
  2. **Flag OFF (default)**: registered with `participationStructure:
     "structured_other"` — confirmed it still required a module
     selection (`"Choose at least one module."`), i.e. the legacy
     (buggy) behaviour is preserved byte-for-byte. `"structured_school_club"`
     still registered successfully with no module required, unchanged.
     An invalid value returned the exact historical hardcoded error
     message.
  3. Flipped `participationStructuresV2Enabled` for `kids_stem` only.
  4. **Flag ON**: `"structured_other"` now registered successfully
     *without* a module — confirming the bug fix. `"individual_course"`
     still correctly required one. An invalid value now returned a
     message built from the Programme's actual configured keys (same
     three, since Builders Lab's config is the Phase 4 backfill, but now
     genuinely sourced from data).
  5. `PATCH /api/learning-instances/:id` with `participationStructure:
     "structured_other"` — confirmed a matching
     `learning_instance_participation_structures` row was created,
     correctly linked to Builders Lab's `structured_other` config row.
  6. Admin `PATCH /api/enrolments/:id/participation-structure` — bogus
     value rejected with the config-driven message (flag on); valid
     value (`individual_course`) accepted.

## API changes

None additive to the public shape — every touched endpoint's request/response
shape is unchanged. What changed is validation logic and, for one offering
type with the flag explicitly on, which values are accepted and how
`requiresModuleSelection` is derived.

## Frontend changes

None. This checkpoint is backend-only, matching how Checkpoint 3a scoped
its own database+dual-write step before any read-path or UI work.

## Risks

Low for the default (flag-off) state — verified byte-identical to
pre-checkpoint behaviour, including the preserved bug. **Moderate,
deliberate risk for any offering type an admin opts in**, same posture
Checkpoint 3b called out for Activated Courses: flipping
`participationStructuresV2Enabled` changes real registration validation
and (for structures other than School Club) whether a module-selection
step is required, based on that Programme's actual configured
`requiresCourseSelection` flags. For Builders Lab specifically this is a
*bug fix*, but a Programme whose config rows are wrong or incomplete
could see registration behave unexpectedly the moment the flag is
flipped for it — exactly why it stays off by default per offering type.

Dual-write risk is low and one-directional, same reasoning as Checkpoint
3a: it only ever writes to the new, still-unread-for-business-logic join
table; the legacy `participation_structure` column and every existing
reader of it are untouched.

## Rollback

Revert the seven touched/created files
(`utils/participationStructureMetadata.js`,
`utils/learningInstances.js`, `utils/offeringTypeSettings.js`,
`routes/auth.js`, `routes/enrolments.js`, `routes/learningInstances.js`,
`routes/learningOfferings.js`). No schema change in this checkpoint — the
tables already existed from `v34`/`v36`. Any offering type with the flag
switched on can simply have it switched back off; nothing the dual-write
wrote to `learning_instance_participation_structures` needs cleanup,
since the legacy column remains fully authoritative whenever the flag is
off for that offering type.

## Remaining work / next recommended step

**Prerequisite 2 of 2** (per your instruction to do both before attempting
Phase 5): Activated Courses admin UI (review/edit `status`/`is_hidden`/
`is_compulsory`/`sort_order`/Run-scoped `instructor_id`) + a staged pilot
flip of `activatedCoursesV2Enabled` on one low-stakes offering type in
staging, confirming identical resulting Enrollment rows to the legacy
path — per §19 Phase 3's own exit criteria, which Checkpoint 3b's report
already identified as the blocker to a real flag flip anywhere.

Only once both prerequisites are done, piloted, and (per §19 Phase 5's
own verification checklist) monitored write-cold over a real deployment
window, does Phase 5's premise actually hold.

Per §20, stopping here for your review before Prerequisite 2.
