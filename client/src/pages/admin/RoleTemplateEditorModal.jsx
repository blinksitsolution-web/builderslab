import { useEffect, useState } from "react";
import { Modal, Button, FormField, Input, Textarea, Alert } from "../../components/ui";
import PermissionCheckboxGrid from "./PermissionCheckboxGrid";
import { useToast } from "../../context/ToastContext";

/**
 * Create/edit a Role Template (Phase 19). Mirrors legacy
 * openRoleTemplateEditor()/saveRoleTemplate() (dashboard.html): name is
 * fixed once created (matching the disabled `#rtName` input on edit), the
 * Super Administrator template's permission checkboxes are shown fully
 * checked and disabled (its permissions can never be reduced — enforced
 * server-side regardless, see server/src/routes/roleTemplates.js), and
 * saving omits `permissions` entirely for that one template rather than
 * sending a checkbox state the backend would ignore anyway.
 *
 * @param {object|null} template - null for "New Role Template", otherwise the existing template being edited
 * @param {boolean} open
 * @param {object} catalog - permission catalog (see api/roleTemplates.js fetchPermissionCatalog)
 * @param {() => void} onClose
 * @param {(id: string|null, payload: object) => Promise<void>} onSave
 */
export default function RoleTemplateEditorModal({ template, open, catalog, onClose, onSave }) {
  const toast = useToast();
  const isSuperAdminTemplate = !!template && template.name === "Super Administrator";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [checked, setChecked] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setName(template ? template.name : "");
    setDescription(template ? template.description || "" : "");
    setFormError(null);
    if (isSuperAdminTemplate && catalog) {
      // Every permission the catalog currently knows about — matches
      // legacy's `Object.entries(catalog).flatMap(...)` full-checked state.
      setChecked(new Set(Object.entries(catalog).flatMap(([mod, actions]) => Object.keys(actions).map((action) => `${mod}.${action}`))));
    } else {
      setChecked(new Set(template ? template.permissions : []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template, catalog]);

  if (!open) return null;

  function toggle(key) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSave() {
    setFormError(null);
    if (!template && !name.trim()) {
      setFormError("Name is required.");
      return;
    }
    setSaving(true);
    try {
      const payload = { description: description.trim() };
      if (!isSuperAdminTemplate) payload.permissions = Array.from(checked);
      if (template) {
        await onSave(template.id, payload);
      } else {
        await onSave(null, { ...payload, name: name.trim() });
      }
      toast.success(template ? "Role Template updated." : "Role Template created.");
      onClose();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={template ? `Edit ${template.name}` : "New Role Template"}
      size="lg"
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
      {isSuperAdminTemplate && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Alert variant="info">The Super Administrator template always has every permission — this can't be reduced.</Alert>
        </div>
      )}

      <FormField label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!!template} />
      </FormField>

      <FormField label="Description">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </FormField>

      <p className="text-label" style={{ margin: "var(--space-4) 0 var(--space-2)" }}>
        Permissions
      </p>
      <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: "var(--space-3)" }}>
        <PermissionCheckboxGrid groups={catalog} checked={checked} onToggle={toggle} disabled={isSuperAdminTemplate} />
      </div>

      {formError && (
        <div style={{ marginTop: "var(--space-3)" }}>
          <Alert variant="danger">{formError}</Alert>
        </div>
      )}
    </Modal>
  );
}
