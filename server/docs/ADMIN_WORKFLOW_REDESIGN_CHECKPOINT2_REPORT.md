# Admin Workflow Redesign — Checkpoint 2 Report

**Scope of this checkpoint:** Parts 1–3 of the "Continue from the previous
checkpoint" prompt (Programme Definition, Participation Structure
Administration, Programme Levels terminology). **Part 4 (Operational
Groups) was dropped at the user's direction** after being flagged as a
Section 11.4 / Appendix A-3 constitutional conflict (new architectural
layer + reserved vocabulary) — see the conversation for the full
objection. It was not designed, scaffolded, or partially implemented
anywhere in this checkpoint.

Registration, Publish Readiness, Enrollment, Promotion, Reporting,
Certificates, and Finance were untouched, per this checkpoint's own
"strictly out of scope" list.

## Summary

- **Part 1 — Programme Definition status.** A new, purely informational
  `programmeDefinitionStatus` (Offering Type → Programme → Course Library
  → Participation Structure Definitions → Programme Levels-if-applicable)
  is computed server-side and shown in a new checklist panel inside the
  Edit Programme modal. It never blocks or alters Programme Run creation.
- **Part 2 — Participation Structure Administration.** Full admin CRUD
  (Create/Edit/Activate/Deactivate/Retire) for
  `programme_participation_structures`, Programme-scoped, via a new modal
  opened from the Programmes table — the missing admin surface flagged as
  a gap since Phase 2/4.
- **Part 3 — Programme Levels terminology.** Where a Programme's own
  Participation Structure configuration says it uses progression
  (`usesProgrammeLevels`), the admin UI now consistently calls the
  existing Batches/Cohorts screen "Programme Levels" instead. Where it
  doesn't apply, nothing changed. This is a label fix only — the
  underlying `classes` table and its dual role (per Appendix A-3) are
  untouched, as instructed.

## Files modified

| File | Why |
|---|---|
| `server/src/db/migrate.js` | v37: additive `retired_at` column on `programme_participation_structures`, needed to distinguish reversible Deactivate from terminal Retire. |
| `server/src/routes/learningOfferings.js` | `computeProgrammeDefinitionStatus()`, `programmeUsesProgrammeLevels()`; extended `GET /programmes` and `GET /programmes/:id`; new admin CRUD routes for Participation Structures. |
| `client/src/api/admin.js` | New client functions for the Participation Structure admin CRUD routes. |
| `client/src/pages/admin/ParticipationStructuresModal.jsx` | **New.** Part 2's admin UI. |
| `client/src/pages/admin/ProgrammeDefinitionStatus.jsx` | **New.** Part 1's checklist panel. |
| `client/src/pages/admin/ProgrammeModal.jsx` | Renders the new checklist panel when editing. |
| `client/src/pages/admin/AdminProgrammesPage.jsx` | New "Participation Structures" row action; existing Batches/Cohorts button label now conditional (Part 3); page description updated. |
| `client/src/pages/admin/ProgrammeGroupsModal.jsx` | Modal title/column label now conditional on `usesProgrammeLevels` (Part 3). |
| `server/test/participation-structure-administration.test.js` | **New.** Targeted integration coverage (see Verification). |
| `server/docs/ADMIN_WORKFLOW_REDESIGN_CHECKPOINT2_REPORT.md` | This report. |

No other files were touched. In particular: `routes/classes.js`, the
`classes` table, `routes/learningInstances.js`, registration/enrolment
logic, and the pre-existing public
`GET /programmes/:id/participation-structures` route are all byte-for-byte
unchanged.

## Database changes

Migration v37 (additive only, guarded by the existing `tryAlter` helper —
safe to re-run, safe against pre-existing databases):

```sql
ALTER TABLE programme_participation_structures ADD COLUMN retired_at TEXT;
```

`NULL` = never retired (every pre-existing row). No other schema change.
No data was migrated, backfilled, or deleted.

## Backend changes

`server/src/routes/learningOfferings.js`:

- `computeProgrammeDefinitionStatus({ hasCourses, participationStructures, hasLearningGroups })`
  — pure function, mirrors `computeLearningInstanceWorkflowStatus`'s shape
  (`steps[]`, `complete`, `missingSteps[]`). The "Programme Levels" step's
  applicability is read from `participationStructures.some(s =>
  s.usesProgrammeLevels)` — never a hardcoded Programme/offering-type name.
- `programmeUsesProgrammeLevels(programmeId)` — single-owner resolver,
  reused by both the list and detail routes so they can't disagree about
  which label to show.
- `GET /programmes` (list, unchanged auth) now also returns
  `usesProgrammeLevels` per row (one extra query per row — acceptable at
  admin-list scale, and this route is authenticated/admin-only).
- `GET /programmes/:id` (detail, unchanged auth) now also returns
  `usesProgrammeLevels`, `participationStructures` (active-only, reusing
  the existing `getProgrammeParticipationStructures` helper — no new
  query path), and `programmeDefinitionStatus`.
