# Registration Experience Redesign — Checkpoint 3

## Summary

Brought the self-registration flow into compliance with the constitutional
requirement that registration be driven entirely by Programme Runs, with
no fallback path, and that it progressively disclose only what's currently
relevant — without redesigning the architecture, introducing new entities,
or discarding the existing (tested) multi-step account-creation/payment
machinery.

Two real defects were found and fixed along the way, both pre-dating this
checkpoint:

1. **A Single Ownership gap** between the read/listing path and the write
   path for "is registration open." The write path (`POST /api/auth/
   register`) always correctly required an Active Programme Run to exist.
   The read path (`GET /programmes`, `/programmes/public`) did not — a
   Programme with zero Active Runs could still show `registrationOpen:
   true` via legacy Programme-level date columns, because nothing in that
   fallback branch checked whether a Run existed at all. Fixed at the
   source (`resolveProgrammeRegistrationOpen`), not patched per-caller.
2. **Course-selection requirement was decided per Offering Type, not per
   Participation Structure.** §10.2 requires only "Individual Course" to
   require course selection; the frontend instead read a single static
   flag off the whole Offering Type, unable to distinguish it from the two
   structured journeys. Fixed by exposing each Programme's own configured
   Participation Structures (with their own flags) to the registration
   frontend and having it defer to the resolved structure.

## Files modified

**Backend**
- `server/src/utils/learningInstances.js` — fixed `resolveProgrammeRegistrationOpen`; added `getEffectiveProgrammeParticipationStructures()` and `resolveEntryLevelForProgramme()` (both read-only).
- `server/src/routes/learningOfferings.js` — `/programmes/public` no longer requires `offeringTypeId`/`offeringTypeSlug`; `/programme-runs/registration-config` now additionally returns `participationStructureOptions` and `entryLevel`.
- `server/test/registration-window-and-instructor-assignment.test.js` — updated one assertion's expected error-message regex (see "Test changes" below); no behavioral loosening.
- `server/src/data/lessons.js` — restored (was missing from the checkpoint-2 ZIP entirely; supplied by you).

**Frontend**
- `client/src/pages/auth/RegisterPage.jsx` — Participation Structure now resolves from config before Delivery Mode/Class, auto-selects when only one option exists, and — when the resolved structure `usesProgrammeLevels` — hides the Batch/Cohort picker entirely, sends no `classId`, and shows an informational "will begin at {entry level}" note instead.

## Database changes

None. No schema/migration changes — every field added is a computed value derived from existing tables (`classes`, the Participation Structure config tables from Checkpoint 2, `learning_instances`).

## Backend changes (detail)

- `resolveProgrammeRegistrationOpen`: no Active Programme Run → `false`, unconditionally. The legacy Programme-level columns are still consulted, but *only* when an Active Run exists and hasn't configured its own window — i.e., they now act as that Run's own default, never as a substitute for the Run's existence. No other call site changed; every consumer (payments, enrolments, admin views) gets the corrected answer automatically.
- `/programmes/public`: `offeringTypeId`/`offeringTypeSlug` are now optional. Omitting both returns every currently self-registrable, registration-open Programme across every active Offering Type — the actual "Choose Programme" data source the redesigned experience needs. Every existing caller passing one of the two filters is unaffected. Each returned row now also carries `offeringTypeId/Name/Slug`.
- `/programme-runs/registration-config`: added, additively:
  - `participationStructureOptions` — this Programme's own configured Participation Structures (or, read-only, the legacy three synthesized from `participationStructureMetadata.js` if none are configured yet), each with `usesProgrammeLevels`, `requiresCourseSelection`, `registrantRole`, `usesLongTermEnrollment`, `autoAssignsEntryLevel`.
  - `entryLevel` — `{ classId, className }` for the Programme Level a structured learner would be auto-assigned into, informational only.
  - The pre-existing `participationStructures` (bare key array) field is untouched — one existing test asserts its exact shape.

## Frontend changes (detail)

