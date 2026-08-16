import { useEffect, useState } from "react";
import { Modal, Button, Card, CardHeader, FormField, Input, Textarea, Alert } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import OfferingTypeSettingsSections from "./OfferingTypeSettingsSections";
import OfferingTypeCertificatesPanel from "./OfferingTypeCertificatesPanel";
import OfferingTypeFeesPanel from "./OfferingTypeFeesPanel";
import OfferingTypeLandingPanel from "./OfferingTypeLandingPanel";

/**
 * Add / Configure Learning Offering Type (Phase 30). Migrates legacy
 * openOfferingTypeModal()/saveOfferingType() — same
 * POST/PATCH /api/learning-offerings/types... request shape:
 * { name, description, icon, color, learningGroupLabel, sortOrder, settings }.
 *
 * `existingType` is the full row from the list (already has `.settings`);
 * `settingsSchema` is the backend's DEFAULT_SETTINGS, used to seed a
 * brand-new type's form so every section renders with real defaults
 * instead of blanks, same as legacy.
 */
export default function OfferingTypeModal({ open, existingType, settingsSchema, certificateTemplates, onClose, onSave }) {
  const toast = useToast();
  const isEdit = !!existingType;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState("#8B5E3C");
  const [groupLabel, setGroupLabel] = useState("Class");
  const [sortOrder, setSortOrder] = useState(0);
  const [settings, setSettings] = useState(null);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open) return;
    const base = existingType ? existingType.settings : settingsSchema;
    setName(existingType?.name || "");
    setDescription(existingType?.description || "");
    setIcon(existingType?.icon || "");
    setColor(existingType?.color || "#8B5E3C");
    setGroupLabel(existingType?.learningGroupLabel || "Class");
    setSortOrder(existingType?.sortOrder ?? 0);
    // Deep-clone so edits don't mutate the list/schema in place.
    setSettings(JSON.parse(JSON.stringify(base || {})));
    setFormError(null);
  }, [open, existingType, settingsSchema]);

  if (!open || !settings) return null;

  function updateSectionField(sectionKey, fieldKey, value) {
    setSettings((current) => ({
      ...current,
      [sectionKey]: { ...(current[sectionKey] || {}), [fieldKey]: value },
    }));
  }

  function updateFeesField(key, value) {
    setSettings((current) => ({ ...current, fees: { ...(current.fees || {}), [key]: value } }));
  }

  function updateLandingField(key, value) {
    setSettings((current) => ({ ...current, landing: { ...(current.landing || {}), [key]: value } }));
  }

  function toggleCertTemplate(templateId, checked) {
    setSettings((current) => {
      const existing = current.certificates?.availableTemplateIds || [];
      const availableTemplateIds = checked ? [...existing, templateId] : existing.filter((id) => id !== templateId);
      return { ...current, certificates: { ...(current.certificates || {}), availableTemplateIds } };
    });
  }

  function setCertDefault(templateId) {
    setSettings((current) => ({ ...current, certificates: { ...(current.certificates || {}), defaultTemplateId: templateId } }));
  }

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Name is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await onSave(existingType?.id || null, {
        name: trimmedName,
        description: description.trim(),
        icon: icon.trim(),
        color,
        learningGroupLabel: groupLabel.trim() || "Class",
        sortOrder: Number(sortOrder) || 0,
        settings,
      });
      toast.success(isEdit ? "Learning Offering Type updated." : "Learning Offering Type created.");
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
      title={isEdit ? "Configure Learning Offering Type" : "New Learning Offering Type"}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {isEdit ? "Save changes" : "Create Learning Offering Type"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Card>
          <CardHeader title="Basics" />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12 }}>
              <FormField label="Name" required>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekend Coding Club" />
              </FormField>
              <FormField label="Display Order">
                <Input type="number" style={{ width: 100 }} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Description">
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </FormField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label="Icon (emoji or short code)">
                <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="🚀" />
              </FormField>
              <FormField label="Color">
                <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Learning Group label (Class / Batch / Cohort / Training Group…)">
              <Input value={groupLabel} onChange={(e) => setGroupLabel(e.target.value)} />
            </FormField>
          </div>
        </Card>

        <OfferingTypeSettingsSections settings={settings} onChange={updateSectionField} />

        <OfferingTypeCertificatesPanel
          certificates={settings.certificates}
          templates={certificateTemplates}
          onToggleTemplate={toggleCertTemplate}
          onChangeDefault={setCertDefault}
        />

        <OfferingTypeFeesPanel fees={settings.fees} onChange={updateFeesField} />

        <OfferingTypeLandingPanel landing={settings.landing} onChange={updateLandingField} />

        {formError && <Alert variant="danger">{formError}</Alert>}
      </div>
    </Modal>
  );
}
