# 1. Executive Summary

This report documents the actual implementation of Participation Structures and learner enrollment flows for the Builders' Lab programme, based on a comprehensive read-only analysis of the current database schemas, migrations, and backend services. 

Key findings include:
- The system uses a two-tiered enrollment architecture: `programme_enrollments` represents the learner's journey through a Programme (including their Programme Level and Learning Instance), while `enrollments` is the universal, atomic source of truth for access to actual curriculum content (Courses), regardless of the chosen participation structure.
- Structured Participation (School Club and Online Journey) automates course access by syncing the `enrollments` table based on a learner's Programme Level (`class_id`) and Academic Period.
- The system correctly supports concurrent Active Programme Runs by forcing explicit disambiguation during registration.

# 2. Participation Structure Configuration

The configuration for the three Participation Structures is defined as metadata in `server/src/utils/participationStructureMetadata.js` (and seeded into the `programme_participation_structures` table via migrations).

1. **Structured School Club** (`structured_school_club`)
   - Uses Programme Levels: `true`
   - Uses Promotion: `true`
   - Requires Course Selection: `false` (Curriculum is auto-assigned)
   - Uses Long Term Enrollment: `true`
   - Auto Assigns Entry Level: `true`
   - Registrant Role: `parent`

2. **Structured Online Journey** (`structured_other`)
   - Uses Programme Levels: `true`
   - Uses Promotion: `true`
   - Requires Course Selection: `false`
   - Uses Long Term Enrollment: `false`
   - Auto Assigns Entry Level: `false`
   - Registrant Role: `parent`

3. **Individual Course** (`individual_course`)
   - Uses Programme Levels: `false`
   - Uses Promotion: `false`
   - Requires Course Selection: `true` (Learner/Parent explicitly picks courses)
   - Uses Long Term Enrollment: `false`
   - Auto Assigns Entry Level: `false`
   - Registrant Role: `parent_or_self`

**Evidence**: `server/src/utils/participationStructureMetadata.js` Lines 20-51

# 3. Structured School Club Lifecycle

1. **Registration**: The parent registers the learner via `routes/auth.js` (`kind === "parent-learner"`). The structure `structured_school_club` requires no explicit course selection.
2. **Learning Instance & Class Resolution**: `resolveEntryClass()` automatically determines the Entry Level (Foundation). `resolveActiveInstanceForRegistration()` explicitly determines the correct active Programme Run.
3. **Programme Enrollment**: A primary `programme_enrollments` record is created with `status='pending_payment'` and `payment_status='unpaid'`, linking `user_id`, `programme_id`, `class_id`, and `learning_instance_id`.
4. **Payment**: Payment is completed and processed in `utils/paymentActivation.js` (`activateSuccessfulPayment`).
5. **Course Access**: Payment activation calls `activateEnrollmentCurriculum()`.
6. **Enrollments Sync**: `syncCourseCurriculumForClass()` and `syncPeriodCourseEnrollments()` resolve which courses belong to the current Class and Academic Period. These are then inserted into the `enrollments` table (`INSERT OR IGNORE`).

Does it create ONE continuing `programme_enrollments` record? **Yes.**
Does it create `enrollments` records for every course? **Yes.**

**Evidence**: `server/src/routes/auth.js` (Lines ~550-575); `server/src/utils/paymentActivation.js` (Lines 240-246); `server/src/utils/learningInstances.js` (Lines 2229-2245).

# 4. Structured Online Journey Lifecycle

This lifecycle (`structured_other`) shares the exact same underlying architecture as Structured School Club:
- **Shared Code**: Both use `routes/auth.js` for registration, generate `programme_enrollments`, and use `activateEnrollmentCurriculum()` to populate `enrollments`.
- **Different Code / Configuration**:
  - `autoAssignsEntryLevel` is `false`. It does not forcefully push the user into the default Foundation entry class.
  - `usesLongTermEnrollment` is `false`.
- **Business Reality vs Implementation**: The implementation reflects that this is a structured journey (uses Programme Levels and Promotion) but does not assume long-term, school-managed enrollment continuity, aligning with an online delivery model where parents have more manual control over progression.

# 5. Individual Course Lifecycle

