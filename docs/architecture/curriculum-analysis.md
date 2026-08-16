# 1. Executive Summary

This report completes a read-only analysis of the Builders' Lab curriculum architecture, specifically investigating how Programme Levels (`classes`), Academic Periods (`learning_instance_academic_periods`), and Course Groups (`course_groups`) interact to determine learner course access.

**Critical Finding**: The architecture suffers from a fundamental impedance mismatch between Programme Levels and Academic Periods. The system can map Courses to a Programme Level (via Course Groups), and it can map Courses to an Academic Period, but it **cannot cleanly map Courses to the intersection of both** (e.g., "Foundation Term 1"). Promotion and curriculum sync workflows currently bypass period-level payment gating and grant entire level curriculums at once.

# 2. Course Group Model

- **Entities**: `course_groups`, `course_group_courses`
- **Purpose**: A Course Group is an organisational layer representing a curriculum track or collection of courses. It is *not* a Programme Level, nor an Academic Period.
- **Rules**: A Course (`courses`) belongs to a single `course_group_id`. The join table `course_group_courses` defines WHICH courses from a Course Group are applicable to WHICH Programme Level (`class_id`).

**Evidence**: `server/src/db/migrate.js` (Lines 2311-2351), `server/src/routes/courses.js`.

# 3. Programme Level → Course Mapping

The function `syncCourseCurriculumForClass(userId, classId)` defines this logic:
1. **Identify Course Group**: It does *not* read a direct learner-to-Course-Group assignment. Instead, it queries the `enrollments` table for the learner's *pre-existing* courses that have a `course_group_id`.
2. **Resolve Courses**: It looks up `course_group_courses` for that inferred `course_group_id` and the provided `classId`.
3. **Grant Access**: It executes an `INSERT OR IGNORE` into `enrollments` for those courses.
4. **Constraints Ignored**: It explicitly does **not** check the current Learning Instance, the Academic Period, or Payment Status. It simply dumps all courses for that level into the `enrollments` table.

**Evidence**: `server/src/utils/learningInstances.js` (Lines 2067-2105).

# 4. Academic Period → Course Mapping

The function `syncPeriodCourseEnrollments(userId, learningInstanceId)` handles this:
1. **Identify Period**: It orders the `learning_instance_academic_periods` by sequence.
2. **Payment Check**: For any period after Period 1, it checks `getPeriodPaymentStatus()`. If unpaid, the period is skipped.
3. **Identify Courses**: It reads `learning_instance_period_targets`.
   - If the target is a specific `courseId`, it grants it.
   - If the target is a `programmeId`, it calls `resolveCourseCurriculumForClass(userId, class_id)` to get the learner's class-based courses.
4. **Grant Access**: `INSERT OR IGNORE` into `enrollments`.

**Evidence**: `server/src/utils/learningInstances.js` (Lines 2133-2185).

# 5. Learning Instance → Academic Period Model

- **Entity**: `learning_instance_academic_periods`
- **Purpose**: Divides a Learning Instance (Run) into sequential blocks (e.g., Term 1, Term 2, Term 3).
- **Payment Gating**: Each period can have its own `payment_mode` ('full', 'deposit') and `required_amount_ghs`. This forms the basis of period-by-period tuition gating.
- **Relationship**: A Learning Instance owns these periods; they optionally link to a global `academic_term_id` for reporting.

**Evidence**: `server/src/db/migrate.js` (Lines 2137-2150, 2187-2200).

# 6. Academic Structure Model

- **Metadata**: `ACADEMIC_STRUCTURES` (`semester`, `term`) defined in `utils/learningInstances.js`.
- **Purpose**: Enforces strict structural layouts for a Run. A `semester` structure always creates exactly 2 periods. A `term` structure always creates exactly 3 periods.

# 7. Programme Level + Academic Period Interaction

The actual implementation model is: **(Programme Level → Courses) OR (Academic Period → Courses)**. It is NOT `Programme Level + Academic Period → Courses`.

**The Conflict**:
- If an admin maps a Programme Level to Courses (via Course Groups), the courses are not split by term. 
- If `syncPeriodCourseEnrollments` evaluates a "Term 1" target pointing to the Programme, it will grant **ALL** courses mapped to the learner's class (e.g., both Term 1 and Term 2 courses instantly).
- If the admin tries to fix this by explicitly targeting specific Courses to "Term 1", the period target has no knowledge of `class_id`. It will grant those courses to **every** learner in the Run, regardless of whether they are Foundation or Skyline.

