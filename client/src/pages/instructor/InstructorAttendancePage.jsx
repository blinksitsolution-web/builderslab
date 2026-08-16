import { useState } from "react";
import { useInstructorAttendance } from "./useInstructorAttendance";
import { markAttendance } from "../../api/instructor";
import { useToast } from "../../context/ToastContext";
import { PageHeader, Card, Button, FormField, Select, DataTable, Skeleton, EmptyState, ErrorState } from "../../components/ui";

const STATUS_OPTIONS = [
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "absent", label: "Absent" },
];

/**
 * Instructor Attendance Register (Phase 12). Migrates legacy
 * instructorAttendance() / loadAttendanceRoster() / saveAttendance()
 * (dashboard.html) — same endpoints (GET /api/attendance/:moduleId,
 * POST /api/attendance), same default status ("present"), same behavior
 * (marking absent/late notifies the learner's parent server-side).
 */
export default function InstructorAttendancePage() {
  const toast = useToast();
  const {
    teaching,
    moduleId,
    setModuleId,
    classId,
    setClassId,
    date,
    setDate,
    audience,
    setAudience,
    status,
    roster,
    existing,
    errorMessage,
    reload,
    eligibleInstances,
    learningInstanceId,
    setLearningInstanceId,
  } = useInstructorAttendance();
  const [marks, setMarks] = useState({});
  const [saving, setSaving] = useState(false);

  if (teaching.status === "loading") {
    return (
      <div>
        <PageHeader title="Attendance Register" />
        <Skeleton height={120} width="100%" />
      </div>
    );
  }
  if (teaching.status === "error") {
    return <ErrorState description={teaching.errorMessage} action={{ label: "Try again", onClick: teaching.reload }} />;
  }
  if (teaching.modules.length === 0) {
    return (
      <div>
        <PageHeader title="Attendance Register" />
        <EmptyState title="No modules assigned yet" description="Once an administrator assigns you to a module, you can take attendance here." />
      </div>
    );
  }

  const selectedClass = teaching.classes.find((c) => c.id === classId) || null;

  function statusFor(learnerId) {
    if (marks[learnerId]) return marks[learnerId];
    const found = existing.find((a) => a.learner_id === learnerId);
    return found?.status || "present";
  }

  async function handleSave() {
    if (eligibleInstances.length > 1 && !learningInstanceId) {
      return toast.error("This module has more than one active run you're assigned to — choose which one this session is for.");
    }
    setSaving(true);
    try {
      const records = roster.map((l) => ({ learnerId: l.id, status: statusFor(l.id) }));
      await markAttendance({ moduleId, date, records, learningInstanceId: learningInstanceId || undefined });
      toast.success("Attendance saved. Parents of any absent/late learner have been notified.");
      setMarks({});
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title="Attendance Register" description="Mark today's attendance for a module." />
      <Card padding>
        <div className="grid-3">
          <FormField label="Course">
            <Select
              value={moduleId || ""}
              onChange={(e) => {
                setModuleId(e.target.value);
                setMarks({});
              }}
            >
              {teaching.modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setMarks({});
              }}
              style={{ padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-default)", width: "100%" }}
            />
          </FormField>
          {/* A Module can be taught to Child and Adult learners at once
             (Stage 3) — narrow the roster to just one session's audience
             rather than always showing both mixed together. Enforced
             server-side too (see routes/users.js, routes/attendance.js). */}
          <FormField label="Child/Adult" helperText="Only matters if this module has both">
            <Select
              value={audience}
              onChange={(e) => {
                setAudience(e.target.value);
                setMarks({});
              }}
            >
              <option value="both">Child and Adult learners</option>
              <option value="child">Child learners only</option>
              <option value="adult">Adult learners only</option>
            </Select>
          </FormField>
        </div>
        <div className="grid-3" style={{ marginTop: "var(--space-3)" }}>
          <FormField label="Class" helperText="Optional — narrows the roster to one class.">
            <Select
              value={classId || ""}
              onChange={(e) => {
                setClassId(e.target.value || null);
                setMarks({});
              }}
            >
              <option value="">All classes</option>
              {teaching.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          {eligibleInstances.length > 1 && (
            <FormField label="Which run/cohort?" helperText="This module currently has more than one active run you're assigned to — choose which one this session is for.">
              <Select value={learningInstanceId || ""} onChange={(e) => setLearningInstanceId(e.target.value)}>
                <option value="">Choose…</option>
                {eligibleInstances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name || i.id}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>
        {selectedClass?.campusName && (
          <p className="text-helper" style={{ marginTop: "var(--space-3)" }}>
            Campus: {selectedClass.campusName}
          </p>
        )}
      </Card>

      <div style={{ marginTop: "var(--space-6)" }}>
        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}
        {status !== "error" && (
          <DataTable
            loading={status === "loading"}
            rows={roster}
            getRowKey={(l) => l.id}
            emptyState={<EmptyState title="No learners enrolled" description="No learners are enrolled in this module yet." />}
            columns={[
              { key: "name", header: "Learner", render: (l) => l.name },
              {
                key: "status",
                header: "Status",
                render: (l) => (
                  <Select value={statusFor(l.id)} onChange={(e) => setMarks((m) => ({ ...m, [l.id]: e.target.value }))}>
                    {STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ),
              },
            ]}
          />
        )}
        {status === "ready" && roster.length > 0 && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <Button variant="primary" loading={saving} onClick={handleSave}>
              Save attendance
            </Button>
            <p className="text-helper" style={{ marginTop: "var(--space-2)" }}>
              Marking someone absent or late automatically messages their parent.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