1. **Selection**: Requires explicit selection (`requiresCourseSelection: true`). The parent/learner picks one or more specific courses during registration.
2. **Registration Storage**: The selected courses are serialized into `requested_course_ids` JSON column within the `programme_enrollments` record. 
3. **Payment**: Processed via `utils/paymentActivation.js`.
4. **Activation**: `activateEnrollmentCurriculum()` parses `requested_course_ids` and inserts them directly into the `enrollments` table.
5. **Levels & Periods**: It bypasses Programme Levels entirely (`usesProgrammeLevels: false`). Academic Periods are also not enforced for course discovery, as the user manually selects the module.

Is `enrollments` the intended mechanism? **Yes.** The `enrollments` table is universally used for course access, whether the courses were manually selected (Individual Course) or automatically assigned (Structured).

**Evidence**: `server/src/utils/learningInstances.js` (Lines 2231-2237).

# 6. Programme Enrollment Analysis

**Table**: `programme_enrollments`
- **Columns**: `id`, `user_id`, `programme_id`, `class_id`, `is_primary`, `status`, `payment_status`, `joined_date`, `learning_instance_id`, `participation_structure`, `requested_course_ids`, `delivery_mode`, `campus_id`, `academic_period_id`, `course_group_id`, `operational_group_id`, `pricing_snapshot`, `financial_policy_snapshot`.
- **Foreign Keys**: `user_id` (users), `programme_id` (programmes), `class_id` (classes), `learning_instance_id` (learning_instances).
- **Multiple Enrollments**: Yes. `is_primary = 1` tracks the learner's original placement. Additional programme enrollments get their own rows (`is_primary = 0`).
- **Learning Instance Changes**: Bound to a `learning_instance_id`. Moving a learner between runs implies updating this field or creating a new enrollment.
- **Programme Levels**: Represents the current level via `class_id`.

**Evidence**: `server/src/db/migrate.js` (v29, v30, v31 updates).

# 7. Course Enrollment Analysis

**Table**: `enrollments`
- **Columns**: `user_id`, `course_id`. (Composite Primary Key).
- **Purpose**: Pure atomic mapping of "Does User X have access to Course Y?"
- **Intended for Individual Course?** Yes, but not *exclusively*.
- **Used by Structured School Club/Online Journey?** Yes. `syncCourseCurriculumForClass` and `syncPeriodCourseEnrollments` write to this table to grant structured learners access to their curriculum.
- **Legacy?** No, it has been deliberately maintained as the final content-authorization gate (Enrollment Activation pipeline - v30).

**Evidence**: `server/src/utils/learningInstances.js` (`syncCourseCurriculumForClass`, Lines 2088-2104).

# 8. Academic Structure Analysis

- **Entities**: Managed through `ACADEMIC_STRUCTURES` metadata and stored in `learning_instance_academic_periods`. 
- **Purpose**: Allows a Learning Instance (Programme Run) to be broken into sequential periods (e.g., Trimester 1, Trimester 2) for pacing and payment gating.
- **Relationships**: A Learning Instance owns multiple Academic Periods. An Academic Period maps to a Term.
- **Problem Solved**: Automatically grants access to the next set of courses *only* when the new period starts AND the parent has paid the period-specific invoice.

**Evidence**: `server/src/utils/learningInstances.js` (`syncPeriodCourseEnrollments`, Lines 2107-2133).

# 9. Structured Course Access Analysis

For a Structured School Club learner, course access is strictly granted by:
1. `activateEnrollmentCurriculum()` running upon payment success.
2. `syncCourseCurriculumForClass(userId, classId)` finding all courses associated with the learner's current Programme Level (via `course_group_courses` mappings) and inserting them into `enrollments`.
3. `syncPeriodCourseEnrollments(userId, learningInstanceId)` finding all courses assigned to the current, paid-for Academic Period and inserting them into `enrollments`.

Course access is completely defined by inserting explicit rows into `enrollments`. There is no magic "implied" curriculum access at read-time; if the row isn't in `enrollments`, the learner can't see the course.

**Evidence**: `server/src/utils/learningInstances.js` (Lines 2229-2245).

# 10. Promotion/Progression Analysis

