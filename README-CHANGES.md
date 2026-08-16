# What changed in this codebase

This file documents every fix and feature added across our work together.
This zip is the **complete, current project** (not a diff) — every file,
updated in place. See `README.md` for setup/deployment instructions specific
to this delivery; this file is the detailed changelog.

Everything below was verified against a copy of your actual database and,
for backend routes, over real HTTP with your real instructor/learner
accounts and data.

## The two bugs you reported

### 1. Instructor doesn't see the learner in "My Learners"
**File:** `server/src/routes/users.js`

Your instructor's assignment is scoped to a specific campus
(Woodbridge International School). The learner-listing query had an extra
filter meant to narrow results to that campus, but it compared
`users.campus` (a text name, e.g. `"Woodbridge International School"`)
against the instructor's `campus_id` (a UUID). Those can never match, so
it silently removed every correctly-assigned learner from the list — for
any instructor whose assignment names a specific campus, which is the
normal case, not an edge case. Fixed by resolving the campus id to its
name before comparing (the same approach your messaging/notes code
already uses elsewhere).

### 2. Notes/assignments never reach the learner
**Files:** `client/src/pages/learner/useLearnerNotes.js`,
`client/src/pages/learner/NotesAndAssignmentsPage.jsx`

A note's course reference is stored as `course_id`. The learner-facing
code was filtering on `n.module_id` — a property that doesn't exist on a
note — so the relevant-notes list was always empty, for every learner,
regardless of correct targeting. The same wrong field was also being
passed to the "Mark as read" action, which made that silently fail with
"This learner isn't enrolled in this module."

## Six more instances of the identical mistake

While tracing "notes or anything," I found the same `module_id`-instead-
of-`course_id` bug repeated in six other screens. All were confirmed
against your actual table schemas before fixing, and none affect payment,
enrollment, or authorization logic — only display and filtering:

- `client/src/pages/instructor/useInstructorContinuousAssessments.js` —
  the note-picker for attaching a Continuous Assessment was always empty;
  instructors could not attach a CA to any note.
- `client/src/pages/instructor/InstructorNotesPage.jsx` — the "Edit
  note" Course dropdown never showed the note's actual current course;
  the note card's module badge was blank.
- `client/src/pages/instructor/useInstructorGrading.js` +
  `InstructorGradingPage.jsx` — the "Filter by module" control on Grade
  Projects always emptied the list instead of narrowing it; the module
  label on each submission was blank.
- `client/src/pages/parent/ParentContinuousAssessmentsPage.jsx` — the
  Module column on a ward's CA results was always blank.
- `client/src/pages/parent/ParentProgressPage.jsx` — the Module column
  on a ward's attendance history, and the module label on each project
  submission, were always blank.

## 3. Examination (and Continuous Assessment, and Notes) creation can
   reject a Run the instructor was correctly offered

**Files:** `server/src/utils/learningInstances.js`,
`server/src/routes/exams.js`, `server/src/routes/continuousAssessments.js`,
`server/src/routes/notes.js`

This one is a different bug from the `module_id` mistake above, and it's
live in your actual data right now. Your active Learning Instance
("Padua September 2026") is a **Programme-wide Run** — it isn't locked to
one course; it's linked to each of its courses (PRG-01, etc.) through a
separate `learning_instance_targets` table. The "which Run?" dropdown an
instructor sees when authoring a Note, Examination, or Continuous
Assessment correctly reads that table and offers this Run as a valid
choice. But the check that runs when the instructor actually **submits**
only compared the Run's own `course_id` column directly — which is `NULL`
for a Programme-wide Run — so it rejected the exact Run its own dropdown
had just offered, with `"learningInstanceId does not belong to this
module."` I confirmed this by creating a real examination for your real
course/Run and getting that exact error.

