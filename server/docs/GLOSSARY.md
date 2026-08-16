# Business Term ↔ Implementation Term Glossary

Source of authority: `ARCHITECTURE_BUSINESS_RULES_SPECIFICATION_v2.1.md` ("ABRS v2.1").
Produced as part of ABRS v2.1 Roadmap **Phase 1 — Architecture Alignment**.

This file exists so that any engineer or AI assistant reading the codebase can
translate between the business vocabulary used in the constitutional
specification and the table/column/route names actually used in this
codebase, without guessing. **The business term is authoritative for meaning;
the implementation term is authoritative for what to type.** Where the two
differ, that is a naming gap to close eventually (see ABRS v2.1 §19 Phase 1),
not a sign the two concepts are different.

| Business Term (ABRS v2.1) | Implementation Term (this codebase) | Spec Section | Notes |
|---|---|---|---|
| Institution | *(implicit — no table; the single deployment itself)* | §3 | Every row in every table is implicitly scoped to the one Institution. No `institution_id` column exists or is needed at current scale. |
| Learning Offering Type | `learning_offering_types` | §4 | Correctly implemented; classifies Programmes only. |
| Programme | `programmes` | §5 | Correctly implemented. |
| Course Library | *(implicit — the set of `courses` rows scoped to one `programme_id`)* | §6 | No separate "library" table; a Programme's Course Library is simply its Courses. |
| Course | `courses` table | §6 | **Historical note:** this table was named `modules` in an earlier version of this codebase and was renamed to `courses` by an explicit migration. Comments referencing "Module" in older migration history mean what this document calls "Course" — the Module *layer* (a thing sitting between Course and Lesson) is retired and does not exist; only the *name* survives in old comments. |
| Lesson | `notes` (kind = `video_lesson`) / the video-lesson catalogue keyed by `lesson_id` in `progress`/`unlocks` | §6 | Belongs directly to a Course; no intermediate layer. |
| Programme Run | `learning_instances` table, `utils/learningInstances.js`, `routes/learningInstances.js` | §7 | **"Programme Run" is the preferred business term; "Learning Instance" is the implementation term. Both name exactly one entity.** Use "Programme Run" in new prose/comments/UI copy; the table/route/service names stay `learning_instances`/`learningInstances` until a physical rename is scheduled (not yet scheduled as of Phase 1). |
| Activated Course | *(not yet a single table — currently inferred from `learning_instance_targets` [course-type rows] + `instructor_courses` + `course_group_courses`)* | §8 | **Known gap — Appendix A-2.** Scheduled to become a dedicated table in Phase 3. |
| Course Lifecycle states (Active/Inactive/Hidden/Compulsory/Optional/Archived) | *(not yet modeled — no dedicated columns)* | §9 | New concept introduced in ABRS v2.1; not yet represented in the schema. Scheduled alongside the Activated Courses table in Phase 3. |
| Participation Structure (definition) | `participation_structure` TEXT CHECK enum on `programme_enrollments` and `learning_instances` | §10 | **Known gap — Appendix A-1 (CRITICAL).** Currently a hardcoded enum (`structured_school_club` / `structured_other` / `individual_course`), not Programme-scoped configuration data. Scheduled for Phase 2. |
| Participation Structure (activation on a Run) | Same enum column on `learning_instances` | §10.1 | Same gap as above — activation and definition are not yet structurally separated. |
| Programme Level | `classes` table (Foundation/Framework/Skyline rows) | §11 | Correctly implemented for its primary purpose, but see next row. |
| *(unnamed second usage of `classes`)* | `classes` table, same rows | §11.3, Appendix A-3 | **Known gap — MEDIUM, explicitly deferred.** `classes` is also read elsewhere for a cohort-like grouping purpose distinct from progression. ABRS v2.1 does **not** authorize naming or formalizing this second usage (no Cohort/Track/Stream/Section concept is introduced by the constitution — §11.4); it is recorded as a known, unresolved mixing of responsibilities only. |
| Promotion | `routes/promotion.js`, `promotion_log` table | §12 | Correctly implemented; changes only a learner's `class_id` (Programme Level). |
| Registration | `routes/auth.js` (registration flow), `routes/modules.js` `/open` gating | §13 | Correctly implemented — gated on an Active Programme Run with registration open; no fallback path. |
| Enrollment | `programme_enrollments` table | §14 | Correctly implemented for most fields; selected Courses for Individual Course participants stored as JSON rather than normalized — Appendix A-4. |
| Single Ownership Principle | *(architectural principle — not a code artifact)* | §2.1 | Applies to every table/route above. |
| Configuration Before Code | *(architectural principle — not a code artifact)* | §2.2 | Audit of current hardcoded-identifier comparisons not yet performed — Appendix A-8. |

## How to use this file

- When writing new code comments, admin UI copy, API documentation, or commit
  messages: prefer the **business term**.
- When writing actual code (table names, column names, route paths, variable
  names): use the **implementation term**, since renaming these is its own,
  separately-scoped migration (not yet undertaken as of Phase 1).
- When you find a place in the codebase using a business term informally in a
  way that doesn't match this table (e.g., a comment calling something a
  "Cohort" or a "Module"), treat that as a documentation defect to fix, not as
  evidence a new concept exists — cross-check against ABRS v2.1 first.