- **Implementation**: Moving from Foundation -> Framework updates the learner's `class_id`.
- **Course Granting**: Immediately after updating the class, the promotion pipeline calls `syncCourseCurriculumForClass(userId, newClassId)`. 
- **Result**: New courses mapped to the new Programme Level are automatically inserted into the `enrollments` table via `INSERT OR IGNORE`, instantly granting access to the new curriculum without destroying old course access.

**Evidence**: `server/src/utils/learningInstances.js` (Lines 2088-2094, Note: "Callers (routes/promotion.js) run this right after moving class_id").

# 11. Learning Instance Resolution Analysis

The system enforces strict disambiguation for concurrent Active Programme Runs.
- **Safe Registration Logic**: Uses `resolveActiveInstanceForRegistration(programmeId, operationalGroupId, instanceId)`.
- If multiple runs are active, it looks for an explicit `instanceId` or an `operationalGroupId` (e.g., a specific batch/school selection). If it cannot disambiguate, it returns `ambiguous: true` and forces the frontend to ask the user.
- **Unsafe Logic**: `getActiveInstanceForProgramme()` simply orders by `created_at DESC` and picks the latest one. It is heavily documented as being a "backward-compatible default" that is "NOT safe for registration".

**Evidence**: `server/src/utils/learningInstances.js` (Lines 1250-1340).

# 12. Current Data Flow Diagrams

Learner 
→ Selects Participation Structure (e.g., Structured School Club)
→ Resolves Learning Instance (Programme Run) & Programme Level (Foundation)
→ Creates Programme Enrollment (`programme_enrollments` with `class_id` & `learning_instance_id`)
→ Completes Payment
→ Resolves Academic Period & Course Group Mappings
→ Creates Atomic Course Enrollments (`enrollments`)
→ Gains Content Access

# 13. Current Implementation vs Business Requirements

| Area | Current Implementation | Intended Behavior | Status |
| ---- | ---------------------- | ----------------- | ------ |
| Two-tier Enrollment | `programme_enrollments` tracks journey; `enrollments` tracks course access. | Decouple journey state from raw content access. | Correct |
| School Club Access | Automatically syncs courses into `enrollments` via class mappings. | Auto-assign curriculum. | Correct |
| Individual Course | Stashes `requested_course_ids` in `programme_enrollments`, activates into `enrollments` on payment. | Manual curriculum selection. | Correct |
| Learning Instances | Forces explicit disambiguation during registration. | Safely handle concurrent runs. | Correct |
| Promotion | Updates `class_id` and triggers `syncCourseCurriculumForClass`. | Grant next tier of courses automatically. | Correct |

# 14. Confirmed Findings
1. `enrollments` is not legacy; it is the universal atomic authorization table for all content access.
2. Structured Participation leverages `programme_enrollments` to drive automation that eventually populates `enrollments`.
3. Payment activation is the hard gate for transferring intent (`programme_enrollments`) into reality (`enrollments`).
4. Multiple active Learning Instances are safely handled by a disambiguation requirement during registration.

# 15. Remaining Unknowns
- How is the `course_group_courses` table populated/managed by admins to actually link specific Courses to Programme Levels (classes)?
- What is the precise user-facing interface for selecting the "Operational Group" when disambiguating Learning Instances?

PARTICIPATION & ENROLLMENT ANALYSIS COMPLETE

**Top 5 Findings:**
1. **Universal Course Access:** The `enrollments` table is the definitive gate for content access for ALL participation structures, not just Individual Courses.
2. **Pipeline Activation:** Registration only creates a `programme_enrollments` record ("intent"). Course access is granted exclusively after successful payment via `activateEnrollmentCurriculum()`.
3. **Structured Automation:** School Club and Online Journey auto-populate `enrollments` by reading `course_group_courses` and `learning_instance_academic_periods` mappings at the time of payment or promotion.
4. **Promotion Mechanics:** Promotion simply updates the `class_id` and re-runs the curriculum sync (`syncCourseCurriculumForClass`), safely layering new course access on top of existing ones.
5. **Concurrent Run Safety:** Registration logic correctly demands explicit disambiguation (`instanceId` or `operationalGroupId`) if multiple Programme Runs are active, refusing to silently guess.
