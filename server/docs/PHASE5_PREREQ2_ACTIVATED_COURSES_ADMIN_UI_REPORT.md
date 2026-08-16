# Phase 5 Prerequisite (2 of 2) — Activated Courses Admin UI + Staged Pilot Verification

Per ABRS v2.1 §19 and Appendix Item A-2, completing what Checkpoint 3b's
report named as "what's still missing before flipping the flag anywhere
real." Per §20, stopping here for your review before attempting Phase 5
itself.

## What this delivers

### Admin UI

`AdminLearningInstancesPage.jsx` → `LearningInstanceModal.jsx`'s existing
"Edit / Manage" view for a Run gets a new **Activated Courses** section
(only shown once a Run has at least one), directly below the existing
Targets section it depends on. For each Activated Course row it shows:

- **Status** (Active/Inactive)
- **Hidden** checkbox
- **Compulsory** checkbox
- **Order** (display sort order)
- **Instructor** (Run-scoped `instructor_id`) — a dropdown of instructors
  eligible for this Run's Programme (reusing the existing
  `fetchEligibleInstructors` lookup, loaded once for the whole section
  rather than per-row)

Each field saves independently on change (no separate "Save" button —
matches the pattern the Targets/period-payment sections already use),
with per-row busy/error state so one row's failed save doesn't block
others.

### Backend

- `utils/learningInstances.js`: `getActivatedCoursesForInstance(learningInstanceId)`
  (joined with Course title and instructor name) and
  `updateActivatedCourse(learningInstanceId, activatedCourseId, patch)`.
- The Learning Instance DTO now embeds `activatedCourses` (same pattern as
  the existing `targets`/`academicPeriods` arrays) — no separate fetch
  needed; every existing `GET /learning-instances`/`GET /learning-instances/:id`
  caller gets it automatically.
- New route: `PATCH /api/learning-instances/:id/activated-courses/:activatedCourseId`
  (`requirePermission("learningInstances.edit")`), validating `status`
  against the known two values and `instructorId` against a real
  instructor account, same validation posture as the existing
  operational-config endpoint.
- `routes/learningInstances.js`'s `POST/DELETE .../targets` handlers now
  also refresh `activatedCourses` in their response, since adding a
  Course target auto-creates its Activated Course row (Checkpoint 3a's
  dual-write) — the modal reflects that immediately without needing to
  reopen.

This endpoint only ever writes to `learning_instance_courses` — never
`instructor_courses`, which stays exactly what every existing
authorization check reads (verified below).

## Verification performed

- `node --check` on every edited backend file — passes.
- `npm run build` (client) — succeeds, no errors; `AdminLearningInstancesPage`'s
  bundle emits cleanly.
- Full backend suite (`npm test`, 175 tests): **174/175 pass** — same
  pre-existing, unrelated `integration-boundary.test.js` failure as every
  prior report (no regression).
- **Real server, end-to-end**, booted against a freshly seeded database:
  1. Created an Active Programme Run for Builders Lab, attached Course
     `HW-05` as a target — confirmed its auto-created Activated Course row
     appeared correctly in the instance's `activatedCourses`.
  2. `PATCH .../activated-courses/:id` with `isHidden`, `isCompulsory`,
     `sortOrder`, and `instructorId` all at once — confirmed all four
     persisted and the response returned the assigned instructor's name.
  3. Confirmed rejection of an invalid `status` value and a
     nonexistent Activated Course id (404, scoped to the right Run).
  4. **Confirmed `instructor_courses` (the legacy authorization table) had
     zero rows for that instructor after the assignment** — only
     `learning_instance_courses.instructor_id` changed.
  5. **Staged pilot** (§19 Phase 3's own exit criteria, in this sandbox —
     see caveat below): flipped `activatedCoursesV2Enabled` for `kids_stem`
     only. `GET /api/modules/open` correctly dropped both Courses (`HW-05`
     was Hidden; `PRG-01` had no Activated Course row at all, despite
     both being globally `is_open = 1`) — proving Run-scoped configuration,
     not the global flag, now governs. Un-hid `HW-05` via the new admin
     UI's endpoint — it reappeared alone. Ran a **full registration cycle**
     selecting it — succeeded, and the resulting `programme_enrollments`
     row's `requested_course_ids` (`["HW-05"]`) matched exactly what the
     legacy path would have produced, with `programme_enrollment_courses`
     additionally showing the correct normalized link to the Activated
     Course row.

## API changes

One new endpoint (`PATCH .../activated-courses/:activatedCourseId`).
Additive — the `activatedCourses` array added to the Learning Instance DTO
is a new field on an existing response, not a shape change to anything
existing consumers read.

## Frontend changes

`AdminLearningInstancesPage.jsx`, `LearningInstanceModal.jsx`,
`useAdminLearningInstances.js`, `api/admin.js`. No other page touched.

## Risks

Low. The admin UI only ever writes to `learning_instance_courses`, which
nothing reads for real behavior unless `activatedCoursesV2Enabled` is
explicitly on for that offering type (still `false` everywhere by
default — this checkpoint didn't turn it on anywhere real, only in the
disposable verification database above, which was deleted afterward).

## Important caveat on "staged pilot"

§19 Phase 3's exit criteria calls for a pilot "in staging." What's
verified above was run against a disposable local database in this
sandbox, not your actual staging environment — I don't have access to
that. The mechanics are proven (the flag-on read path, the admin UI's
effect on it, and a full registration cycle producing identical
Enrollment rows), but before treating any real offering type's flag as
safe to flip, please repeat a version of this same check (flip the flag
for one low-stakes offering type in your real staging environment, run a
real registration through it, confirm the resulting rows) — I can't
complete that step on your behalf from here.

## Rollback

Revert the seven touched files
(`utils/learningInstances.js`, `routes/learningInstances.js`,
`api/admin.js`, `useAdminLearningInstances.js`,
`AdminLearningInstancesPage.jsx`, `LearningInstanceModal.jsx`, and this
report). No schema change — `learning_instance_courses` already existed
from `v35`. Nothing this checkpoint wrote needs cleanup on rollback: the
legacy `is_open` flag and `instructor_courses` remain fully authoritative
wherever `activatedCoursesV2Enabled` is off, which is everywhere real
today.

## Where this leaves both prerequisites

1. **Participation Structure backend cutover** — done, reported, verified
   end-to-end (previous checkpoint).
2. **Activated Courses admin UI + pilot mechanics** — done, reported,
   verified end-to-end in this sandbox (this checkpoint) — **but the real
   staging pilot itself still needs to happen in your actual environment**,
   per the caveat above, before either flag is switched on for a real
   offering type.

Phase 5's own premise — "now that Phases 2–4 have proven the new tables
authoritative" — still isn't literally true yet for either initiative in
your real deployment, only in this sandbox's mechanics check. And even
once it is, Phase 5's own exit criteria (confirming **zero writes to the
legacy columns over a full monitoring window — at least one academic
term**) is an operational step that has to elapse in your real
deployment; it isn't something any coding session, including this one,
can complete on your behalf.

**What Phase 5 itself would concretely involve once that's true:**
removing the now-unused legacy inference paths (the hardcoded
`isValidParticipationStructure`/`PARTICIPATION_STRUCTURES` fallback branch
once every offering type has the V2 flag on and has been stable for a
term; the `is_open`/`instructor_courses` fallback branches in
`routes/modules.js` and the ~10 instructor-authorization route files once
Activated Courses has done the same) — and only then, as a separate,
reversible follow-up migration, dropping the legacy columns themselves.
None of that is safe to do yet.

Per §20, stopping here for your review.
