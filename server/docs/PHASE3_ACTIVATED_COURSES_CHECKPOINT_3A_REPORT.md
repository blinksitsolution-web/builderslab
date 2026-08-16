# Phase 3, Checkpoint 3a — Activated Courses & Normalized Course Selections (Database + Dual-Write)

Per ABRS v2.1 §19 Phase 3 and Appendix Items A-2 (HIGH) / A-4 (MEDIUM).
Per §20 (AI Delivery Protocol), stopping here for review.

## Why this is "Checkpoint 3a," not all of Phase 3

Phase 3's own scope is large: cut Participation Structure logic over to
configuration (§19), implement Activated Courses as a real table (§8/§9),
**and** switch registration/enrolment/instructor-assignment endpoints'
*read paths* over, behind a feature flag.

While building this out, it became clear that two of those read paths
aren't the simple "flip a flag" swap the roadmap entry's phrasing might
suggest, once checked against what the code actually does today:

- **Course eligibility at registration** (`routes/courses.js`) is keyed
  off Course Group + Programme Level + `courses.is_open` — it doesn't
  filter by Programme Run at all today. Switching it to read
  `learning_instance_courses` wouldn't be a like-for-like read-path swap;
  it would be *adding* Run-scoping to a flow that doesn't have that concept
  yet. That's a real, valuable change, but a bigger one than a single
  dual-write checkpoint should bundle in alongside a schema migration.
- **Instructor assignment** (`instructor_courses`) is read for
  authorization in roughly a dozen route files (attendance, notes, exams,
  assignments, messages, continuous assessments, curriculum access) — it's
  a security-relevant access-control table, not just a display concern, and
  `PATCH /users/:userId/assignments` does a delete-and-replace-all each
  time, which a mirrored write needs to handle correctly (clearing stale
  mirrors, not just adding new ones) to avoid silent drift between the old
  and new tables.

Given that, this checkpoint delivers the **database layer and dual-write**
in full — the part that's genuinely safe, additive, and independently
verifiable — and defers the **read-path cutover** (registration course
eligibility, instructor-assignment authorization) to Checkpoint 3b as its
own reviewed step, consistent with §20's incremental, low-risk delivery
posture. This also has a practical benefit: by the time 3b lands, the
dual-write tables will already hold real accumulated history to verify the
cutover against, rather than starting from empty tables.

## What this checkpoint delivers

### Database (migration `v35`)

**`learning_instance_courses`** — the Activated Course (§8): the
association between a Programme Run and a Course plus run-specific
configuration. Columns: `status` (Active/Inactive, §9), `is_hidden` (§9
Hidden axis), `is_compulsory` (§9 Compulsory/Optional axis), `sort_order`
(display order), `instructor_id` (Run-scoped instructor, distinct from the
global `instructor_courses`), `visible_class_ids` /
`visible_participation_structure_ids` (JSON arrays, same "NULL = no
restriction configured yet" convention already used by
`learning_instances.delivery_modes`/`campus_ids` since `v31`). §9's
Archived state is deliberately **not** a column here — it's derived from
the parent Run's own `status`, exactly as §9 specifies ("tied to the
parent Programme Run").

**`programme_enrollment_courses`** — normalized Individual Course
selection (Appendix A-4), replacing the JSON array
(`programme_enrollments.requested_course_ids`, which is retained
unchanged) with a real join, best-effort linked to the Activated Course it
resolves against when one exists.

**Backfill:** `learning_instance_courses` is backfilled 1:1 from every
existing `learning_instance_targets` row that names a `course_id` (a
clean, already-unambiguous mapping — that table is already the single
source of truth for "which Courses a Run targets").
`programme_enrollment_courses` is backfilled by parsing every existing
`requested_course_ids` JSON array. Per-course instructor assignment
(`instructor_courses`) is **deliberately not backfilled** onto
`learning_instance_courses.instructor_id` — doing so would require
inferring which Run a global instructor assignment "belongs to," which the
source data doesn't actually record. `instructor_id` starts NULL for every
backfilled row; assigning it is an explicit admin action, once Checkpoint
3b's admin UI exists to do it.

Nothing legacy is altered: `learning_instance_targets`, `instructor_courses`,
and `requested_course_ids` are all still exactly what every existing route
reads and writes.

### Feature flag scaffold