Fixed by adding `instanceTargetsCourse()`, which checks the same
`learning_instance_targets` table the dropdown already trusts, and using
it everywhere the old direct-column check was — so the two now always
agree. This is purely additive (it only recognizes MORE valid Runs than
before; it can never accept a Run it shouldn't), which I confirmed by
also testing that a genuinely unrelated/fake Run id is still correctly
rejected.

## Verification performed

- Reproduced the exact backend query and the exact frontend filter logic
  against a copy of your real database (instructor, learner, learning
  instance, enrollment, note — all your actual records).
- Booted a full copy of your server and hit the real endpoints over HTTP
  with real logins: confirmed `GET /api/users?role=learner` now returns
  the learner, confirmed the note now passes every filter condition the
  learner's browser will apply, and confirmed the "Mark as read" call
  that used to 403 now returns `200`.
- Created a real examination for your real course and Learning Instance
  over HTTP — confirmed it now succeeds (was failing before), and
  confirmed the learner's own exam list now returns it, with the answer
  key correctly stripped. Did the same for a Continuous Assessment and a
  Note created with an explicit Run pick.
- Confirmed a fabricated/unrelated Run id is still correctly rejected
  (the fix doesn't loosen anything, only closes the gap between what the
  picker offers and what submission accepts).
- Confirmed the learner→instructor Messages path (which was already
  working) still works — no regression there.
- Ran your full automated test suite (`npm test` in `server/`) twice —
  once after the first two fixes, once after all of them: **210 of 211
  tests pass** both times. The one failure
  (`integration-boundary.test.js` — static-file boundary) is pre-existing
  and unrelated: it expects a legacy `index.html` at the project root
  that isn't present in this export/backup at all. I confirmed it fails
  identically on your completely unmodified upload, before any of my
  changes.
- Ran a full client production build (`npm run build`) — no errors.

## How to deploy this

This zip is the complete project — see `README.md` at the top level for
full setup steps. In short: `npm install` in both `client/` and `server/`,
put your real `server/data/builderslab.db` and `server/.env` back in place
(both were deliberately left out of this delivery — see `README.md`),
then **run the migration** (`node server/src/db/migrate.js` from inside
`server/`) before starting the server. Two features here add new columns —
Combined Registration + First Period Payment
(`learning_instances.combine_registration_with_first_period`) and the
instructor-portal filtering work below (`continuous_assessments.class_id`)
— both additive and default to off/empty, so the migration is safe to run
against your live database; every existing Run and every existing
Continuous Assessment keeps behaving exactly as it does today.

No other database changes were made or are needed — your data was
correct the whole time; the bugs were entirely in how the app read and
validated it.

---

## Feature: Combined Registration + First Period Payment

**What it does:** a new per-Run admin setting (in the Learning Instance
editor, alongside Registration Fee) called "Combine registration with
first period payment." Off (default) is exactly today's behaviour:
Registration Fee first, then each academic period's own fee separately.
On: self-registration charges **only** the current/first period's own fee
— no separate Registration Fee at all — and that one payment both
completes registration and immediately unlocks that period's content.
Confirmed with you: no sibling/multi-child discount applies to this
charge, since it's the period fee itself, not the discountable
Registration Fee product.

**Where it applies:** self-registration (parent + one or more children,
and an individual/adult learner paying for themselves). Deliberately
**out of scope** for this pass: sponsor-funded bulk registration and
admin-driven additional-programme enrolment — both are materially
different flows with their own payment semantics, and combining them
wasn't asked for.

**How it works under the hood:** your codebase already had a mechanism
for "a period payment, if it's the very first successful payment on an
account, completes registration as a side effect" — built as a recovery
safety net for failed registration attempts. This feature reuses that
mechanism deliberately rather than adding new activation logic, which
keeps the actual account-activation code path untouched. The only new
pieces are: (1) `resolveCombinedPeriodCharge()` in
`utils/learningInstances.js`, the single place that decides whether a
Run's registration charge should be replaced by its current period's
amount; (2) `registrationBreakdown()` in `utils/fees.js` (which drives
both the price a parent sees on the sign-up form and the real charge)
consulting it; and (3) the resulting payment being correctly tagged with
that period's id so payment-status checks recognize it.

**A bug I found and fixed while testing this, before shipping it:** the
single-account payment path (an individual/adult learner paying for their
own registration) initially left the payment's `type` as `'registration'`
while also tagging it with the period id. `activateSuccessfulPayment`
marks a payment `'successful'` *before* checking "has this account ever
had a successful registration payment" to decide whether to activate
it — so that row satisfied its own precondition, and the account was
never actually activated despite the charge succeeding. I traced this by
actually running an adult-style self-payment end to end and watching the
account stay `pending_payment`, not by inspecting code alone. Fixed by
storing this kind of payment as `'period_payment'` instead — which also
turned out to be the more honest label for admin financial reporting, so
purchase records don't show a Registration Fee being collected when none
was.

**Verification performed**, all against your real "Padua September 2026"
Run (semester-structured, GHS 500 Registration Fee, Semester 1 already
configured at GHS 500):
- Toggled the setting on/off via the real admin endpoint.
- Confirmed the public fee preview (the same one shown on your sign-up
  form) correctly switches between "GHS 500 registration fee" and
  "GHS 500, tagged to Semester 1" depending on the setting.
- Ran a real parent + one child registration and payment through combined
  mode: one payment, correctly tagged to Semester 1, account activated,
  content immediately accessible (tested against the real lessons
  endpoint, not a simulated check).
- Ran a real parent + **two** children registration in combined mode: one
  combined charge, correctly split so **both** children ended up
  individually activated and both individually able to access content.
- Ran the single-account (self-pay) path in combined mode: caught the bug
  above, fixed it, then re-ran and confirmed activation and content
  access both work.
- Full regression: with the setting off, confirmed the exact same Run
  behaves byte-for-byte as before — Registration Fee charged separately,
  account activated but content correctly *blocked* until the period fee
  is paid on its own, then unblocked once it is.
- Ran your full automated test suite: **210 of 211 pass**, same single
  pre-existing unrelated failure as before, zero failures among every
  payment/fee/registration/period-named test.

---

## Feature: Instructor portal — Run/Class/Campus filtering consistency

You asked me to check whether Notes & Assignments, Monthly Topics,
Attendance, Grade Project, Messages, Examinations, and Continuous
Assessment let an instructor pick which Run, Class, and Campus they're
working with (for instructors assigned to more than one of each), and
fix whatever was missing — with instructors only ever seeing their own
assigned values.

**One clarification on terminology first:** there's no separate "learner
group" concept apart from Class in your data model — your own code
comments confirm a Kids STEM "Foundation" class and a Bootcamp "Weekday"
cohort are the same kind of row. So "learner group" and "level/class" in
your request are the same filter; I built one Class dimension, not two.
Campus also isn't independently pickable everywhere — once an instructor
picks a Run + Class, their assignment already determines the campus, so
on Topics/Attendance/Grading/Examinations/CA it's shown as a read-only
confirmation next to the pickers rather than a 3rd dropdown. Notes and
Messages keep an independent Campus picker, since there it's genuinely a
choice (who receives the note/broadcast), not a statement of where the
instructor is teaching from.

**What was already working, unmodified:** Notes & Assignments (Run +
Class) and Messages broadcast (Run + Class + Campus) already had these
pickers.

**Bug fixed, not just a missing feature — the campus-scope leak:** Notes
and Messages (and, as a bonus, "My Learners" too, which shares the same
function) were showing *every* campus in your entire organization in
their Campus dropdown, not just the instructor's own. Added a properly
-scoped `/api/modules/campuses/mine` endpoint and repointed all three at
it.

**Bug fixed, not just a missing feature — the Attendance roster was never
actually scoped by course:** the roster fetch was sending `moduleId` as
a query key, but the backend reads `courseId`; an unrecognised key is
silently ignored, so every instructor was seeing their full learner list
across every course they teach, regardless of which course was selected
in the "Course" dropdown at the top of the page. Fixed, and verified with
a real course-id-that-doesn't-exist test that the roster now genuinely
comes back empty rather than "everything."

**Genuinely new, built from scratch — Monthly Topics:** had no Run or
Class scoping at all, on either the creation form or the list view — an
instructor teaching the same course to two classes saw both classes'
topics mixed together with no way to tell them apart. Backend now
validates an explicit Run/Class on creation (same trusted pattern Notes
already used) and the list can be filtered by both.

**Extended with Class + Run filtering:** Attendance, Grade Project (a
project has no class of its own — it filters by the *submitting
learner's* class instead), and Examinations (the database already had a
`class_id` column here; the dropdown to actually use it was the missing
piece).

**The one real schema change — Continuous Assessment:** unlike
Examinations, this table had no class column at all. Added
`continuous_assessments.class_id` via migration and wired it through
exactly the same validated-creation and list-filtering pattern as
Examinations, so the two are now consistent.

**Verification performed**, all against your real database with a real
instructor account temporarily given a second class assignment
(Foundation + Framework) so I could actually exercise "assigned to more
than one":
- Confirmed the instructor's own scoped Class and Campus lists return
  exactly their assignments, nothing org-wide.
- Monthly Topics: created one topic scoped to each class plus one
  unscoped ("applies to all") topic, then confirmed filtering by each
  class correctly shows that class's topic *and* the general one, never
  the other class's topic.
- Attendance: confirmed the roster is now genuinely narrowed by course
  (a nonexistent course id correctly returns zero learners) and correctly
  narrows further by class.
- Grade Project: confirmed submissions come back tagged with the
  submitting learner's own class for filtering.
- Examinations: created one exam per class, confirmed each filter shows
  only that class's exam.
- Continuous Assessment: created one CA per class attached to the same
  note, confirmed each filter shows only that class's CA — the new
  schema column working end to end, not just accepted and ignored.
- Security check: confirmed creating a Topic or Continuous Assessment for
  a class the instructor is genuinely **not** assigned to is correctly
  rejected with a 403, on both the new endpoints — the scoping is
  enforced, not just cosmetic.
- Ran your full automated test suite: **210 of 211 pass**, same single
  pre-existing unrelated failure as before, zero regressions.

**Out of scope for this pass**, worth knowing about: Examinations'
`class_id` (which already existed before this work) isn't actually
enforced on the *learner-facing* side — a learner enrolled in the course
sees every non-retake exam regardless of class. That's a pre-existing
characteristic of Examinations I matched Continuous Assessment to for
consistency, rather than a gap I introduced — but it's a related, real
gap you may want addressed separately if class-restricted exams matter
to you.

## Combined Registration + First Period Payment had the relationship backwards

**Files:** `server/src/utils/learningInstances.js`, `server/src/utils/fees.js`,
`server/src/utils/periodPayments.js`, `server/src/routes/payments.js`,
`server/src/routes/learningInstances.js`,
`client/src/pages/admin/LearningInstanceModal.jsx`,
`server/test/operational-config-migration-regression.test.js`

The `combineRegistrationWithFirstPeriod` setting is supposed to make the
Registration Fee itself satisfy the first Academic Period's (Term 1 /
Semester 1) payment obligation. The existing implementation had this
backwards: when the flag was ON, it charged the learner Term 1's own
*independently-configured* amount instead of the Registration Fee, and
only worked at all once an admin had separately configured that Term 1
amount — creating exactly the "two competing definitions of the same
obligation" state the corrected business rule prohibits. An existing
regression test had this wrong behavior baked in as the expected result.

