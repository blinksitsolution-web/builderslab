import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, FormField, Input, Badge, Alert } from "../../components/ui";

/**
 * Course Library for a specific Bootcamp (or other run-scoped) Learning
 * Instance. Lets an admin search globally reusable Course records, assign
 * them to this run, or remove them — without duplicating Course entities.
 */
export default function LearningInstanceCourseLibrary({
  instanceName,
  modules,
  activatedCourses,
  onAssign,
  onRemove,
  busy,
  error,
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const activeAssignments = useMemo(
    () => activatedCourses.filter((row) => row.status === "active"),
    [activatedCourses]
  );
  const assignedIds = useMemo(() => new Set(activeAssignments.map((r) => r.courseId)), [activeAssignments]);

  const filteredModules = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = modules || [];
    if (!q) return list;
    return list.filter(
      (m) =>
        (m.title && m.title.toLowerCase().includes(q)) ||
        (m.id && m.id.toLowerCase().includes(q)) ||
        (m.programmeName && m.programmeName.toLowerCase().includes(q))
    );
  }, [modules, search]);

  function handleManageCourses() {
    navigate("/app/admin/settings?tab=modules", { state: { initialTab: "modules" } });
  }

  return (
    <FormField
      label="Course Library"
      helperText={`Choose which existing Courses this Learning Instance (${instanceName || "this run"}) will deliver. The same Course can be reused across multiple runs without creating duplicates.`}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search courses…"
            style={{ flex: 1, minWidth: 180 }}
            disabled={busy}
          />
          <Button variant="secondary" size="sm" onClick={handleManageCourses}>
            Manage Course Library
          </Button>
        </div>

        {error && <Alert variant="danger">{error}</Alert>}

        {filteredModules.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--text-muted, #6b7280)" }}>
            No courses found. Use <strong>Manage Course Library</strong> to create reusable Course records first.
          </div>
        )}

        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {filteredModules.map((course) => {
            const isAssigned = assignedIds.has(course.id);
            const assignment = activeAssignments.find((r) => r.courseId === course.id);
            return (
              <li
                key={course.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "8px 10px",
                  border: "1px solid var(--border, #e5e7eb)",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{course.title || course.id}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted, #6b7280)" }}>
                    {course.id}
                    {course.programmeName ? ` · ${course.programmeName}` : ""}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {isAssigned && <Badge tone="success">Selected</Badge>}
                  {isAssigned ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy}
                      onClick={() => onRemove(assignment)}
                    >
                      Remove
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" loading={busy} onClick={() => onAssign(course.id)}>
                      Select
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {activeAssignments.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted, #6b7280)" }}>
            {activeAssignments.length} course{activeAssignments.length !== 1 ? "s" : ""} assigned to this Learning Instance.
          </div>
        )}
      </div>
    </FormField>
  );
}
