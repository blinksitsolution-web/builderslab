# Promotion Subsystem — Checkpoint 5 Report

## Summary
Closes the "Remaining work" list from Checkpoint 4, items 1, 2, 3, and 5: admin UI for
configuring a Programme's Promotion Policy, instructor UI for submitting promotion
recommendations, per-learner and per-class eligibility breakdown display, and bounding
attendance evaluation to "since the current Programme Level began" instead of all-time. Item 4
(refactoring `transfer-campus`/`graduate` into their own services) remains explicitly deferred,
as it was in Checkpoint 4 — untouched again here. Item 6 (the pre-existing, unrelated
`integration: static-file boundary` test failure) remains unresolved and unrelated to this work.

No schema changes. No new entities. No architecture change — this is entirely UI surfacing of
already-existing, already-tested Checkpoint 4 API surface, plus one bounded-read fix to the
eligibility engine.

## Files modified / added
| File | Why |
|---|---|
| `server/src/utils/promotionEngine.js` | Item 5: new `currentLevelStartDate()` helper; attendance query now bounded by it; `attendanceSince` added to the eligibility breakdown. |
| `server/test/promotion-engine.test.js` | New targeted test for the attendance bound; fixture gained a third class (`skylineId`) so a post-Framework-promotion eligibility check has a next target. |
| `client/src/api/instructor.js` | New `submitPromotionRecommendation()` wrapper (item 2). |
| `client/src/pages/instructor/PromotionRecommendationModal.jsx` **(new)** | Instructor-facing Recommend/Do-not-recommend + note modal. |
| `client/src/pages/instructor/InstructorLearnersPage.jsx` | New "Recommend" action column, shown only for learners with a current Programme Level. |
| `client/src/pages/admin/PromotionPolicyModal.jsx` **(new)** | Admin-facing Promotion Policy editor (thresholds + requires-recommendation + active toggle) for a Programme. |
| `client/src/pages/admin/PromotionEligibilityModal.jsx` **(new)** | Per-learner eligibility breakdown display (score, attendance + bound date, instructor recommendation, policy thresholds, reasons). |
| `client/src/pages/admin/useAdminBulkPromotion.js` | New `eligibilityStatus`/`eligibilityByLearner` state and `checkClassEligibility()`, reset on every new search. |
| `client/src/pages/admin/AdminBulkPromotionPage.jsx` | New "Promotion Policy…" button (scoped to the selected class's Programme), "Check Promotion Policy eligibility" bulk button, an "Eligible" badge column, and a per-row "Eligibility" button — all wired to the two new modals. |

## Database changes
None. Every field this checkpoint's UI reads or writes already existed as of Checkpoint 4
(`promotion_policies`, `promotion_recommendations`, `promotion_log.policy_snapshot`).

## Backend changes
- **`currentLevelStartDate(learnerId, classId)`** (new, in `promotionEngine.js`): walks
  `promotion_log` for the most recent `promote`/`auto_promote`/`manual_promote`/`reversal` entry
  whose recorded `details.toClassId` matches the learner's current class, and returns its
  `created_at`. Returns `null` (no bound — identical to the prior all-time behaviour) when the
  learner has never had a recorded level change into their current level, e.g. they are still at
  their original Entry Level.
- **`evaluateLearnerPromotionEligibility`**: the attendance query now adds `AND date >= ?` using
  that bound's date portion whenever one exists. `breakdown.attendanceSince` now reports the bound
  (or `null`) so the UI can show *why* a percentage looks the way it does. Average-score evaluation
  is unaffected — it already reads only the learner's currently-enrolled courses' active-term
  grades, which naturally resets on re-enrollment; only attendance had the unbounded-history gap
  Checkpoint 4 flagged.
- No route signatures changed. `GET /api/promotion/eligibility/:learnerId` and
  `GET /api/promotion/eligibility?classId=` (already existing) simply return one additional
  breakdown field.

## Frontend changes
- **Admin — Promotion Policy configuration** (`AdminBulkPromotionPage` → "Promotion Policy…"
  button, enabled once a Class/Level is selected, scoped to that class's Programme):
  view/edit minimum average score, minimum attendance %, "requires instructor recommendation,"
  and an active toggle. Blank thresholds save as `NULL` ("not evaluated"), never zero.
- **Admin — Eligibility breakdown**: "Check Promotion Policy eligibility" evaluates every
  candidate currently loaded and adds an Eligible/Not-eligible badge column; a per-row
  "Eligibility" button opens the full breakdown (current → next level, reasons, average score,
  attendance % with its since-date, instructor recommendation, and the policy thresholds each was
  checked against).
- **Instructor — Recommendation submission** (`InstructorLearnersPage` → "Recommend" button, shown
  only for learners with an assigned class): Recommend / Do-not-recommend + optional note, posted
  to the existing `/api/promotion/recommend` endpoint. The server independently re-verifies the
  instructor is assigned to that learner's current class before accepting it — the client doesn't
  duplicate that check, since the page's own learner list is already server-scoped to the
  instructor's assignments.

## Verification
- **Targeted backend test** (`node --test test/promotion-engine.test.js`): 2/2 passing, including
  the new attendance-bound test, which seeds a pre-promotion 'present' row and a post-promotion
  'absent' row and confirms only the post-promotion row is counted (0%, not the blended 50% a
  regression would produce).
- **Full backend suite** (`npm test`, milestone-level per the AI Delivery Protocol): **197/198
  passing** — same single pre-existing failure as Checkpoint 4
  (`integration: static-file boundary`, caused by legacy static HTML files absent from the ZIP;
  unrelated to Promotion). No regressions.
- **Full frontend build** (`npm run build`): clean, all new/modified files compile.

## Risks
- `checkClassEligibility()` calls `GET /api/promotion/eligibility?classId=`, which evaluates every
  learner in that *class*, not the campus-filtered subset currently shown if a campus filter is
  also active. Results are keyed by `learnerId` and only looked up for rows actually displayed, so
  this is harmless (a few extra, unused entries in the map) rather than incorrect — but it does
  mean the bulk "Check eligibility" call does slightly more work than strictly needed when a
  campus filter narrows the visible list.
- The Promotion Policy button is only enabled once a Class/Level is selected (it needs that
  class's `programmeId`) — an admin who wants to configure a Programme's policy before any Class
  under it has learners to search for has no path to it from this screen. This mirrors the
  existing page's own "pick a class first" flow, so it's consistent, not a new gap, but is worth a
  future direct Programme-level entry point if that becomes a real workflow.

## Remaining work
1. Refactor `transfer-campus` and `graduate` into their own services (explicitly deferred again,
   per Checkpoint 4's instruction — untouched).
2. The pre-existing failing integration test (legacy static HTML files missing from the ZIP)
   remains unresolved — unrelated to Promotion.
3. (New, minor) A direct "configure this Programme's Promotion Policy" entry point that doesn't
   require first selecting a Class/Level, if that becomes a real admin workflow need.

## Deliverable
Updated project ZIP attached, excluding `node_modules`, `dist`, and other regenerable artifacts.