Access control had the matching gap: it only ever read a period's own
stored `payment_mode`/`required_amount_ghs` columns, so an inherited
Term 1 requirement (which by design must never be independently stored)
was invisible to the payment-status/access checks.

Fixed by:
- `resolveCombinedPeriodCharge` now resolves the actual first period
  (sequence 1, not whichever period today's date happens to fall into)
  and returns the Registration Fee as its requirement — never the
  reverse.
- New `isCombinedFirstPeriod` / `getEffectivePeriodPaymentRequirement`
  helpers so every consumer (payment charging, payment status, access
  control, the admin manual-payment guard) resolves the same inherited
  requirement instead of each reading the period row directly.
- `setPeriodPaymentRequirement` now rejects an admin trying to
  independently configure Term 1's payment while combine is ON.
- The admin UI now shows Term 1 as read-only/inherited from the
  Registration Fee whenever combine is ON, instead of an editable field.
- Sponsor/bulk registration needed no separate fix — it already shares
  the same `registrationBreakdown` pricing path, so it inherited the
  correction automatically.

Also found and fixed, while verifying the "combine OFF" path still
worked: `registrationBreakdown()` was destructuring
`const { amount } = applyLegacyRegistrationAdjustments(...)`, but that
function returns a plain number, not an object — so `amount` silently
came back `undefined` for every ordinary (non-combined) registration
charge. This was a real, unrelated pre-existing bug; fixed to
`const amount = applyLegacyRegistrationAdjustments(...)`.

**Verification performed:**
- Rewrote the two existing tests that had encoded the old, wrong
  behavior as correct, and added a new test asserting the API rejects
  an independently-configured Term 1 amount while combine is ON.
- Ran the full automated test suite: **259 of 260 pass** — the one
  failure (`integration-boundary.test.js`, the legacy static-HTML
  boundary check) is a pre-existing environment artifact of this
  delivered snapshot (the legacy `index.html`/etc. files it checks for
  aren't present at the project root here), unrelated to this change.
- Ran the client build (`npm run build`): succeeds cleanly.

**Out of scope for this pass, worth knowing about:** a data
migration/backfill for any existing Learning Instances that may already
be sitting in the old invalid state (combine ON with an independently
configured Term 1 amount) wasn't attempted — doing that safely needs a
look at your actual production data first rather than a guess at what
"the correct migration behavior" should silently do to real money
amounts already on real accounts.

### Follow-up: the migration/backfill above is now done

Added to `server/src/db/migrate.js` (runs automatically on every
`node src/db/migrate.js`, including your normal deploy/startup path):
for every Learning Instance with combine ON, if its first academic
period still has an independently configured `payment_mode`/
`required_amount_ghs` left over from the old buggy behavior, those two
columns are cleared (`NULL`) so the corrected code derives that period's
requirement from the Registration Fee going forward, as the business
rule requires. Nothing else is touched:
- combine-OFF Runs are completely untouched, including any of their own
  independently configured Term 1 amounts — those stay authoritative.
- Term 2/Semester 2 and later periods are never touched, on any Run,
  regardless of the combine setting.
- No payment history is rewritten — a learner who already paid under the
  old (buggy) charge amount keeps that payment exactly as recorded; only
  the now-invalid independent *requirement* configuration is cleared.

Verified against a database seeded to reproduce the exact pre-fix
invalid state (a combine-ON Run with an independently configured Term 1
amount, alongside a combine-OFF sibling Run with its own legitimate
Term 1 amount as a control): the backfill clears only the invalid row,
leaves everything else byte-for-byte unchanged, and running
`migrate.js` again afterward is confirmed to be a no-op (deterministic
and idempotent, per §10 of the business rule). Added as a permanent
automated test
(`operational-config-migration-regression.test.js`, "combine ON
correction backfill…") so this stays covered going forward — full
suite re-run afterward: still 259 of 260 (same one pre-existing,
unrelated environment failure), plus this one new passing test.

## Individual Course registration: "learningInstanceId is required" on the final Pay & Create Account step

**File:** `client/src/pages/auth/RegisterPage.jsx`

Confirmed root cause: `handleParentProgrammeChange` (and its adult
equivalent, `handleAdultProgrammeChange`) reset
`parentSelectedInstanceId`/`adultSelectedInstanceId` to `""` on every
programme change, and the only place that ever set it back was
`handleParentInstanceChoice`/`handleAdultInstanceChoice` — the handler
behind the "which run/cohort?" picker, which only renders when
`registration-config` reports `multipleActiveRuns: true`. When a
Programme has exactly one Active Learning Instance (the normal case),
that picker never renders, so `...SelectedInstanceId` stayed `""` for
the rest of the flow. The final registration request then sent
`learningInstanceId: parentSelectedInstanceId || undefined` — i.e.
`undefined` — and the backend correctly rejected the Individual Course
registration with "learningInstanceId is required for Individual Course
registration.". The backend was never the problem; the config response
already carried `instanceId` for the one-Run case, the frontend just
never copied it into state.

Fixed by copying `runConfig.instanceId` into
`parentSelectedInstanceId`/`adultSelectedInstanceId` as soon as
`fetchRegistrationConfigFor` resolves with `hasActiveRun: true` —
whether that's the exactly-one-Run case (immediately, on programme
selection) or the picked-from-multiple-Runs case (already worked, now
just reached via the same assignment instead of only the picker's own
handler). The `multipleActiveRuns` response shape carries no
`instanceId`, so that case still correctly resets to `""` and still
requires the picker, exactly as before. No backend change, no
architecture change — the fix is entirely "propagate a value the
response already contained."

**Verification performed:** traced every call site of
`parentSelectedInstanceId`/`adultSelectedInstanceId` and every response
shape `registration-config` can return (single Run, zero Runs, multiple
Runs, and the defensive multi-Run recovery path after a 409 mid-submit)
to confirm each is still handled correctly. Client build (`npm run
build`) succeeds. No client-side component test harness exists in this
project (no React Testing Library/jsdom wired up — `client/package.json`
has only `dev`/`build`/`preview`), so this couldn't be covered by an
automated test without introducing new test tooling, which felt out of
scope for a targeted state-propagation fix; re-ran the backend
individual-course/structured-curriculum test suites to confirm the
server side (already correct, untouched) still passes.
