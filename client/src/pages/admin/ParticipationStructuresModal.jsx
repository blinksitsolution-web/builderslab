import { useEffect, useState } from "react";
import { Modal, Button, FormField, Input, Select, Checkbox, DataTable, ConfirmationDialog, LoadingState, ErrorState, Badge } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import {
  fetchProgramme,
  fetchProgrammeParticipationStructuresForAdmin,
  createParticipationStructure,
  updateParticipationStructure,
  activateParticipationStructure,
  deactivateParticipationStructure,
  retireParticipationStructure,
} from "../../api/admin";

// "Who registers whom" — a fixed, small vocabulary the Participation
// Structure entity itself defines (ABRS v2.1 §10.2), not a per-Programme
// or per-offering-type business-identifier branch, so it's fine as a
// closed list here.
const REGISTRANT_ROLE_OPTIONS = [
  { value: "", label: "— not specified —" },
  { value: "parent", label: "Parent registers the learner" },
  { value: "self", label: "Learner registers themself" },
  { value: "parent_or_self", label: "Either parent or learner may register" },
];

const BLANK_FORM = {
  name: "",
  usesProgrammeLevels: false,
  usesPromotion: false,
  requiresCourseSelection: false,
  registrantRole: "",
  usesLongTermEnrollment: false,
  autoAssignsEntryLevel: false,
};

function statusBadge(s) {
  if (s.retiredAt) return <Badge tone="neutral">Retired</Badge>;
  if (s.isActive) return <Badge tone="success">Active</Badge>;
  return <Badge tone="warning">Inactive</Badge>;
}

/**
 * Participation Structure Administration (ABRS v2.1 §10, Appendix A-1;
 * Admin Workflow Redesign checkpoint Part 2) — Programme-scoped CRUD over
 * programme_participation_structures. These definitions belong to the
 * Programme, never the Programme Run (§10.1 Single Ownership) — this
 * modal is opened from AdminProgrammesPage's per-Programme row actions,
 * the same place Batches/Cohorts (ProgrammeGroupsModal) already opens
 * from, and follows the same load/mutate/refresh shape as that modal.
 */
