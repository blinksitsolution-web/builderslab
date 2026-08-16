import { useEffect, useState } from "react";
import { Modal, Button, FormField, Input, DataTable, ConfirmationDialog, LoadingState, ErrorState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import { fetchProgramme, createLearningGroup, updateLearningGroup, deleteLearningGroup } from "../../api/admin";

/**
 * Programme Levels ("Learning Groups") under one Programme.
 *
 * ABRS v2.2 §11 / §13.5 / Appendix A-9 — this modal manages Programme
 * Levels ONLY (§13: progression — Foundation/Framework/Skyline and
 * equivalents). It used to also let an admin set a Tuition Fee, Delivery
 * Mode and Campus directly on a Learning Group; those three facts are
 * Operational Group overrides (§11.3), owned exclusively by the
 * Programme Run's Operational Groups (§8.2, §19), and the backend
 * (routes/classes.js) no longer accepts writes to them here — creating
 * or renaming a Programme Level can never again set an Operational Group
 * field, closing the "two owners of one fact" defect §2.1 forbids.
 *
 * Scheduling, pricing and delivery for a specific Batch/Cohort/Section
 * now live on that Programme's active Programme Run's Operational
 * Groups screen (AdminLearningInstancesPage → LearningInstanceModal),
 * which this modal links out to via the optional onManageOperationalGroups
 * callback (a no-op if the caller doesn't wire one up, so this modal
 * degrades gracefully wherever it's still mounted standalone).
 */
export default function ProgrammeGroupsModal({ open, programmeId, onClose, onChanged, onManageOperationalGroups }) {
  const toast = useToast();
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [error, setError] = useState(null);
  const [programme, setProgramme] = useState(null);

  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);

  const [renameTarget, setRenameTarget] = useState(null); // group being renamed
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [rowBusy, setRowBusy] = useState(null);

  const load = async () => {
    setStatus("loading");
    setError(null);
    try {
      const p = await fetchProgramme(programmeId);
      setProgramme(p);
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError(e.message);
    }
  };

  useEffect(() => {
    if (!open || !programmeId) return;
    setNewName("");
    setAddError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, programmeId]);

  if (!open) return null;

  // ABRS v2.1 Admin Workflow Redesign checkpoint, Part 3 — when this
  // Programme's own Participation Structure configuration says it uses
  // progression (usesProgrammeLevels, resolved server-side and returned as
  // `programme.usesProgrammeLevels` — never a hardcoded programme/offering-
  // type name check), the constitutional term "Programme Level" is shown
  // consistently here instead of whatever free-text learningGroupLabel
  // happens to be set. When progression doesn't apply, this table's
  // pre-existing per-Programme label (learningGroupLabel, e.g. "Batch" or
  // "Cohort") is unchanged — "Programme Level" must never appear where
  // it isn't applicable.
  const label = programme?.usesProgrammeLevels ? "Programme Level" : programme?.learningGroupLabel || "Class";

  async function refreshAfterChange() {
    const p = await fetchProgramme(programmeId);
    setProgramme(p);
    onChanged?.();
  }

  async function handleAdd() {
    const trimmed = newName.trim();
    if (!trimmed) {
      setAddError("Enter a name.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await createLearningGroup({ name: trimmed, programmeId });
      setNewName("");
      await refreshAfterChange();
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setRowBusy(renameTarget.id);
    try {
      await updateLearningGroup(renameTarget.id, { name: trimmed });
      setRenameTarget(null);
      await refreshAfterChange();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRowBusy(null);
    }
  }

  async function handleDelete() {
    const target = deleteTarget;
    setRowBusy(target.id);
    try {
      await deleteLearningGroup(target.id);
      setDeleteTarget(null);
      await refreshAfterChange();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={programme ? `${programme.name} — ${label}s` : "Learning Groups"} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      {status === "loading" && <LoadingState label="Loading…" />}
      {status === "error" && <ErrorState description={error} action={{ label: "Try again", onClick: load }} />}

      {status === "ready" && programme && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ color: "var(--text-muted, #6b7280)", margin: 0 }}>
            {programme.moduleCount} module(s) belong to this programme. {label}s describe progression only — add, rename, or reorder them below.
          </p>
          <p style={{ color: "var(--text-muted, #6b7280)", margin: 0, fontSize: 13 }}>
            Looking to set a fee, delivery mode, campus, capacity, instructor, schedule or closing date for a specific
            Batch/Cohort/Section? That's an Operational Group setting, configured on this Programme's active Programme
            Run.
            {onManageOperationalGroups && (
              <>
                {" "}
                <Button size="sm" variant="ghost" onClick={() => onManageOperationalGroups(programmeId)}>
                  Manage Operational Groups
                </Button>
              </>
            )}
          </p>

          <DataTable
            columns={[
              {
                key: "name",
                header: label,
                render: (g) =>
                  renameTarget?.id === g.id ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <Input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
                      <Button size="sm" loading={rowBusy === g.id} onClick={handleRename}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenameTarget(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    g.name
                  ),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (g) => (
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRenameTarget(g);
                        setRenameValue(g.name);
                      }}
                    >
                      Rename
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(g)}>
                      Delete
                    </Button>
                  </div>
                ),
              },
            ]}
            rows={programme.learningGroups || []}
            getRowKey={(g) => g.id}
            emptyState={<div style={{ padding: 24, color: "var(--text-muted, #6b7280)" }}>No {label}s yet.</div>}
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "end" }}>
            <FormField label={`New ${label} name`}>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Framework" />
            </FormField>
            <Button onClick={handleAdd} loading={adding}>
              Add {label}
            </Button>
          </div>
          {addError && <p style={{ color: "var(--danger, #dc2626)", margin: 0 }}>{addError}</p>}

          <ConfirmationDialog
            open={!!deleteTarget}
            onClose={() => setDeleteTarget(null)}
            title={`Delete this ${label}?`}
            confirmLabel="Delete"
            confirmVariant="danger"
            onConfirm={handleDelete}
          >
            Learners assigned to it must be reassigned first. This can't be undone.
          </ConfirmationDialog>
        </div>
      )}
    </Modal>
  );
}
