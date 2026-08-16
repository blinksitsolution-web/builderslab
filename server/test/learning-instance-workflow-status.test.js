/**
 * Admin Workflow Redesign — unit coverage for
 * computeLearningInstanceWorkflowStatus() in utils/learningInstances.js,
 * the Programme Run completion/publish-readiness computation the guided
 * admin workflow (progress indicators + "prevent incomplete Programme
 * Runs from being published") is built on.
 *
 * Pure-function coverage: no server spin-up needed, since this function
 * only reads the already-built Learning Instance DTO shape and returns
 * derived booleans — it never queries the database itself.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");

// Point at a scratch DB file so requiring utils/learningInstances.js (which
// requires ../db/db at module load) never touches the real dev database —
// no query is actually issued by the pure function under test.
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wf-status-")), "scratch.db");

const { computeLearningInstanceWorkflowStatus } = require("../src/utils/learningInstances");

function baseInstance(overrides = {}) {
  return {
    participationStructure: null,
    activatedCourses: [],
    registrationWindowConfigured: false,
    deliveryModes: [],
    campusIds: [],
    feeGHS: null,
    academicStructure: null,
    academicPeriods: [],
    instructorId: null,
    assignedInstructors: [],
    ...overrides,
  };
}

test("workflow status: a brand-new Run (nothing configured) is missing every step and not ready to publish", () => {
  const status = computeLearningInstanceWorkflowStatus(baseInstance());
  assert.equal(status.readyToPublish, false);
  assert.ok(status.missingSteps.includes("Activate Participation Structures"));
  assert.ok(status.missingSteps.includes("Activate Courses"));
  assert.ok(status.missingSteps.includes("Configure Registration"));
  assert.ok(status.missingSteps.includes("Configure Delivery"));
  assert.ok(status.missingSteps.includes("Configure Pricing"));
  assert.ok(status.missingSteps.includes("Configure Academic Calendar"));
  assert.ok(status.missingSteps.includes("Assign Instructors"));
  // Academic Periods isn't applicable yet (no Academic Calendar structure
  // chosen), so it must not appear as "missing". Campuses, in contrast,
  // IS still applicable here — "not applicable" for Campuses is the
  // narrower case of delivery modes chosen AND all of them "online" (see
  // the dedicated online-only test below), not merely "delivery unset".
  assert.ok(!status.missingSteps.includes("Configure Academic Periods"));
});

test("workflow status: Configure Campuses is not applicable for an online-only Run", () => {
  const status = computeLearningInstanceWorkflowStatus(
    baseInstance({ deliveryModes: ["online"], campusIds: [] })
  );
  const campusStep = status.steps.find((s) => s.id === "campuses");
  assert.equal(campusStep.applicable, false);
  assert.equal(campusStep.complete, true);
});

test("workflow status: Configure Campuses IS required once any non-online delivery mode is present", () => {
  const status = computeLearningInstanceWorkflowStatus(
    baseInstance({ deliveryModes: ["online", "on_campus"], campusIds: [] })
  );
  const campusStep = status.steps.find((s) => s.id === "campuses");
  assert.equal(campusStep.applicable, true);
  assert.equal(campusStep.complete, false);
  assert.ok(status.missingSteps.includes("Configure Campuses"));
});

test("workflow status: Academic Periods step is not applicable until an Academic Calendar structure is chosen", () => {
  const status = computeLearningInstanceWorkflowStatus(baseInstance({ academicStructure: null }));
  const periodsStep = status.steps.find((s) => s.id === "academicPeriods");
  assert.equal(periodsStep.applicable, false);
  assert.equal(periodsStep.complete, true);
});

test("workflow status: Academic Periods must match the structure's expected count and be dated once a structure is chosen", () => {
  const incomplete = computeLearningInstanceWorkflowStatus(
    baseInstance({ academicStructure: "semester", academicPeriods: [{ startDate: "2026-01-01", endDate: null }] })
  );
  assert.equal(incomplete.steps.find((s) => s.id === "academicPeriods").complete, false);

  const complete = computeLearningInstanceWorkflowStatus(
    baseInstance({
      academicStructure: "semester",
      academicPeriods: [
        { startDate: "2026-01-01", endDate: "2026-06-01" },
        { startDate: "2026-06-02", endDate: "2026-12-01" },
      ],
    })
  );
  assert.equal(complete.steps.find((s) => s.id === "academicPeriods").complete, true);
});

test("workflow status: Assign Instructors is satisfied by at least one instructor_assignments row (dto.assignedInstructors), not by the legacy instructorId/Activated-Course fields", () => {
  // ABRS v2.2 §8.2 — instructor_assignments (server/src/db/migrate.js's
  // v40 consolidation) is the sole constitutional owner of Instructor
  // Assignment; every authorization/progress check reads it exclusively.
  // The legacy learning_instances.instructor_id ("lead instructor")
  // field and each Activated Course's own instructorId are separate,
  // narrower display/override fields that Manage Accounts' Instructor
  // Assignment screen never writes to — so neither one may satisfy this
  // step on its own anymore.
  const legacyRunLevelOnly = computeLearningInstanceWorkflowStatus(baseInstance({ instructorId: "u1", assignedInstructors: [] }));
  assert.equal(legacyRunLevelOnly.steps.find((s) => s.id === "instructors").complete, false);

  const legacyActivatedCourseOnly = computeLearningInstanceWorkflowStatus(
    baseInstance({ activatedCourses: [{ instructorId: "u1" }, { instructorId: "u2" }], assignedInstructors: [] })
  );
  assert.equal(legacyActivatedCourseOnly.steps.find((s) => s.id === "instructors").complete, false);

  const noAssignments = computeLearningInstanceWorkflowStatus(baseInstance({ assignedInstructors: [] }));
  assert.equal(noAssignments.steps.find((s) => s.id === "instructors").complete, false);

  const withAssignment = computeLearningInstanceWorkflowStatus(
    baseInstance({ assignedInstructors: [{ id: "ia1", instructorId: "u1", instructorName: "Test Instructor" }] })
  );
  assert.equal(withAssignment.steps.find((s) => s.id === "instructors").complete, true);
});

test("workflow status: readyToPublish is true once every applicable step is complete", () => {
  const status = computeLearningInstanceWorkflowStatus(
    baseInstance({
      participationStructure: "structured_school_club",
      activatedCourses: [{ instructorId: "u1" }],
      registrationWindowConfigured: true,
      deliveryModes: ["online"],
      campusIds: [],
      feeGHS: 500,
      academicStructure: "semester",
      academicPeriods: [
        { startDate: "2026-01-01", endDate: "2026-06-01" },
        { startDate: "2026-06-02", endDate: "2026-12-01" },
      ],
      instructorId: null,
      // ABRS v2.2 §8.2 — Assign Instructors now reads dto.assignedInstructors
      // (sourced from instructor_assignments) exclusively; see the
      // dedicated "Assign Instructors" test above.
      assignedInstructors: [{ id: "ia1", instructorId: "u1", instructorName: "Test Instructor" }],
    })
  );
  assert.equal(status.readyToPublish, true);
  assert.deepEqual(status.missingSteps, []);
});
