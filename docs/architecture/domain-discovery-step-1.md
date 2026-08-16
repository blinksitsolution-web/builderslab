# 1. Actual Hierarchy
Institution -> Learning Offering Type -> Programme -> Programme Level -> Programme Run -> Academic Structure -> Academic Period -> Course -> Lesson

# 2. Core Entities
* **Kids STEM Programme**
  * table/model: `learning_offering_types`
  * purpose: An admin-manageable catalog category defining the overarching rules and behavior for a type of learning (e.g., requires parents, uses academic term).
  * parent/owner: None (Root level)
  * important relationships: Owns many `programmes`.

* **Builders' Lab**
  * table/model: `programmes`
  * purpose: The actual course/offering a learner registers for.
  * parent/owner: `learning_offering_types`
  * important relationships: Owns `classes` (Programme Levels), `courses`, `programme_participation_structures`, and `learning_instances` (Programme Runs).

* **Programme Levels**
  * table/model: `classes` (e.g., Foundation, Framework, Skyline)
  * purpose: The fixed cohorts/levels learners progress through.
  * parent/owner: `programmes`
  * important relationships: Referenced by `users`, `programme_enrollments`, `instructor_classes`.

* **Learning Instances (Programme Runs)**
  * table/model: `learning_instances`
  * purpose: A single concrete run of a Programme or Course (e.g., "Jan 2026 Cohort").
  * parent/owner: `programmes` (or `courses`), and `learning_offering_types`
  * important relationships: Activates participation structures via `learning_instance_participation_structures`.

* **Academic Periods**
  * table/model: `academic_calendar_periods`
  * purpose: Configurable date ranges the calendar engine manages (e.g., registration, lesson, midterm).
  * parent/owner: `academic_terms` (which belong to `academic_years`)
  * important relationships: Defines timeline events for a Term.

* **Courses**
  * table/model: `courses` (formerly `modules`)
  * purpose: The primary curriculum unit in the academic hierarchy.
  * parent/owner: `programmes`
  * important relationships: Has many `notes` (Lessons), referenced by `enrollments`.

* **Programme Enrollments**
  * table/model: `programme_enrollments`
  * purpose: Records a learner's enrollment into an entire programme.
  * parent/owner: `users` and `programmes`
  * important relationships: References a `class_id` (Programme Level) and a `learning_instance_id`.

* **Course Enrollments**
  * table/model: `enrollments`
  * purpose: Records a learner's enrollment into a specific course.
  * parent/owner: `users` and `courses`
  * important relationships: None directly below it.

# 3. Participation Structures
The three structures (Structured School Club, Structured Online Journey, Individual Course) are configuration rows stored in the `programme_participation_structures` table.
* They belong to a **Programme** (`programme_id`). They are NOT separate programmes themselves.
* They are connected to **Learning Instances** (Programme Runs) via the `learning_instance_participation_structures` join table. This means a Programme defines them, and a Learning Instance "activates" them for a specific delivery.

# 4. Builders' Lab Relationship
* **Kids STEM Programme**: Builders' Lab is a `programme` that belongs to the "Kids STEM Programme" `learning_offering_type`.
* **Participation Structures**: Builders' Lab (as a `programme`) owns its participation structures directly via `programme_participation_structures`.
* **Programme Levels**: Builders' Lab owns its progression ladder (Foundation, Framework, Skyline) via `classes.programme_id`.
* **Learning Instances**: Builders' Lab has concrete runs (Programme Runs) that belong to it via `learning_instances.programme_id`.

# 5. Evidence
* **Hierarchy & Learning Offering Types / Programmes:** `server/src/db/migrate.js` (lines ~724-772) defines `learning_offering_types` and `programmes`. "Kids STEM Programme" is seeded into `learning_offering_types` (slug: `kids_stem`), and "Builders Lab" is inserted into `programmes` linking to it.
* **Programme Levels (`classes`):** `server/src/db/migrate.js` (v10 migration and v7 additions) adds `programme_id` to `classes`, explicitly scoping them to a programme.
* **Participation Structures:** `server/src/db/migrate.js` (lines ~2620-2675) defines `programme_participation_structures` (owned by `programmes(id)`) and `learning_instance_participation_structures` which links `learning_instance_id` to `participation_structure_id`.
* **Academic Periods:** `server/src/db/schema.sql` (lines ~433-441) defines `academic_calendar_periods` referencing `academic_terms(id)`.
* **Courses:** `server/src/db/schema.sql` (lines ~156-164) defines `courses`, and `migrate.js` (line ~721) adds `programme_id` to it.
* **Programme Enrollments:** `server/src/db/migrate.js` (lines ~1245-1256) defines `programme_enrollments` linking `user_id`, `programme_id`, and `class_id`.
* **Course Enrollments:** `server/src/db/schema.sql` (lines ~30-34) defines `enrollments` linking `user_id` to `course_id`.

# 6. Uncertainties
* It is not entirely clear if `enrollments` (Course Enrollments) is being deprecated in favor of `programme_enrollments` or if they serve two distinct active use cases (e.g., for the "Individual Course" participation structure).
* The exact trigger logic linking a specific `learning_instance_id` back to the exact term/academic calendar periods is spread out and not fully visible just from the schema definition alone.