- New admin routes, all gated `requireAuth` + `requirePermission("learningOfferings.edit")`
  except the read route (`requireAuth` only, matching every other GET in
  this file):
  - `GET /programmes/:id/participation-structures/manage` — every status,
    full detail (distinct from the pre-existing public
    `/participation-structures` route, which stays active-only/lean/
    unauthenticated and untouched).
  - `POST /programmes/:id/participation-structures` — create. Validates
    name required, `registrantRole` against the fixed
    `parent|self|parent_or_self` vocabulary, and key uniqueness within
    the Programme (key auto-slugified from name, or explicit).
  - `PATCH /participation-structures/:id` — edit. `key` is immutable once
    set. Blocked (400) once retired.
  - `POST /participation-structures/:id/activate` — reversible. Blocked
    once retired.
  - `POST /participation-structures/:id/deactivate` — reversible. Blocked
    once retired (already-retired is stronger than deactivated).
  - `POST /participation-structures/:id/retire` — terminal. Sets
    `is_active=0, retired_at=now()`. Blocked if already retired. Never
    deletes the row (matches the codebase's existing soft-delete
    convention everywhere else — offering types, programmes, corporate
    clients, etc.).

## Frontend changes

- **`ParticipationStructuresModal.jsx`** (new) — table of a Programme's
  Participation Structures (name/key, status badge, configuration flags,
  actions), an inline "Add" form, and a confirmation dialog before Retire
  (since it's irreversible). Opened from a new "Participation Structures"
  button in `AdminProgrammesPage`'s row actions.
- **`ProgrammeDefinitionStatus.jsx`** (new) — checklist panel, modeled
  directly on the existing `ProgrammeRunWorkflowStatus.jsx` (same visual
  language: progress bar, step list with ✅/⬜/— markers, warning banner
  listing missing steps). Rendered inside `ProgrammeModal` only when
  editing an existing Programme; fetches the Programme detail itself on
  open rather than trusting the list-row shape (same approach
  `ProgrammeGroupsModal` already uses).
- **Part 3 terminology fix**, applied in exactly two places so it can't
  drift: `AdminProgrammesPage`'s row-action button label, and
  `ProgrammeGroupsModal`'s title/column label. Both read the same
  server-computed `usesProgrammeLevels` field. Where it's `false`,
  behavior is byte-for-byte what it was before this checkpoint.

## Verification

**No test run was possible in this sandbox** — `node_modules` isn't
installed for either `server` or `client`, and network access is
disabled here, so `npm install` cannot run. I could not execute
`node --test`, `npm run build`, or start the dev server.

What I did instead, as the best available substitute:

- `node -c` on every modified/new backend file
  (`routes/learningOfferings.js`, `db/migrate.js`, and the new test file)
  — all parse cleanly.
- Wrote a new targeted integration test,
  `server/test/participation-structure-administration.test.js`, following
  this codebase's established real-server-process pattern (see
  `test/admin-class-delivery-mode.test.js`). It covers: manage-route
  auth-without-permission, permission enforcement on create, key
  auto-slugging and uniqueness, `registrantRole` validation,
  `programmeDefinitionStatus`/`usesProgrammeLevels` agreement between the
  list and detail routes and their reaction to a newly-created
  Participation Structure and a newly-added Learning Group, edit,
  reversible deactivate/activate, and the terminal retire state (blocking
  further edit/activate/deactivate/re-retire) plus its effect on the
  public vs. admin read routes. **This has not been executed** — you'll
  need to run `npm test` (or `node --test test/participation-structure-administration.test.js`)
  in an environment with dependencies installed before trusting it.
- Manual trace-through of every new/changed route against the schema
  (confirmed column names, the `UNIQUE(programme_id, key)` constraint
  behavior, and that no other file references the touched functions in a
  way that would break).
- For the frontend: no build tooling was available at all (no
  `node_modules`, no cached `esbuild`/`babel`, `npx` blocked by the same
  network restriction). I did a manual line-by-line review of every new/
  changed `.jsx` file plus a bracket-balance check (`(`/`)`, `{`/`}`,
  `[`/`]` counts) on each — all balanced — but this is not a substitute
  for actually running `vite build`.

**Please run, before trusting this checkpoint:**
```
cd server && npm install && npm test
cd client && npm install && npm run build
```

## Risks

- The new `GET /programmes` list route now does one extra query per row
  (`programmeUsesProgrammeLevels`). Fine at realistic admin-list scale;
  would need revisiting if the Programmes list ever grows very large.
- `programmeDefinitionStatus`'s "Course Library" step considers the step
  complete once a Programme has ≥1 Course — it doesn't check course
  quality/completeness, matching the same minimum-existence bar
  `computeLearningInstanceWorkflowStatus` uses elsewhere in this
  codebase.
- Untested (see Verification) — the logic has been traced by hand but
  not executed.

## Remaining work

- Run the verification commands above and fix anything they surface.
- This checkpoint did not touch Part 4 (Operational Groups) at all, per
  your instruction to drop it — it remains entirely unimplemented and
  unresolved. If you want it pursued, it needs to go through one of the
  three paths I raised (constitutional amendment, re-scoped as the
  deferred A-3 `classes`-table work, or dropped for good) before any code
  is written.
- Nothing else from the original checkpoint prompt is outstanding beyond
  Part 4.
