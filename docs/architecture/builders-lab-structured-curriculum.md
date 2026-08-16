# Builders' Lab Structured Curriculum Architecture

## Purpose

This document defines how the Builders' Lab LMS determines which Courses a learner enrolled in a **structured journey** should receive, based on their Programme Level and the current Academic Period.

It replaces the prior flat mapping (Programme Level → Courses, ignoring time) with a two-dimensional matrix:

```
Programme Level × Academic Period → Courses
```

---

## Business Scope

This curriculum model applies **exclusively** to:
- Learners enrolled in Builders' Lab
- Where the Participation Structure is `structured_school_club` OR `structured_other`
- Where the Programme Enrollment has a `class_id` (Programme Level) and `course_group_id`
- Where the Learning Instance has an Academic Structure (`semester` or `term`) configured

It does **NOT** apply to:
- `individual_course` participation
- Adult Professional programmes
- Corporate programmes
- Bootcamp programmes
- Any Learning Instance without an Academic Structure

---

## Structured Participation Structures

| Key | Display Name | Uses Programme Levels | Uses Promotion |
| --- | --- | --- | --- |
| `structured_school_club` | Structured School Club | Yes | Yes |
| `structured_other` | Structured Online Journey | Yes | Yes |

---

## Curriculum Model

### Programme Level × Academic Period Matrix

Admin-configurable via `course_group_courses` (one row per Course per Level per Period):

| course_group_id | class_id | academic_period_sequence | course_id |
| --- | --- | --- | --- |
| STEM Track | Foundation | 1 | Robotics |
| STEM Track | Foundation | 2 | IoT |
| STEM Track | Framework | 1 | Python |
| STEM Track | Framework | 2 | AI |

**Access is cumulative**: a learner eligible for Period 2 receives all Period 1 AND Period 2 courses.

### Concrete Example

```
Foundation
├── Term 1 (sequence=1) → Robotics
└── Term 2 (sequence=2) → IoT

Framework
├── Term 1 (sequence=1) → Python
└── Term 2 (sequence=2) → AI
```

A Foundation learner at Term 1 receives: `[Robotics]`
A Foundation learner at Term 2 receives: `[Robotics, IoT]`
A Framework learner at Term 1 receives: `[Python]`

---

## Course Group Role

- A `course_group` belongs to one Programme (`course_groups.programme_id`).
- The `course_group_courses` join table maps: `course_group_id` + `class_id` + `academic_period_sequence` → `course_id`.
- A learner's Course Group is read **directly** from `programme_enrollments.course_group_id` (never inferred from their existing course history, so brand-new learners resolve correctly).

### Admin Configuration

**Configure Foundation Term 1 → Robotics, Term 2 → IoT:**

```http
PUT /api/course-groups/:id/classes/:foundationClassId/courses
{
  "courses": [
    { "courseId": "robotics-id", "academicPeriodSequence": 1, "sortOrder": 0 },
    { "courseId": "iot-id",      "academicPeriodSequence": 2, "sortOrder": 0 }
  ]
}
```

**Legacy API** (`courseIds` string array) still works — all courses default to `academicPeriodSequence=1`.

---

## Learning Instance Role

- Each Learning Instance owns its Academic Periods (`learning_instance_academic_periods`).
- The **current** period is determined by comparing today's date against period `start_date`/`end_date`.
- Periods beyond the current one have **not begun** and are not granted, regardless of payment.
- Period-specific payment gating is enforced by `syncPeriodCourseEnrollments` via `getPeriodPaymentStatus`.

---

## Payment / Access Relationship

```
Registration
  └─ programme_enrollments (status=pending_payment)
       └─ Payment Received
            └─ activateEnrollmentCurriculum()
                 1. Grant requested_course_ids (for Individual Course or seed courses)
                 2. SKIP legacy class-wide sync (for structured journeys)
                 3. syncPeriodCourseEnrollments()
                      └─ For each eligible period (started + paid):
                           └─ resolveStructuredCourseCurriculum(userId, instanceId, period.sequence)
                                └─ course_group_courses WHERE sequence <= period.sequence
                                     └─ INSERT OR IGNORE INTO enrollments
```

---

## Promotion Relationship

When a learner is promoted (e.g., Foundation → Framework):

1. `users.class_id` is updated to the new class.
2. `programme_enrollments.class_id` is updated to the new class.
3. `syncCourseCurriculumForClass(userId, newClassId)` is called.
4. For **structured journeys**: identifies the current Academic Period from the learner's active Learning Instance. Calls `resolveStructuredCourseCurriculum(userId, instanceId, currentSequence)` — grants **only Framework courses up to the current period**.
5. Old Foundation courses remain in `enrollments` (historical access preserved, `INSERT OR IGNORE`).

**Foundation → Framework during Term 1:**
- Framework Term 1 courses granted ✓
- Framework Term 2/3 courses **not** granted ✓
- Foundation Term 1 courses **preserved** ✓

---

## Individual Course Boundary

Individual Course (`individual_course`) uses `requested_course_ids` stored in `programme_enrollments`. It is **completely isolated** from the structured curriculum resolver:

- `activateEnrollmentCurriculum` detects `individual_course` (or absence of structured structure) and skips `syncCourseCurriculumForClass` for the class-wide sync.
- `resolveStructuredCourseCurriculum` returns `[]` if no structured enrollment exists.
- No Course Group × Period configuration is required for Individual Courses.

---

## Migration Strategy

The `course_group_courses` table gained one new column:

```sql
academic_period_sequence INTEGER NOT NULL DEFAULT 1
```

The `UNIQUE` constraint was updated from `(course_group_id, class_id, course_id)` to `(course_group_id, class_id, course_id, academic_period_sequence)`, allowing the same course to appear in different periods for the same Level.

**All existing rows** have been assigned `academic_period_sequence = 1` (safe default — existing behaviour is unchanged for any configuration that was already in place).

The migration was performed via SQLite table-recreation (the only safe pattern for constraint changes in SQLite).

---

## Backward Compatibility

| Scenario | Before Phase 1 | After Phase 1 |
| --- | --- | --- |
| Individual Course | Works via `requested_course_ids` | Unchanged |
| Non-structured programme | Uses legacy `resolveCourseCurriculumForClass` | Unchanged |
| Structured journey (no periods) | Returns `[]` from syncPeriodCourseEnrollments | Unchanged |
| Structured journey (with periods) | Granted entire level curriculum in Term 1 | Now scoped to current period |
| PUT `/api/course-groups/:id/classes/:classId/courses` with `courseIds` | Worked | Still works (mapped to sequence=1) |

---

## Testing Strategy

Test file: [`server/test/structured-curriculum.test.js`](../../server/test/structured-curriculum.test.js)

| Test | Validates |
| --- | --- |
| Test 1 | Foundation Term 1 → Robotics only |
| Test 1b | Foundation Term 2 → Robotics + IoT (cumulative) |
| Test 2 | Framework Term 1 → Python, not Robotics |
| Test 3 | `activateEnrollmentCurriculum` grants Term 1 courses only when Term 1 is current |
| Test 4 | Term 2 courses not granted while Term 1 is current |
| Test 5 | Promotion Foundation→Framework during Term 1 grants Framework Term 1 only |
| Test 6 | Brand-new learner (zero enrollments) resolves curriculum via `programme_enrollments.course_group_id` |
| Test 7 | Individual Course uses `requested_course_ids`, not structured resolver |
| Test 8 | Non-structured programme learner returns `[]` from structured resolver |