# 8. Curriculum Configuration Workflow

**Scenario**: Admin wants Foundation Term 1 to contain "Robotics", and Foundation Term 2 to contain "IoT".

**Current Reality**: The administrator *cannot* configure this cleanly in the current system. 
- They can use `PUT /api/course-groups/:id/classes/:classId/courses` to map Robotics and IoT to Foundation.
- However, they cannot tell the system that Robotics is Term 1 and IoT is Term 2 for Foundation specifically. 
- Any attempt to use Programme-level targets for Term 1 will instantly grant both Robotics and IoT in Term 1.

# 9. Course Access Activation Workflow

The lifecycle is correctly implemented as an atomic pipeline:
1. **Curriculum Configuration**: Stored in `course_group_courses` and `learning_instance_period_targets`.
2. **Learner Eligibility**: Established by `programme_enrollments` (`class_id` and `learning_instance_id`).
3. **Payment**: Processed in `payments` table.
4. **Enrollment Activation**: `activateEnrollmentCurriculum()` runs, tying eligibility and payment together.
5. **Course Access**: Final rows are written to `enrollments`, granting immediate content access.

# 10. Promotion Curriculum Workflow

When a learner is promoted (e.g., Foundation → Framework):
1. Their `class_id` changes.
2. `syncCourseCurriculumForClass(userId, newClassId)` is triggered.
3. The system grants **ALL** Framework courses instantly via `INSERT OR IGNORE`.
4. Previous courses remain accessible (historical access is preserved).
5. **Critical Flaw**: The system does **not** check the current Academic Period or Payment Status during this sync. A mid-year promotion instantly grants Term 2 and Term 3 Framework courses, bypassing period-level payment gates.

# 11. Concrete Builders' Lab Curriculum Example

**Intended Flow:**
- Foundation Term 1 → Robotics
- Foundation Term 2 → Scratch
- Framework Term 1 → Python

**Actual Implementation Result:**
- When learner pays for Term 1 (Foundation): System grants **Robotics AND Scratch** instantly (because both are mapped to Foundation via Course Groups, and Term 1 Programme-target resolves the entire class curriculum).
- When learner pays for Term 2: System does nothing (they already have Scratch).
- When learner is Promoted to Framework in Term 1: System grants **Python** instantly, ignoring period and payment checks.

# 12. Current Implementation vs Intended Business Model

| Requirement | Current Implementation | Status | Evidence |
| ----------- | ---------------------- | ------ | -------- |
| Level Scoping | `course_group_courses` maps courses to `class_id`. | Correct | `utils/learningInstances.js` L2067 |
| Period Gating | `syncPeriodCourseEnrollments` blocks unpaid periods. | Correct | `utils/learningInstances.js` L2150 |
| Level + Period Intersection | Cannot split a Class's curriculum across Periods dynamically. | **Incorrect** | `utils/learningInstances.js` L2160 |
| Promotion Gating | Promotion instantly grants all courses for the new level, ignoring periods/payment. | **Incorrect** | `utils/learningInstances.js` L2095 |
| Course Group Identity | Inferred magically from a learner's pre-existing course enrollments. | **Incorrect** | `utils/learningInstances.js` L2071 |

# 13. Confirmed Findings

1. `course_group_courses` successfully maps courses to a Programme Level.
2. `learning_instance_academic_periods` successfully gates periods behind payment requirements.
3. `activateEnrollmentCurriculum()` correctly serves as the single integration point for these rules upon payment.
4. Promotion correctly preserves historical course access by using `INSERT OR IGNORE`.

# 14. Remaining Unknowns

1. If a learner has zero pre-existing enrollments (e.g., brand new registration), how does `resolveCourseCurriculumForClass` infer their `course_group_id`? (It currently looks like it might fail to find any course group and return an empty curriculum).
2. Was the intention to have `course_group_courses` include an `academic_period_sequence` column that was missed during design?

# 15. Architectural Risks

- **Course Group Inference Failure**: Because `resolveCourseCurriculumForClass` infers Course Group identity from *existing* course enrollments, a brand new user with no explicitly requested courses might get stuck in an empty curriculum state.
- **Period Bypass on Promotion**: The promotion workflow actively defeats the period-by-period payment gating model by granting the entire new class curriculum unconditionally.
- **Curriculum Definition Impossible**: Admins simply cannot define a matrix of (Programme Level x Academic Period = Courses) using the current schema.