- New derived state: `parentParticipationOptions`, `parentSelectedStructure`, `parentStructureRequiresCourseSelection`, `parentUsesProgrammeLevels`, `parentEntryLevelName`.
- Participation Structure picker moved earlier in the form and now renders from `participationStructureOptions`; auto-selects via effect when there's exactly one; doesn't render at all when there's nothing to choose.
- Batch/Cohort ("Class") picker: unchanged for non-programme-level flows (still auto-selects when exactly one option, per the pre-existing effect); now hidden entirely when the resolved structure `usesProgrammeLevels`, replaced with an info alert naming the auto-assigned entry level.
- Both places `classId` is sent (fee-preview payload, actual submit payload) now omit it whenever `usesProgrammeLevels` — backend already auto-resolves via `resolveEntryClass` when `classId` is absent (pre-existing, unchanged backend behavior confirmed by `enrollment-activation.test.js` and others).
- `participationStructure` is now sent for every resolved structure, not only ones requiring course selection.
- Delivery Mode, Campus, and single-Programme auto-selection were **already** correctly progressive-disclosure (auto-select-when-singular, hide-when-Online) prior to this checkpoint — confirmed by reading, left untouched.

## Test changes

`registration-window-and-instructor-assignment.test.js`, scenario 1 ("no Programme-level dates, no Run at all yet"): the expected error message regex was widened from matching only `/no available registration opportunities/i` to `/no available registration opportunities|registration.*closed/i`. Reason: with the Single-Ownership fix, `resolveProgrammeRegistrationOpen` itself now also returns `false` with no Active Run, so the `classId`-branch's own registration-window check (which runs earlier in the request handler) now correctly fires first with its generic "currently closed" message, rather than falling through to the dedicated no-active-run check further down. Both are 409s; both are correct; the test now accepts either wording. The `programmeId`-only path (no `classId`) still exercises — and the test still asserts verbatim — the dedicated "no available registration opportunities" message.

## Verification

- **Targeted, run repeatedly during implementation:** `registration-window-and-instructor-assignment.test.js`, `builderslab-architecture.test.js`, `participation-structure-administration.test.js`, `country-registration.test.js`, `delivery-mode-registration.test.js`, `period-target-registration.test.js`, `town-registration.test.js`, `card-payment.test.js`, `card-payment-webhook.test.js`, `enrollment-activation.test.js` — all passing throughout.
- **Full backend suite** (`npm test`, run once at completion, per your instructions): **195/196 passing.**
  - The 1 failure (`integration-boundary.test.js`, static-file boundary test) expects `/index.html` to be served. Confirmed by direct filesystem check that `index.html`, `dashboard.html`, `login.html`, `register.html`, `reset-password.html`, `cms.html`, `style.css`, and `api.js` are **entirely absent from the project root in this ZIP** — the same class of packaging gap as `server/src/data/lessons.js` from Checkpoint 2, not a regression from this checkpoint's work. Confirmed unrelated: these are legacy static pages served directly from disk by `server.js`, never touched by any file this checkpoint modified.
- **Full client build** (`npm run build`, run once at completion): clean, zero warnings/errors.

## Risks

- The `/index.html`-and-siblings gap above means the *legacy* static frontend (pre-React pages) cannot currently be verified or served at all in this environment. If Dalijay Tech Hub still relies on any of those pages (as opposed to the React app at `/app`), they need to be supplied the same way `lessons.js` was.
- `getEffectiveProgrammeParticipationStructures`'s legacy-fallback branch (for a Programme with zero admin-configured Participation Structure rows) is read-only by design and was not exercised end-to-end against a real "never-migrated" Programme in this checkpoint's tests — worth a dedicated test if such Programmes still exist in production data.
- I did not extend the `usesProgrammeLevels`/config-driven treatment to the Adult tab's Batch/Cohort picker (it has no Participation-Structure concept currently and none of today's data would trigger the gap there) — flagged as latent, not fixed, consistent with today's actual data shape.

## Remaining work

- Corporate learners' "configured workflow" mentioned in your brief — I did not find a distinct Corporate registration path in `RegisterPage.jsx` to redesign; if Corporate registration happens through the Adult tab today, no changes were needed there beyond what's already in place. If Corporate has its own intended flow, point me at it.
- Course/Campus auto-discovery for `requiresCourseSelection` structures (Step 2's module list) was verified as already correctly Run-gated and config-driven (`GET /modules/open`) — no changes needed, but not deeply re-tested against the new Participation-Structure-driven `willSkipModuleStep` gating beyond the existing test suite.
- Legacy static frontend gap (see Risks) needs your input the same way `lessons.js` did.

## Deliverable

`builderslab_admin_workflow_checkpoint3.zip` — attached.
