import { useEffect, useState } from "react";
import { Card, CardHeader, FormField, Input, Select, Checkbox, Button, DataTable, Alert, LoadingState, ErrorState, UnauthorizedState, ConfirmationDialog } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import { fetchCourseGroups, updateModule } from "../../api/admin";

/**
 * Modules & Seasons (Phase 27). Migrates legacy settingsModules()/
 * createModuleFromForm()/loadModulesSettingsList()/toggleModuleOpen()/
 * removeModule() — same POST/PATCH/DELETE /api/modules contracts. The
 * 409 "learners currently enrolled" backend error for delete is surfaced
 * as-is, matching legacy's alert(e.message) on failure.
 */
export default function SettingsModulesTab({ settings }) {
  const tab = settings.tabs.modules;
  const toast = useToast();

  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [ages, setAges] = useState("");
  const [weeks, setWeeks] = useState("");
  const [sequence, setSequence] = useState("");
  const [blurb, setBlurb] = useState("");
  const [courseGroupId, setCourseGroupId] = useState("");
  const [formError, setFormError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Course Groups this Module can be grouped under (an optional
  // cross-level grouping/tag, not part of the required academic
  // hierarchy). Loaded independently of the "course groups" settings tab
  // so this column works whether or not the admin has ever opened that
  // tab — a course group is only useful here once it exists, and creating
  // one is a Settings > Course Groups action.
  const [courseGroups, setCourseGroups] = useState([]);
  const [courseAssignError, setCourseAssignError] = useState(null);

  useEffect(() => {
    fetchCourseGroups().then(setCourseGroups).catch(() => setCourseGroups([]));
  }, []);

  async function handleAssignCourseGroup(moduleId, courseGroupId) {
    setCourseAssignError(null);
    try {
      await updateModule(moduleId, { courseGroupId: courseGroupId || null });
      await settings.reload("modules");
    } catch (e) {
      setCourseAssignError(e.message);
    }
  }

  if (tab.status === "loading" || tab.status === "idle") return <LoadingState label="Loading modules…" />;
  if (tab.status === "forbidden") return <UnauthorizedState description="Course management is limited to administrators." />;
  if (tab.status === "error") return <ErrorState description={tab.error} action={{ label: "Try again", onClick: () => settings.reload("modules") }} />;

  async function handleAdd() {
    setFormError(null);
    if (!id.trim() || !title.trim()) {
      setFormError("Course ID and title are required.");
      return;
    }
    setAdding(true);
    try {
      await settings.addModule({
        id: id.trim(),
        title: title.trim(),
        ages: ages.trim(),
        weeks: weeks ? Number(weeks) : null,
        sequence: sequence ? Number(sequence) : null,
        blurb: blurb.trim(),
        courseGroupId: courseGroupId || null,
      });
      setId("");
      setTitle("");
      setAges("");
      setWeeks("");
      setSequence("");
      setBlurb("");
      setCourseGroupId("");
      toast.success("Course added.");
    } catch (e) {
      setFormError(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleToggleOpen(moduleId, isOpen) {
    try {
      await settings.toggleModuleOpen(moduleId, isOpen);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleDelete() {
    // Rethrow after the toast: ConfirmationDialog's handleConfirm does
    // `await onConfirm(); onClose();` with no catch of its own — closing
    // the dialog unconditionally on a caught-and-swallowed failure would
    // look like the delete succeeded. Rethrowing keeps the dialog open
    // (its own try/finally still resets the spinner) so the admin can see
    // the error and retry.
    try {
      await settings.removeModule(deleteTarget.id);
      toast.success(`"${deleteTarget.title}" removed.`);
    } catch (e) {
      toast.error(e.message || "Couldn't remove this module.");
      throw e;
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <CardHeader title="Add a new module" subtitle={'The module ID is a short code used internally (e.g. "ROB-01") — it can\'t be changed later.'} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormField label="Course ID">
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. ROB-01" />
          </FormField>
          <FormField label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Robotics Fundamentals" />
          </FormField>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <FormField label="Ages">
            <Input value={ages} onChange={(e) => setAges(e.target.value)} placeholder="e.g. 9+" />
          </FormField>
          <FormField label="Weeks">
            <Input type="number" value={weeks} onChange={(e) => setWeeks(e.target.value)} placeholder="e.g. 8" />
          </FormField>
          <FormField label="Sequence (blank = elective)">
            <Input type="number" value={sequence} onChange={(e) => setSequence(e.target.value)} placeholder="e.g. 5" />
          </FormField>
        </div>
        <FormField label="Blurb">
          <Input value={blurb} onChange={(e) => setBlurb(e.target.value)} />
        </FormField>
        <FormField label="Course Group (optional)">
          <Select value={courseGroupId} onChange={(e) => setCourseGroupId(e.target.value)}>
            <option value="">Ungrouped</option>
            {courseGroups.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
        {formError && (
          <Alert variant="danger" className="animate-fade-in">
            {formError}
          </Alert>
        )}
        <div style={{ marginTop: 12 }}>
          <Button onClick={handleAdd} loading={adding}>
            Add module
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Course order & season"
          subtitle="Required order: Basic Hardware & Software → Programming & Scratching → IoT & Robotics → Graphic Design. Toggle which module(s) are currently open so registration only offers those."
        />
        {courseAssignError && (
          <Alert variant="danger" className="animate-fade-in">
            {courseAssignError}
          </Alert>
        )}
        <DataTable
          columns={[
            { key: "module", header: "Course", render: (m) => <span><code>{m.id}</code> {m.title}</span> },
            {
              key: "courseGroup",
              header: "Course Group",
              render: (m) => (
                <Select value={m.courseGroupId || ""} onChange={(e) => handleAssignCourseGroup(m.id, e.target.value)}>
                  <option value="">Ungrouped</option>
                  {courseGroups
                    .filter((c) => !m.programmeId || c.programmeId === m.programmeId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
              ),
            },
            { key: "sequence", header: "Sequence", render: (m) => m.sequence ?? "elective" },
            {
              key: "season",
              header: "Season",
              render: (m) => <Checkbox label="Open for enrolment" checked={!!m.isOpen} onChange={(e) => handleToggleOpen(m.id, e.target.checked)} />,
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (m) => (
                <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(m)}>
                  Remove
                </Button>
              ),
            },
          ]}
          rows={tab.data.modules}
          getRowKey={(m) => m.id}
        />
      </Card>

      <ConfirmationDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Remove module"
        confirmLabel="Remove"
        confirmVariant="danger"
      >
        Remove "{deleteTarget?.title}"? Learners currently enrolled in it must be unenrolled first.
      </ConfirmationDialog>
    </div>
  );
}
