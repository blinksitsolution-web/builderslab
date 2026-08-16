import { useEffect, useState } from "react";
import { Modal, ConfirmationDialog, Button, FormField, Select, Checkbox } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

/**
 * Row-action modals for the Account Management screen (Phase 17) — each
 * migrates one legacy openModal(...) flow from dashboard.html's
 * adminAccounts() section (editLearnerClass, editLearnerModules,
 * promoteOne, editInstructorAssignments, deleteAdminAccount), against the
 * same backend endpoints (see api/admin.js). "Manage Access" (Role
 * Template/Custom Permission assignment) is intentionally not among these
 * — see the Phase 17 scope note in AccountManagementPage.jsx.
 */

export function LearnerClassModal({ account, classes, onClose, onSave }) {
  const toast = useToast();
  const [classId, setClassId] = useState(account?.class_id || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => setClassId(account?.class_id || ""), [account]);

  if (!account) return null;

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(account, classId || null);
      toast.success("Class updated.");
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`${account.name}'s class`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <FormField label="Class">
        <Select value={classId} onChange={(e) => setClassId(e.target.value)}>
          <option value="">Unassigned</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </FormField>
    </Modal>
  );
}

export function LearnerCampusModal({ account, campuses, onClose, onSave }) {
  const toast = useToast();
  const [campus, setCampus] = useState(account?.campus || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => setCampus(account?.campus || ""), [account]);

  if (!account) return null;

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(account, campus || null);
      toast.success("Campus updated.");
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`${account.name}'s campus`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <FormField label="Campus">
        <Select value={campus} onChange={(e) => setCampus(e.target.value)}>
          <option value="">Unassigned</option>
          {campuses.map((c) => (
            <option key={c.id || c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </Select>
      </FormField>
    </Modal>
  );
}

export function LearnerModulesModal({ account, modules, onClose, onSave }) {
  const toast = useToast();
  const [selected, setSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => setSelected(new Set(account?.courseIds || [])), [account]);

  if (!account) return null;

  function toggle(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(account, Array.from(selected));
      toast.success("Courses updated.");
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`${account.name}'s modules`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      {modules.length === 0 ? (
        <p className="text-helper">No modules exist yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {modules.map((m) => (
            <Checkbox key={m.id} label={m.title} checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
          ))}
        </div>
      )}
    </Modal>
  );
}

// Matches the existing ConfirmationDialog convention used elsewhere (see
// InstructorContinuousAssessmentsPage's handleDelete): onConfirm is left to
// throw on failure — ConfirmationDialog's own try/finally then leaves the
// dialog open rather than closing it — success is the only case toasted
// here.
export function PromoteDialog({ account, onClose, onConfirm }) {
  const toast = useToast();
  if (!account) return null;
  return (
    <ConfirmationDialog
      open={!!account}
      onClose={onClose}
      title={`Promote ${account.name}`}
      confirmLabel="Promote"
      onConfirm={async () => {
        await onConfirm(account);
        toast.success("Promoted.");
      }}
    >
      <p>They'll move up to the next class in sequence.</p>
    </ConfirmationDialog>
  );
}

// ABRS v2.2 §8.2 — Instructor Assignment is a Programme Run-owned concept:
// every grant an admin creates names one Active Learning Instance, then
// optionally narrows it to one Course/Programme Level/Campus available
// within THAT Run (a true cascade — each dropdown is scoped by the
// previous selection, never by the whole catalog). Leaving a dimension on
// "Any" means "every value of that dimension within this Run" (see
// server/src/utils/instructorScope.js). An instructor can hold any number
// Shared cascading Learning Instance -> Course/Programme Level/Campus
// grants editor (§8.2 Instructor Assignment). Extracted so the exact same
// constitutional editor is used both when assigning an ALREADY-CREATED
// instructor (InstructorAssignModal below) and when CREATING a new one
// (CreateAccountModal) — previously the create-account form had its own
// separate, older "Class(es)/Course(s) this instructor teaches" checkbox
// panel that posted classIds/courseIds, fields the backend's POST
// /api/users/staff route has never read (it only ever reads
// `assignments`, the same shape this editor produces) — so a newly
// created instructor's picks silently went nowhere and the account was
// left with zero instructor_assignments rows: invisible to their
// assigned learners' contact lists, no campus shown in Manage Accounts,
// and unable to be granted content-assignment access until an admin
// manually re-did the exact same picks a second time through this real
// editor after the fact. This is the fix — one editor, one contract,
// used everywhere an instructor's scope is set.
function emptyAssignmentRow() {
  return { key: `${Date.now()}-${Math.random()}`, learningInstanceId: "", courseId: "", classId: "", campusId: "" };
}

export function InstructorAssignmentFields({ instances, fetchOptions, rows, setRows, disabled }) {
  const toast = useToast();
  const [optionsByInstance, setOptionsByInstance] = useState({});

  async function ensureOptions(learningInstanceId) {
    if (!learningInstanceId || optionsByInstance[learningInstanceId]) return;
    try {
      const opts = await fetchOptions(learningInstanceId);
      setOptionsByInstance((current) => ({ ...current, [learningInstanceId]: opts }));
    } catch (e) {
      toast.error(e.message);
    }
  }

  // Prefetches options for every row's Learning Instance whenever `rows`
  // changes — not just the instance the admin actively just picked.
  // Without this, a row hydrated with an already-persisted assignment
  // (InstructorAssignModal's fetchExisting, below) never gets its
  // Course/Programme Level/Campus options fetched at all, because
  // handleInstanceChange (the only other caller of ensureOptions) only
  // fires on a live onChange event — never on the initial load of
  // existing data. The row's classId/courseId/campusId are still correct
  // in state either way, but with no matching <option> in the DOM the
  // <select> has nothing to render as selected, so it falls back to
  // displaying "Any" regardless of what's actually persisted — exactly
  // the "Programme Level dropdown only shows Any" / "reopening an
  // assignment shows Course = Any, Programme Level = Any, Campus = Any"
  // defect. Seeded demo instructors were unaffected only because nothing
  // ever exercised this same fetch-then-hydrate path for them in the
  // admin's own browser session.
  useEffect(() => {
    rows.forEach((r) => {
      if (r.learningInstanceId) ensureOptions(r.learningInstanceId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  function updateRow(key, patch) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function handleInstanceChange(key, learningInstanceId) {
    updateRow(key, { learningInstanceId, courseId: "", classId: "", campusId: "" });
    ensureOptions(learningInstanceId);
  }

  function addRow() {
    setRows((current) => [...current, emptyAssignmentRow()]);
  }
  function removeRow(key) {
    setRows((current) => (current.length > 1 ? current.filter((r) => r.key !== key) : [emptyAssignmentRow()]));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <p className="text-helper">
        Pick an Active Learning Instance, then optionally narrow it to one Course, Programme Level and/or Campus
        available within that run. Leave any of those on "Any" to grant every value of that dimension. Add more rows
        for additional runs or narrower grants — they'll only ever see and interact within these.
      </p>
      {rows.map((row) => {
        const opts = optionsByInstance[row.learningInstanceId] || { courses: [], classes: [], campuses: [] };
        return (
          <div
            key={row.key}
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1.4fr 1.2fr 1.2fr auto",
              gap: "var(--space-2)",
              alignItems: "end",
            }}
          >
            <FormField label="Active Learning Instance">
              <Select value={row.learningInstanceId} onChange={(e) => handleInstanceChange(row.key, e.target.value)} disabled={disabled}>
                <option value="">Select a Learning Instance…</option>
                {(instances || []).map((li) => (
                  <option key={li.id} value={li.id}>
                    {li.name || li.programmeName || li.courseTitle || "Unnamed run"}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Course">
              <Select
                value={row.courseId}
                onChange={(e) => updateRow(row.key, { courseId: e.target.value })}
                disabled={disabled || !row.learningInstanceId}
              >
                <option value="">Any</option>
                {opts.courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Programme Level">
              <Select
                value={row.classId}
                onChange={(e) => updateRow(row.key, { classId: e.target.value })}
                disabled={disabled || !row.learningInstanceId}
              >
                <option value="">Any</option>
                {opts.classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Campus">
              <Select
                value={row.campusId}
                onChange={(e) => updateRow(row.key, { campusId: e.target.value })}
                disabled={disabled || !row.learningInstanceId}
              >
                <option value="">Any</option>
                {opts.campuses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <Button variant="ghost" onClick={() => removeRow(row.key)} title="Remove this grant" disabled={disabled}>
              ✕
            </Button>
          </div>
        );
      })}
      <Button variant="secondary" onClick={addRow} disabled={disabled}>
        + Add another grant
      </Button>
    </div>
  );
}

export function rowsToAssignments(rows) {
  return rows
    .filter((r) => r.learningInstanceId)
    .map((r) => ({
      learningInstanceId: r.learningInstanceId,
      courseId: r.courseId || undefined,
      classId: r.classId || undefined,
      campusId: r.campusId || undefined,
    }));
}

export { emptyAssignmentRow };

export function InstructorAssignModal({ account, instances, onClose, onSave, fetchOptions, fetchExisting }) {
  const toast = useToast();
  const [rows, setRows] = useState([emptyAssignmentRow()]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setLoading(true);
    fetchExisting(account.id)
      .then((existing) => {
        if (cancelled) return;
        setRows(
          existing.length
            ? existing.map((a) => ({
                key: a.id,
                learningInstanceId: a.learningInstanceId,
                courseId: a.courseId || "",
                classId: a.classId || "",
                campusId: a.campusId || "",
              }))
            : [emptyAssignmentRow()]
        );
      })
      .catch((e) => toast.error(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  if (!account) return null;

  async function handleSave() {
    const assignments = rowsToAssignments(rows);
    setSaving(true);
    try {
      await onSave(account, assignments);
      toast.success("Assignments updated.");
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`Assign ${account.name}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={loading}>
            Save
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-helper">Loading current assignments…</p>
      ) : (
        <InstructorAssignmentFields instances={instances} fetchOptions={fetchOptions} rows={rows} setRows={setRows} disabled={saving} />
      )}
    </Modal>
  );
}

export function DeleteAdminDialog({ account, onClose, onConfirm }) {
  const toast = useToast();
  if (!account) return null;
  return (
    <ConfirmationDialog
      open={!!account}
      onClose={onClose}
      title={`Delete ${account.name}?`}
      confirmLabel="Delete"
      confirmVariant="danger"
      onConfirm={async () => {
        await onConfirm(account);
        toast.success("Administrator account deleted.");
      }}
    >
      <p>This permanently removes their administrator account. This can't be undone.</p>
    </ConfirmationDialog>
  );
}
