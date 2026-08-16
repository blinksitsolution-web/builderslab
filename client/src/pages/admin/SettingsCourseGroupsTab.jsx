import { useEffect, useState } from "react";
import { Card, CardHeader, FormField, Input, Select, Button, DataTable, Alert, LoadingState, ErrorState, UnauthorizedState, ConfirmationDialog, Badge } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import { fetchClassesForProgramme, fetchCourseGroup, setCourseGroupClassModules } from "../../api/admin";

/**
 * Course Groups — an optional cross-level grouping/tag over Modules. Not
 * part of the required academic hierarchy (Institution -> Learning
 * Offering Type -> Programme -> Programme Level -> Programme Run ->
 * Academic Structure -> Academic Period -> Course -> Lesson); this is
 * purely an admin-organisation convenience — e.g. tagging Builders' Lab's
 * "Robotics Engineering" as one track spanning Foundation/Framework/
 * Skyline, each with its own Module set via the curriculum mapping editor
 * below. Existing Modules are never auto-assigned here — grouping a
 * Module under a Course Group is always an explicit admin action (see
 * SettingsModulesTab's Course Group column), so nothing already relying
 * on Module identity changes meaning.
 */
export default function SettingsCourseGroupsTab({ settings }) {
  const tab = settings.tabs.courseGroups;
  const toast = useToast();

  const [programmeId, setProgrammeId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [mappingTarget, setMappingTarget] = useState(null);

  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label="Loading course groups…" />;
  if (tab.status === "forbidden") return <UnauthorizedState description="Course group management is limited to administrators." />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: () => settings.reload("courseGroups") }} />;

  const programmes = tab.data.programmes || [];

  async function handleAdd() {
    setFormError(null);
    if (!programmeId) {
      setFormError("Choose a programme.");
      return;
    }
    if (!name.trim()) {
      setFormError("Course group name is required.");
      return;
    }
    setAdding(true);
    try {
      await settings.addCourseGroup({ programmeId, name: name.trim(), description: description.trim() || null });
      setName("");
      setDescription("");
      toast.success("Course group added.");
    } catch (e) {
      setFormError(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete() {
    try {
      await settings.removeCourseGroup(deleteTarget.id);
      toast.success(`"${deleteTarget.name}" removed.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <CardHeader
          title="Add a course group"
          subtitle="A course group is an optional tag over several Courses — e.g. Builders' Lab's 'Robotics Engineering' course group ties several Courses together across levels."
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormField label="Programme">
            <Select value={programmeId} onChange={(e) => setProgrammeId(e.target.value)}>
              <option value="">Choose…</option>
              {programmes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Course group name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Robotics Engineering" />
          </FormField>
        </div>
        <FormField label="Description (optional)">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        {formError && (
          <Alert variant="danger" className="animate-fade-in">
            {formError}
          </Alert>
        )}
        <div style={{ marginTop: 12 }}>
          <Button onClick={handleAdd} loading={adding}>
            Add course group
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Course Groups"
          subtitle="Assign Courses to a course group from Settings > Courses & Seasons. Use 'Curriculum by level' to give a course group a different Course set at Foundation vs Framework vs Skyline."
        />
        <DataTable
          columns={[
            { key: "name", header: "Course Group", render: (c) => c.name },
            { key: "programme", header: "Programme", render: (c) => c.programmeName },
            { key: "status", header: "Status", render: (c) => <Badge tone={c.isActive ? "success" : "neutral"}>{c.isActive ? "Active" : "Inactive"}</Badge> },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (c) => (
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button variant="ghost" size="sm" onClick={() => setMappingTarget(c)}>
                    Curriculum by level
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => settings.saveCourseGroup(c.id, { isActive: !c.isActive }).catch((e) => toast.error(e.message))}
                  >
                    {c.isActive ? "Deactivate" : "Activate"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(c)}>
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
          rows={tab.data.courseGroups}
          getRowKey={(c) => c.id}
        />
      </Card>

      <ConfirmationDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Remove course group"
        confirmLabel="Remove"
        confirmVariant="danger"
      >
        Remove "{deleteTarget?.name}"? Modules currently grouped under it must be re-assigned or ungrouped first.
      </ConfirmationDialog>

      {mappingTarget && <CourseGroupClassCurriculumModal courseGroup={mappingTarget} onClose={() => setMappingTarget(null)} />}
    </div>
  );
}

// Per-Class(level) curriculum mapping — lets a Course Group present a
// different ordered Module set at each Class/level within its Programme
// (Foundation / Framework / Skyline, or whatever Classes exist for that
// Programme).
function CourseGroupClassCurriculumModal({ courseGroup, onClose }) {
  const toast = useToast();
  const [classes, setClasses] = useState([]);
  const [modules, setModules] = useState([]);
  const [classId, setClassId] = useState("");
  const [selectedModuleIds, setSelectedModuleIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchClassesForProgramme(courseGroup.programmeId), fetchCourseGroup(courseGroup.id)]).then(([cls, detail]) => {
      if (cancelled) return;
      setClasses(cls);
      setModules(detail.courses || []);
      const firstClassId = cls[0]?.id || "";
      setClassId(firstClassId);
      const existing = (detail.curriculumByClass || []).find((c) => c.classId === firstClassId);
      setSelectedModuleIds(existing ? existing.courses.map((m) => m.id) : []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseGroup.id]);

  async function handleClassChange(nextClassId) {
    setClassId(nextClassId);
    const detail = await fetchCourseGroup(courseGroup.id);
    const existing = (detail.curriculumByClass || []).find((c) => c.classId === nextClassId);
    setSelectedModuleIds(existing ? existing.courses.map((m) => m.id) : []);
  }

  // Phase 2 — selectedModuleIds is kept in display-order so the backend
  // receives courseIds in the admin's intended sort order.
  function toggleModule(moduleId) {
    setSelectedModuleIds((prev) =>
      prev.includes(moduleId)
        ? prev.filter((id) => id !== moduleId)
        : [...prev, moduleId]
    );
  }

  function moveModule(moduleId, direction) {
    setSelectedModuleIds((prev) => {
      const idx = prev.indexOf(moduleId);
      if (idx === -1) return prev;
      const next = [...prev];
      const swapIdx = idx + direction;
      if (swapIdx < 0 || swapIdx >= next.length) return prev;
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await setCourseGroupClassModules(courseGroup.id, classId, selectedModuleIds);
      toast.success("Curriculum saved for this level.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--surface, #fff)", borderRadius: 12, padding: 24, width: 480, maxWidth: "90vw", maxHeight: "80vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{courseGroup.name} — curriculum by level</h3>
        {loading ? (
          <LoadingState label="Loading…" />
        ) : classes.length === 0 ? (
          <Alert variant="info">This programme has no classes/levels configured yet.</Alert>
        ) : modules.length === 0 ? (
          <Alert variant="info">No modules are grouped under this course group yet — assign some from Settings &gt; Modules &amp; Seasons first.</Alert>
        ) : (
          <>
            <FormField label="Level">
              <Select value={classId} onChange={(e) => handleClassChange(e.target.value)}>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <p style={{ fontSize: 13, color: "var(--text-muted, #6b7280)" }}>
              Choose which of this course group's modules apply at this level and drag them into order. The order here is the order learners see the courses.
            </p>

            {/* Phase 2 — ordered selected list */}
            {selectedModuleIds.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: "var(--text-muted, #6b7280)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Selected (in order)
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {selectedModuleIds.map((id, idx) => {
                    const m = modules.find((mod) => mod.id === id);
                    if (!m) return null;
                    return (
                      <div
                        key={id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 10px",
                          border: "1px solid var(--border, #e5e7eb)",
                          borderRadius: 6,
                          background: "var(--surface-raised, #f9fafb)",
                        }}
                      >
                        <span style={{ fontSize: 11, color: "var(--text-muted, #9ca3af)", minWidth: 20, textAlign: "right" }}>
                          #{idx + 1}
                        </span>
                        <span style={{ flex: 1, fontSize: 14 }}>{m.title}</span>
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveModule(id, -1)}
                          style={{ background: "none", border: "none", cursor: idx === 0 ? "default" : "pointer", opacity: idx === 0 ? 0.3 : 1, padding: "2px 4px", fontSize: 14 }}
                          aria-label="Move up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={idx === selectedModuleIds.length - 1}
                          onClick={() => moveModule(id, 1)}
                          style={{ background: "none", border: "none", cursor: idx === selectedModuleIds.length - 1 ? "default" : "pointer", opacity: idx === selectedModuleIds.length - 1 ? 0.3 : 1, padding: "2px 4px", fontSize: 14 }}
                          aria-label="Move down"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleModule(id)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-danger-text, #dc2626)", padding: "2px 4px", fontSize: 13 }}
                          aria-label="Remove"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Modules not yet selected */}
            {modules.filter((m) => !selectedModuleIds.includes(m.id)).length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: "var(--text-muted, #6b7280)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Available to add
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {modules
                    .filter((m) => !selectedModuleIds.includes(m.id))
                    .map((m) => (
                      <div
                        key={m.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 10px",
                          border: "1px dashed var(--border, #e5e7eb)",
                          borderRadius: 6,
                        }}
                      >
                        <span style={{ flex: 1, fontSize: 14, color: "var(--text-muted, #6b7280)" }}>{m.title}</span>
                        <button
                          type="button"
                          onClick={() => toggleModule(m.id)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-primary-700, #1d4ed8)", padding: "2px 4px", fontSize: 13 }}
                          aria-label="Add"
                        >
                          + Add
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {selectedModuleIds.length === 0 && modules.length > 0 && (
              <p style={{ fontSize: 13, color: "var(--text-muted, #6b7280)", fontStyle: "italic", marginBottom: 12 }}>
                No courses selected for this level yet — add some from the list below.
              </p>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button onClick={handleSave} loading={saving}>
                Save
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