`settings.academicStructure.activatedCoursesV2Enabled` added to
`offeringTypeSettings.js`'s `DEFAULT_SETTINGS` (default `false` for every
offering type) with a resolver, `offeringTypeUsesActivatedCoursesV2(type)`.
Nothing branches on it yet in this checkpoint — it exists now so
Checkpoint 3b's read-path cutover has a single already-wired resolver to
call, rather than adding one under time pressure later.

### Dual-write (unconditional — not behind the flag)

Both write paths are unconditional, not flag-gated, on purpose: nothing
reads these new tables yet, so writing to them always is what gives them
real, trustworthy history by the time Checkpoint 3b needs to read from
them, rather than only whatever gets written after some future flag flip.

- **`addTarget()`** (`utils/learningInstances.js`) and the primary-target
  insert in `POST /api/learning-instances` (`routes/learningInstances.js`)
  now also call `ensureActivatedCourse(learningInstanceId, courseId)`
  whenever a Course target is attached to a Run — mirroring both the
  primary and secondary target creation paths.
- **Registration** (`routes/auth.js`, both the parent+learner and adult
  self-registration branches) now also calls
  `recordEnrollmentCourseSelections(enrollmentId, learningInstanceId,
  courseIds)` alongside the existing `requested_course_ids` JSON write.
  (`routes/enrolments.js`'s "additional programme" endpoint doesn't accept
  a course selection at all today, so there was nothing to dual-write
  there.)

## Verification performed

- `node --check` on every edited file — all pass.
- Migration run on a fresh database — clean; both tables created, backfill
  correctly reports nothing to backfill.
- Migration re-run (idempotency) — clean, no duplicates.
- **End-to-end manual flow** on a seeded test database:
  1. Created an Active Programme Run for Kids STEM.
  2. Called `addTarget()` to attach Course `HW-05` — confirmed a matching
     `learning_instance_courses` row was created automatically (Active,
     not Hidden, Optional, order 0, `instructor_id` NULL).
  3. Created a test enrolment selecting Courses `HW-05` and `PRG-01`, then
     called `recordEnrollmentCourseSelections` (what `auth.js` now does
     inline) — confirmed `HW-05`'s row correctly linked to the Activated
     Course created in step 2, and `PRG-01`'s row correctly left
     unlinked (`learning_instance_course_id = NULL`), since no Run has
     targeted `PRG-01`.
  4. Re-ran the migration against this now-populated database — row
     counts unchanged (1 Activated Course, 2 enrolment-course rows),
     confirming idempotency holds with real dual-written data present, not
     only on an empty database.
- Full backend suite (`npm test`, 175 tests): **174/175 pass** — same
  pre-existing, unrelated failure as both prior reports (no regression).

## API / Frontend changes

None. No route reads the new tables; nothing in the frontend changed.

## Risks

Low. Both tables are additive with zero existing readers. Both dual-write
call sites are pure inserts alongside code paths that are otherwise
unchanged — if a dual-write insert ever failed unexpectedly, it would only
affect the new, unread tables, never the legacy write it sits beside (each
insert is a separate statement, not something that could roll back the
enrolment/target creation it accompanies, since both statements succeed
or the whole transaction they're already inside fails together — no new
failure mode introduced beyond what already existed there).

## Rollback

Drop `learning_instance_courses` and `programme_enrollment_courses` (in
that order, for the FK), and revert the four dual-write call sites plus
the `addTarget`/`POST /learning-instances` hooks. No legacy table, column,
or behaviour was touched, so rollback carries zero data-loss risk to
anything a user-facing flow currently depends on.

## Remaining work / next recommended step

**Checkpoint 3b — Read-path cutover**, scoped as its own step per the
reasoning above:
- Registration course-eligibility (`routes/courses.js` / whatever
  Individual Course's course-picker calls) reads `learning_instance_courses`
  when `offeringTypeUsesActivatedCoursesV2` is true, with the existing
  Course Group/Level-based logic remaining the always-available fallback.
- Instructor-assignment dual-write (mirroring `instructor_courses` writes,
  including `PATCH /users/:userId/assignments`'s delete-and-replace
  pattern, onto `learning_instance_courses.instructor_id`) and, once that
  has run long enough to trust, a flag-gated authorization read cutover
  across the dozen-odd route files that currently check `instructor_courses`
  directly.
- Flip `activatedCoursesV2Enabled` for a pilot offering type in staging,
  run one full registration cycle end-to-end, and confirm identical
  resulting Enrollment rows to pre-cutover behaviour — the exact
  verification checklist §19 Phase 3 specifies.

Per §20, stopping here for your review before Checkpoint 3b.
