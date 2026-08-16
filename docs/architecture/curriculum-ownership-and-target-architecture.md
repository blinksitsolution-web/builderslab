# 1. Current Curriculum Ownership

Currently, curriculum configuration is split awkwardly across two distinct domain entities:
1. **Programme-Level Curriculum** is owned by the **Programme** (via `course_groups` which belong to `programmes`). An administrator configures which Courses belong to Foundation. This applies universally across all Programme Runs.
2. **Period-Level Curriculum** is owned by the **Learning Instance** (via `learning_instance_period_targets`). An administrator configures which Targets (Programmes or Courses) are granted in a specific period of a specific Run.

**Evidence**: 
- `course_groups.programme_id` (Programme ownership)
- `learning_instance_period_targets.learning_instance_academic_period_id` (Run ownership).
- `server/src/utils/learningInstances.js` L2067 (`resolveCourseCurriculumForClass`), L2133 (`syncPeriodCourseEnrollments`).

# 2. Course Group Semantics

A `course_group` represents an organisational collection of courses (a curriculum track) within a Programme.
- **Reusable across Programmes?** No. Tied to one Programme via `programme_id`.
- **Reusable across Learning Instances?** Yes. Any Run of the Programme inherits these mappings because learners resolve their course group globally.
- **Tied to Programme Level?** Yes, via the `course_group_courses` join table which explicitly maps a `course_group_id` to a `class_id`.
- **Tied to Academic Period?** No. There is no period dimension in Course Groups.
- **Flaw**: A learner's Course Group is not explicitly assigned. It is magically inferred from their pre-existing `enrollments` via `courses.course_group_id`.

**Evidence**: `server/src/db/migrate.js` L2311 (`course_groups`), L2339 (`course_group_courses`).

# 3. Learning Instance Curriculum Semantics

Learning Instances (Programme Runs) do not have their own Programme-Level curriculum definitions. They inherently share the global `course_group_courses` mappings defined by their parent Programme. 
- School A and School B runs of Builders' Lab cannot have different Foundation courses defined via Course Groups, because both run the same Programme and Foundation is a Programme-owned Class.

# 4. Academic Period Curriculum Semantics

Academic Periods belong exclusively to Learning Instances. 
- A Learning Instance has 2 or 3 periods (Semester/Term).
- The period gates course access behind dates and payments.
- Because periods are Run-specific, Period 1 of School A can technically target different courses than Period 1 of School B.

# 5. Period Target Semantics

The `learning_instance_period_targets` table:
- **Columns**: `id`, `learning_instance_academic_period_id`, `learning_instance_target_id`.
- **Foreign Keys**: Links a period to a `learning_instance_target`.
- **Supported Targets**: A Programme or a specific Course.
- **Programme Level Support**: **None.** A target cannot reference a `class_id`.
- **Payment Implications**: Yes. If a period's payment isn't satisfied, its targets aren't granted.
- **Semantics**: It is currently acting as a **Delivery Target**, blindly granting the referenced entities. Because it lacks a Class dimension, it cannot say "Grant Robotics to Foundation". It can only say "Grant all Foundation/Framework/Skyline courses to everyone in their respective classes" (by targeting the Programme) or "Grant Robotics to absolutely everyone in the Run" (by targeting the Course).

# 6. Multi-Learning-Instance Analysis

Can School A's Foundation Term 1 curriculum differ from School B's?
- **Using Course Groups**: No. Course Groups are shared globally by the Programme.
- **Using Period Targets**: If School A explicitly targets the "Robotics" course in Term 1, everyone in School A (Foundation, Framework, Skyline) gets Robotics. It cannot be scoped to Foundation. 
- **Conclusion**: The current architecture strictly prohibits school-specific, class-scoped curriculum customization.

# 7. Current Admin Configuration Workflow

