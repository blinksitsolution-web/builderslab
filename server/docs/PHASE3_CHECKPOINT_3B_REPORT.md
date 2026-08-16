# Phase 3, Checkpoint 3b — Read-Path Cutover (Registration Course Eligibility + Instructor-Assignment Mirroring)

Per ABRS v2.1 §19 Phase 3 and Appendix Item A-2 (HIGH), completing what
Checkpoint 3a's report deferred. Per §20, stopping here for review.

## What this checkpoint delivers

### 1. Registration course-eligibility read cutover (flag-gated)

`GET /api/modules/open` — the endpoint `RegisterPage.jsx`'s Individual
Course step calls to list selectable Courses — now branches on
`offeringTypeUsesActivatedCoursesV2(offeringType)` for the requesting
Programme:

- **Flag OFF (default, every offering type today):** identical to before
  — filters on `courses.is_open = 1`, byte-for-byte the same query and
  logic as pre-Checkpoint-3b. Verified: full backend suite still 174/175
  with no behaviour change.
- **Flag ON:** the global `is_open` flag is no longer consulted at all.
  Instead, a Course must have an **Active, non-Hidden**
  `learning_instance_courses` row (the Activated Course, §8/§9) for the
  learner's resolved Programme Run. This is the actual point of Appendix
  A-2 — Course availability becomes Run-scoped configuration instead of a
  single global flag.

This is a genuine behaviour change when the flag is on, not a transparent
swap, and is documented as such in the code comment at the call site: a
Course that's globally `is_open = 1` but has no Activated Course row yet
(or an Inactive/Hidden one) for the current Run will stop appearing, and
vice versa. That's intentional — it's what "Run-scoped" means — but it
does mean a Programme Run's Activated Course rows need to already reflect
the intended state before an admin flips the flag for that offering type
(see "What's still missing" below).

### 2. Instructor-assignment dual-write

Both places `instructor_courses` gets written
(`POST /api/users` instructor creation, `PATCH /api/users/:userId/assignments`
replace-all) now also call `syncActivatedCourseInstructor(instructorId,
courseIds)`, which:

- Mirrors the instructor onto `learning_instance_courses.instructor_id`
  for any Course they're assigned to that has **exactly one** Active
  Activated Course row (same "never guess" posture as Checkpoint 3a's
  backfill — if a Course is targeted by more than one active Run at once,
  no mirror is written for it).
- **Clears** the mirror on any Activated Course row previously pointing at
  that instructor for a Course no longer in their assignment set —
  correctly handling `PATCH /assignments`' delete-and-replace-all pattern,
  which was exactly the complication that made this unsafe to bundle into
  Checkpoint 3a.

This is unconditional (not flag-gated) and purely additive: `instructor_courses`
itself, and every one of the ~10 route files that read it for
authorization, are completely untouched. This checkpoint deliberately does
**not** cut over any instructor-authorization read path — see "Deferred"
below.

## Verification performed

- `node --check` on every edited file — passes.
- Full backend suite (`npm test`, 175 tests): **174/175 pass** (same
  pre-existing, unrelated `integration-boundary.test.js` failure as every
  prior report) — confirms zero regression with the flag at its default
  (off) state.