export default function ParticipationStructuresModal({ open, programmeId, onClose, onChanged }) {
  const toast = useToast();
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [error, setError] = useState(null);
  const [programme, setProgramme] = useState(null);
  const [structures, setStructures] = useState([]);

  const [form, setForm] = useState(BLANK_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [editTarget, setEditTarget] = useState(null); // structure being edited
  const [editForm, setEditForm] = useState(BLANK_FORM);
  const [editError, setEditError] = useState(null);
  const [rowBusy, setRowBusy] = useState(null);
  const [retireTarget, setRetireTarget] = useState(null);

  async function load() {
    setStatus("loading");
    setError(null);
    try {
      const [p, list] = await Promise.all([fetchProgramme(programmeId), fetchProgrammeParticipationStructuresForAdmin(programmeId)]);
      setProgramme(p);
      setStructures(list);
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError(e.message);
    }
  }

  useEffect(() => {
    if (!open || !programmeId) return;
    setForm(BLANK_FORM);
    setCreateError(null);
    setEditTarget(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, programmeId]);

  if (!open) return null;

  async function refreshAfterChange() {
    const [p, list] = await Promise.all([fetchProgramme(programmeId), fetchProgrammeParticipationStructuresForAdmin(programmeId)]);
    setProgramme(p);
    setStructures(list);
    onChanged?.();
  }

  async function handleCreate() {
    const trimmed = form.name.trim();
    if (!trimmed) {
      setCreateError("Enter a name.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await createParticipationStructure(programmeId, { ...form, name: trimmed });
      setForm(BLANK_FORM);
      await refreshAfterChange();
    } catch (e) {
      setCreateError(e.message);
    } finally {
      setCreating(false);
    }
  }

  function startEdit(s) {
    setEditTarget(s);
    setEditForm({
      name: s.name,
      usesProgrammeLevels: s.usesProgrammeLevels,
      usesPromotion: s.usesPromotion,
      requiresCourseSelection: s.requiresCourseSelection,
      registrantRole: s.registrantRole || "",
      usesLongTermEnrollment: s.usesLongTermEnrollment,
      autoAssignsEntryLevel: s.autoAssignsEntryLevel,
    });
    setEditError(null);
  }

  async function handleSaveEdit() {
    const trimmed = editForm.name.trim();
    if (!trimmed) {
      setEditError("Name cannot be blank.");
      return;
    }
    setRowBusy(editTarget.id);
    try {
      await updateParticipationStructure(editTarget.id, { ...editForm, name: trimmed });
      setEditTarget(null);
      await refreshAfterChange();
    } catch (e) {
      setEditError(e.message);
    } finally {
      setRowBusy(null);
    }
  }

  async function handleActivate(s) {
    setRowBusy(s.id);
    try {
      await activateParticipationStructure(s.id);
      await refreshAfterChange();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRowBusy(null);
    }
  }

  async function handleDeactivate(s) {
    setRowBusy(s.id);
    try {
      await deactivateParticipationStructure(s.id);
      await refreshAfterChange();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRowBusy(null);
    }
  }

  async function handleRetire() {
    const target = retireTarget;
    setRowBusy(target.id);
    try {
      await retireParticipationStructure(target.id);
      setRetireTarget(null);
      await refreshAfterChange();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={programme ? `${programme.name} — Participation Structures` : "Participation Structures"}
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {status === "loading" && <LoadingState label="Loading…" />}
      {status === "error" && <ErrorState description={error} action={{ label: "Try again", onClick: load }} />}

      {status === "ready" && programme && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ color: "var(--text-muted, #6b7280)", margin: 0 }}>
            Participation Structures belong to this Programme (ABRS v2.1 §10) — Programme Runs only activate them, they never own or redefine them.
            Registration for this Programme is driven entirely by whichever Participation Structures a Programme Run activates.
          </p>

          <DataTable
            columns={[
              {
                key: "name",
                header: "Name",
                render: (s) =>
                  editTarget?.id === s.id ? (
                    <Input autoFocus value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
                  ) : (
                    <div>
                      <div>{s.name}</div>
                      <div style={{ color: "var(--text-muted, #6b7280)", fontSize: 12 }}>{s.key}</div>
                    </div>
                  ),
              },
              {
                key: "status",
                header: "Status",
                render: (s) => statusBadge(s),
              },
              {
                key: "config",
                header: "Configuration",
                render: (s) =>
                  editTarget?.id === s.id ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <Checkbox
                        label="Uses Programme Levels (progression)"
                        checked={editForm.usesProgrammeLevels}
                        onChange={(e) => setEditForm((f) => ({ ...f, usesProgrammeLevels: e.target.checked }))}
                      />
                      <Checkbox
                        label="Uses promotion"
                        checked={editForm.usesPromotion}
                        onChange={(e) => setEditForm((f) => ({ ...f, usesPromotion: e.target.checked }))}
                      />
                      <Checkbox
                        label="Requires course selection at registration"
                        checked={editForm.requiresCourseSelection}
                        onChange={(e) => setEditForm((f) => ({ ...f, requiresCourseSelection: e.target.checked }))}
                      />
                      <Checkbox
                        label="Uses long-term enrollment"
                        checked={editForm.usesLongTermEnrollment}
                        onChange={(e) => setEditForm((f) => ({ ...f, usesLongTermEnrollment: e.target.checked }))}
                      />
                      <Checkbox
                        label="Auto-assigns entry level"
                        checked={editForm.autoAssignsEntryLevel}
                        onChange={(e) => setEditForm((f) => ({ ...f, autoAssignsEntryLevel: e.target.checked }))}
                      />
                      <Select value={editForm.registrantRole} onChange={(e) => setEditForm((f) => ({ ...f, registrantRole: e.target.value }))}>
                        {REGISTRANT_ROLE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Button size="sm" loading={rowBusy === s.id} onClick={handleSaveEdit}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditTarget(null)}>
                          Cancel
                        </Button>
                      </div>
                      {editError && <span style={{ color: "var(--danger, #dc2626)", fontSize: 13 }}>{editError}</span>}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {s.usesProgrammeLevels && <Badge tone="neutral">Programme Levels</Badge>}
                      {s.usesPromotion && <Badge tone="neutral">Promotion</Badge>}
                      {s.requiresCourseSelection && <Badge tone="neutral">Course selection required</Badge>}
                      {s.usesLongTermEnrollment && <Badge tone="neutral">Long-term enrollment</Badge>}
                      {s.autoAssignsEntryLevel && <Badge tone="neutral">Auto-assigns entry level</Badge>}
                      {s.registrantRole && <Badge tone="neutral">{REGISTRANT_ROLE_OPTIONS.find((o) => o.value === s.registrantRole)?.label || s.registrantRole}</Badge>}
                    </div>
                  ),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (s) =>
                  s.retiredAt ? (
                    <span style={{ color: "var(--text-muted, #6b7280)", fontSize: 12 }}>Retired — read-only</span>
                  ) : (
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      {editTarget?.id !== s.id && (
                        <Button variant="ghost" size="sm" onClick={() => startEdit(s)}>
                          Edit
                        </Button>
                      )}
                      {s.isActive ? (
                        <Button variant="ghost" size="sm" loading={rowBusy === s.id} onClick={() => handleDeactivate(s)}>
                          Deactivate
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" loading={rowBusy === s.id} onClick={() => handleActivate(s)}>
                          Activate
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => setRetireTarget(s)}>
                        Retire
                      </Button>
                    </div>
                  ),
              },
            ]}
            rows={structures}
            getRowKey={(s) => s.id}
            emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No Participation Structures defined yet.</div>}
          />

          <div style={{ borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <strong>Add a Participation Structure</strong>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label="Name">
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Structured School Club" />
              </FormField>
              <FormField label="Who registers" helperText="Optional.">
                <Select value={form.registrantRole} onChange={(e) => setForm((f) => ({ ...f, registrantRole: e.target.value }))}>
                  {REGISTRANT_ROLE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              <Checkbox
                label="Uses Programme Levels (progression)"
                checked={form.usesProgrammeLevels}
                onChange={(e) => setForm((f) => ({ ...f, usesProgrammeLevels: e.target.checked }))}
              />
              <Checkbox label="Uses promotion" checked={form.usesPromotion} onChange={(e) => setForm((f) => ({ ...f, usesPromotion: e.target.checked }))} />
              <Checkbox
                label="Requires course selection at registration"
                checked={form.requiresCourseSelection}
                onChange={(e) => setForm((f) => ({ ...f, requiresCourseSelection: e.target.checked }))}
              />
              <Checkbox
                label="Uses long-term enrollment"
                checked={form.usesLongTermEnrollment}
                onChange={(e) => setForm((f) => ({ ...f, usesLongTermEnrollment: e.target.checked }))}
              />
              <Checkbox
                label="Auto-assigns entry level"
                checked={form.autoAssignsEntryLevel}
                onChange={(e) => setForm((f) => ({ ...f, autoAssignsEntryLevel: e.target.checked }))}
              />
            </div>
            <div>
              <Button onClick={handleCreate} loading={creating}>
                Add Participation Structure
              </Button>
            </div>
            {createError && <p style={{ color: "var(--danger, #dc2626)", margin: 0 }}>{createError}</p>}
          </div>

          <ConfirmationDialog
            open={!!retireTarget}
            onClose={() => setRetireTarget(null)}
            title={`Retire "${retireTarget?.name}"?`}
            confirmLabel="Retire"
            confirmVariant="danger"
            onConfirm={handleRetire}
          >
            This is permanent — a retired Participation Structure can no longer be edited, reactivated, or activated by a Programme Run. Deactivate instead
            if you may want to bring it back later.
          </ConfirmationDialog>
        </div>
      )}
    </Modal>
  );
}