**Goal**: Foundation Term 1 -> Robotics, Programming. Foundation Term 2 -> IoT, Electronics.
1. Admin maps Robotics, Programming, IoT, Electronics to Foundation (Course Group).
2. Admin sets Term 1 target to "Builders' Lab Programme".
3. **Failure**: Learner in Term 1 gets ALL FOUR courses instantly because `syncPeriodCourseEnrollments` resolves the Programme target by granting everything mapped to the learner's class.
4. **Alternative**: Admin sets Term 1 target to explicit Course IDs (Robotics, Programming).
5. **Failure**: A Skyline student in Term 1 also gets Robotics and Programming, because period targets ignore `class_id`.

# 8. Architectural Gap

The system lacks a three-dimensional mapping matrix. We need:
**(Programme Level) × (Academic Period) → (Courses)**

Currently we have:
(Programme Level) → (Courses)  *[Course Groups]*
(Academic Period) → (Programme OR Courses) *[Period Targets]*

# 9. Candidate Target Models

| Criterion | Model A (Period on Course Group) | Model B (Dedicated Curriculum Map) | Model C (Run -> Period -> Level -> Course) | Model D (Run -> Period -> Target+Level) | Model E (Class -> Period -> Courses) |
| --------- | ------- | ------- | ------- | ------- | ------- |
| **Correct domain ownership** | Yes (Programme owns Curriculum) | Yes | No (Run shouldn't own standard curriculum) | No | Yes |
| **Programme Level support** | Yes | Yes | Yes | Yes | Yes |
| **Academic Period support** | Yes (via Sequence) | Yes | Yes | Yes | Yes |
| **Multiple Learning Instances** | Shared standard | Shared standard | Fully customisable per Run | Fully customisable per Run | Shared standard |
| **School-specific curriculum** | Requires new Course Group per school | Requires new map per school | Easy | Easy | Requires new Class per school |
| **Promotion support** | Clean | Clean | Messy (Must sync across periods) | Messy | Clean |
| **Payment gating** | Easy (Check sequence) | Easy | Built-in | Built-in | Easy |
| **Maintainability** | High (Define once) | High | Low (Admin copies config for every run) | Low | High |
| **Migration complexity** | Low (Add column) | Medium (New tables) | High (Re-architect targets) | Medium | Medium |

# 10. Recommended Model

**Recommended Model: Model A (Add Academic Period Sequence to `course_group_courses`)**

*Why?*
The business requirement explicitly states: "For Builders' Lab, curriculum is structured by: Programme → Programme Level → Academic Period → Courses". This defines a **Standardized Programme Curriculum**. 

Adding an `academic_period_sequence` (e.g., 1, 2, 3) to `course_group_courses` perfectly models this reality. It allows the Programme (via Course Groups) to declare exactly when a course is meant to be delivered within a structured progression. 
When `syncPeriodCourseEnrollments` runs for Term 2 (sequence 2), it simply asks `course_group_courses` for all courses mapped to the learner's `class_id` AND `academic_period_sequence <= 2`. 

This keeps curriculum definition firmly in the hands of the Programme, preventing the catastrophic admin burden of redefining the Foundation curriculum from scratch every time a new School Run is created (which Model C/D would require).

# 11. Migration Considerations
- `course_group_courses` needs a new column: `academic_period_sequence INTEGER`.
- Existing rows can default to `1` (or `NULL` meaning "all periods").
- `resolveCourseCurriculumForClass` must be updated to accept an `upToSequence` parameter.
- `syncPeriodCourseEnrollments` must pass the current period's sequence to the resolver instead of granting all courses blindly.
- The UI for managing Course Groups must be updated to group course assignments by Period Sequence.

# 12. Risks
- **Course Group Identity**: This model still relies on inferring the learner's Course Group from their enrollments. If a learner has zero enrollments, they might not resolve a Course Group. A reliable `programme_enrollments.course_group_id` explicit assignment is strongly recommended to stabilize this.

# 13. Open Questions
- Do any Schools actually require a *completely custom* Foundation curriculum that drastically diverges from the standard Builders' Lab track? If yes, explicit `course_group_id` assignment on `programme_enrollments` is mandatory so different Runs can assign different Course Groups.

CURRICULUM OWNERSHIP ANALYSIS COMPLETE
