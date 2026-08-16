# Operational Groups — Implementation Report

Per ABRS v2.2 §11 (Operational Groups) and Appendix Item A-9. Constitutional
sections read for this checkpoint: §11, §13, §17, §18, §19, §20.1 (plus §8.2
and Appendix A-9/A-11 for grounding). §14 (Promotion) was explicitly out of
scope and was only *inspected*, not modified — see "Promotion isolation"
below.

## Objective

Close Appendix A-9: give Operational Groups (batches/cohorts/sections that
exist only to organize a Programme Run's delivery) their own table, their
own owner (the Programme Run), and their own constitutionally-scoped
override field list — replacing the second, undocumented purpose the
`classes` table had been carrying since v17/v29/v31 (Delivery Mode, Campus,
Fee overrides layered on top of Programme Level rows).

`classes` itself is untouched in meaning: it remains exclusively the
Programme Level table (§13). Its legacy `delivery_mode` / `campus_id` /
`fee_ghs` / `display_label` columns are **not removed or renamed** —
removing them would violate "additive migrations only" / "preserve backward
compatibility" — but they are no longer where any NEW read/write path looks
first.

## Database changes (migration v39, `server/src/db/migrate.js`)

### New table: `operational_groups`
One row per Operational Group. Scoped to `learning_instance_id` (Programme
Run) — never to a Programme, a Course, or a Participation Structure (§11.2).
Columns: `id`, `learning_instance_id`, `name`, `display_label`,
`sort_order`, and six nullable override columns — `fee_ghs`, `capacity`,
`instructor_id`, `delivery_mode`, `campus_id`, `registration_deadline` —
plus `legacy_class_id` (backfill provenance only, never read by any
resolver), `is_active`, timestamps. `UNIQUE(learning_instance_id, name)`.

**Why only six of §11.3's twelve named fields**: §11.3 itself forbids an
Operational Group from overriding "a field the Programme Run does not
itself already own." Cross-checked against `learning_instances`' actual
column set (§8.2), only Tuition Fee, Capacity, Instructor, Delivery Mode,
Campus, and Closing Date have a Run-owned field to override today. Venue,
Schedule, Meeting Days, Meeting Times, and Waitlist Capacity are not
implemented anywhere in this codebase yet — adding them at the Operational
Group level first would be introducing a new business concept through the
child rather than the parent, which is a constitutional amendment (§2.3),
not something this migration is authorized to do. "Maximum Enrollment" is
treated as the same concept as "Capacity" (one Run-level capacity concept,
not two — a second, textually different but practically identical column
would itself be the duplicated ownership §2.1 forbids).

### `programme_enrollments.operational_group_id`
Nullable FK, additive. NULL for every enrollment that predates this
migration and wasn't backfilled, and for any enrollment in a Run with no
Operational Groups at all — resolution falls through to the pre-existing
Class-level path in that case, byte-for-byte unchanged.

### Backfill
For every existing `classes` row actually carrying an Operational-Group-
purpose override (`delivery_mode`/`campus_id`/`fee_ghs` non-null) with a
resolvable Active Programme Run, one `operational_groups` row is created
(best-effort single-instructor carried over from `instructor_classes` if
unambiguous), and every `programme_enrollment` referencing that class+run
pair is re-pointed at it. Idempotent — re-running the migration does not
duplicate groups or overwrite an admin's subsequent edits.

## Backend logic (`server/src/utils/learningInstances.js`)

New functions: `createOperationalGroup`, `updateOperationalGroup`,
`retireOrDeleteOperationalGroup` (soft-deletes/retires if any Enrollment
has ever referenced the group, otherwise hard-deletes), `getOperationalGroupsForInstance`,
`getOperationalGroupById`, `resolveOperationalGroupConfig` (single-level
override resolution against the parent Run, per §11.3), and
`resolveEnrollmentOperationalConfig` — the new authoritative entry point
for any enrollment-scoped read, which prefers an assigned Operational Group
and falls back to the legacy `resolveClassOperationalConfig` only when none
is assigned. `deriveEnrollmentOperationalSnapshot` (used at enrolment-write
time) now accepts an optional `operationalGroupId` and resolves through it
first.

Validation enforces the ownership rule structurally: `deliveryMode`/
`campusId` overrides are rejected (400) unless they're already in the
parent Run's own configured set; `instructorId` is checked against the
`users` table.

## APIs updated

`server/src/routes/learningInstances.js`:
- `GET /api/learning-instances/:id/operational-groups` — list, with
  `enrolledCount` per group (§21 — Reporting may aggregate by Operational
  Group).
- `POST /api/learning-instances/:id/operational-groups` — create.
- `PATCH /api/learning-instances/:id/operational-groups/:groupId` — edit.
- `DELETE /api/learning-instances/:id/operational-groups/:groupId` —
  retire-or-delete.

All four require `learningInstances.edit`/`.view` (no new parallel
permission — owning the Run already means owning what it owns, per §8.2).

`server/src/routes/enrolments.js`:
- `POST /api/enrolments` — now accepts optional `operationalGroupId`,
  validated against the resolved Programme Run; omitted = unchanged
  behaviour.
- `PATCH /api/enrolments/:id/operational-group` — **new, standalone**
  administrative transfer endpoint (§11.4/§20.2's "exactly one endpoint
  that reassigns an Operational Group, distinct from the Promotion
  endpoint"). Never touches `class_id`, `current_academic_year_id`,
  `status`, or any other field.

## Promotion isolation (§11.4, §14 — inspected, not modified)

`server/src/routes/promotion.js`'s constitutional core (`POST
/:id/promote`) writes only `users.class_id` (and, via the same-purpose
`/graduate` and `/transfer-campus` routes, campus and completion — both
already separate, dedicated endpoints from a prior checkpoint). Nothing in
it references `operational_groups` or `programme_enrollments.operational_group_id`,
and nothing added in this checkpoint gives it a reason to. No changes were
made to this file.

## Certificate generation (§11.4 — verified, not modified)

`server/src/routes/certificates.js`'s only `classId` usage is as an
admin-facing recipient filter (Programme Level, for bulk-generation
targeting) — not an eligibility check. No Operational-Group dependency
exists anywhere in certificate eligibility logic; none was introduced.

## Frontend pages updated

- `client/src/pages/admin/LearningInstanceModal.jsx` — new "Operational
  Groups" panel (list/add/edit/retire), positioned directly after the
  existing "Operational Configuration" (Run-level) and "Instructor
  Assignment" sections it inherits from.
- `client/src/pages/admin/useAdminLearningInstances.js` — four new hook
  methods (`loadOperationalGroups`, `addOperationalGroup`,
  `editOperationalGroup`, `removeOperationalGroup`).
- `client/src/pages/admin/AdminLearningInstancesPage.jsx` — wires the four
  new handlers into the modal.
- `client/src/api/admin.js` — `fetchOperationalGroups`,
  `createOperationalGroup`, `updateOperationalGroup`,
  `deleteOperationalGroup`, `setEnrolmentOperationalGroup`.

**Not touched**: `client/src/pages/auth/RegisterPage.jsx` (the
parent/adult self-registration wizard) still reads a Class's *legacy*
resolved `deliveryMode`/`campusId` (via `routes/classes.js`'s
`toClassDto()`, which still calls `resolveClassOperationalConfig` and is
unaffected/unbroken by this checkpoint) rather than offering an explicit
Operational Group picker. This is safe — zero behavioural change to
existing registration — but is out of this checkpoint's scope; wiring
`operationalGroupId` into the registration wizard itself is documented
here as follow-up work, not silently done.

## Verification performed

- `node src/db/migrate.js` run to completion on a fresh DB and on a DB
  seeded with a realistic pre-migration override (Class with
  `delivery_mode`/`fee_ghs` set + Active Programme Run + Enrollment) —
  confirmed the backfill produces a correct `operational_groups` row and
  correctly re-points the Enrollment's `operational_group_id`.
- Migration re-run twice against the same seeded DB — confirmed
  idempotent (no duplicate rows).
- `resolveEnrollmentOperationalConfig`/`resolveOperationalGroupConfig`
  exercised directly against the seeded DB — resolved values match the
  pre-migration legacy-resolved values exactly.
- CRUD lifecycle (`createOperationalGroup` → reject on Run-unowned
  `deliveryMode` → succeed after configuring the Run's own
  `delivery_modes` → `updateOperationalGroup` → `retireOrDeleteOperationalGroup`)
  exercised directly, both as direct function calls and, separately, as
  full HTTP round-trips against a running server instance (login → POST →
  GET → PATCH → DELETE), including the 400 rejection path.
- Every touched/adjacent backend file
  (`db/migrate.js`, `utils/learningInstances.js`, `routes/learningInstances.js`,
  `routes/enrolments.js`, `routes/promotion.js`, `routes/classes.js`,
  `utils/fees.js`, `server.js`) passes a `require()`/load check with no
  syntax or wiring errors.
- Full client production build (`npm run build`, vite) succeeds with no
  errors.
- Confirmed, by direct code inspection, that no other backend or frontend
  file treats `classes.delivery_mode`/`campus_id`/`fee_ghs` as an
  enrollment-time authoritative source going forward — the only two
  remaining callers of the legacy `resolveClassOperationalConfig`
  (`utils/fees.js`'s pre-enrollment fee preview, and `routes/classes.js`'s
  admin-facing "what does this Class currently resolve to" display) are
  both pre-Operational-Group-assignment contexts where no enrollment (and
  therefore no `operational_group_id`) yet exists, and are documented as
  intentional legacy fallbacks in code comments.