- **End-to-end manual verification**, real server booted against a seeded
  test database (not just unit-level function calls):
  1. Created an Active Programme Run for Kids STEM; attached Courses
     `HW-05` and `PRG-01` via `addTarget()` (auto-creating their Activated
     Course rows via Checkpoint 3a's dual-write).
  2. Set `HW-05.is_open = 0` globally but left its Activated Course
     `status = 'active'`. Set `PRG-01`'s Activated Course row to
     `status = 'inactive'` but left `PRG-01.is_open = 1` globally — a
     deliberate contradiction between the two systems, to prove which one
     actually governs in each mode.
  3. **Flag OFF:** `GET /api/modules/open?programmeId=...` returned only
     `PRG-01` — exactly the legacy `is_open`-based answer, confirming the
     default path is untouched.
  4. **Flag ON** (flipped for the Kids STEM offering type only): the same
     request returned only `HW-05` — confirming the Activated Course
     table, not the global flag, now governs, in both directions (a
     globally-closed-but-Activated Course appears; a
     globally-open-but-deactivated one doesn't).
  5. Instructor sync: assigned a test instructor to `HW-05` (one active
     Activated Course row) and `PRG-01` (Activated Course row exists but
     `inactive`) — confirmed `HW-05`'s row got the mirror and `PRG-01`'s
     correctly did not (not Active, so not "unambiguous active"). Then
     reassigned the same instructor to `PRG-01` only — confirmed
     `HW-05`'s mirror was correctly cleared.

## API / Frontend changes

None. `GET /api/modules/open`'s response shape is unchanged — only which
rows it returns can differ, and only for an offering type that has
explicitly opted in. No frontend code was touched; `RegisterPage.jsx`
keeps calling the same endpoint the same way.

## Risks

Low for the default (flag-off) state — verified byte-identical to
pre-checkpoint behaviour. **Moderate, deliberate risk for any offering
type an admin opts in**, clearly called out in-code and here: flipping
`activatedCoursesV2Enabled` before an offering type's Activated Course
rows have been reviewed/curated could change which Courses appear at
registration in a way that doesn't match today's `is_open`-based state —
because right now every Activated Course row is whatever Checkpoint 3a's
backfill/dual-write auto-created (all defaulted to Active), not yet
admin-reviewed. This is exactly why the flag defaults off per offering
type and why §19 Phase 3's own exit criteria calls for a staged, verified
flip rather than a blanket rollout.

Instructor-sync risk is low and one-directional: it only ever writes to
the new, still-unread-for-authorization `instructor_id` column; nothing
that currently gates access (`instructor_courses`) is touched.

## Rollback

Revert the four touched files
(`utils/learningInstances.js`, `routes/users.js`, `routes/modules.js`, and
this checkpoint's report). No schema change in this checkpoint — the
tables already existed from `v35`. Any offering type with the flag
switched on can simply have it switched back off; nothing it wrote to
`learning_instance_courses` needs cleanup, since the legacy tables/columns
were never touched and remain fully authoritative whenever the flag is
off.

## What's still missing before flipping the flag anywhere real

There is currently **no admin UI** to review or adjust an Activated
Course's `status`/`is_hidden`/`is_compulsory`/`sort_order`/`instructor_id`
— every row that exists today came from the automatic dual-write default
(Active, not Hidden, Optional, order 0, no instructor). An admin flipping
`activatedCoursesV2Enabled` for a real offering type today would be
opting that Programme's registration into "every Course any Run has ever
targeted, with no per-Run curation" rather than a deliberately reviewed
set. Building that admin UI is recommended as the next piece of work
before any real (non-test) offering type adopts this — separate from, and
smaller than, anything in Checkpoint 3a/3b, since the tables and resolver
functions it would sit on top of already exist now.

## Deferred (unchanged from the Checkpoint 3a report)

Instructor-**authorization** read cutover (the ~10 route files —
attendance, notes, exams, assignments, messages, continuous assessments,
curriculum access — that check `instructor_courses` directly) remains
out of scope. The dual-write landed in this checkpoint is what makes that
cutover *safe to attempt later*: by the time it's undertaken,
`learning_instance_courses.instructor_id` will already hold real,
continuously-synced history to verify against, rather than starting from
nothing.

## Recommended next steps (not further phases — operational/product work)

1. Admin UI for reviewing/editing Activated Course rows (status, Hidden,
   Compulsory, order, Run-scoped instructor) — makes flipping the flag for
   a real offering type a deliberate, informed action instead of "accept
   whatever the dual-write auto-created."
2. Once that exists: pilot `activatedCoursesV2Enabled = true` on a single
   low-stakes offering type in staging, per §19 Phase 3's exit criteria —
   run one full registration cycle end-to-end and confirm identical
   resulting Enrollment rows to what the legacy path would have produced.
3. Only after that: consider the instructor-authorization read cutover,
   informed by whatever the dual-write's accumulated data shows about how
   often the "ambiguous, more than one active Run" case the sync function
   currently skips actually occurs in real data.

Per §20, stopping here for your review.
