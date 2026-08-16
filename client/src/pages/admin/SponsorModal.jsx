import { useEffect, useState } from "react";
import { Modal, Button, FormField, Input, Select, Textarea, Alert } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

const SPONSOR_TYPES = [
  { value: "ngo", label: "NGO" },
  { value: "mp", label: "Member of Parliament" },
  { value: "corporate", label: "Corporate" },
  { value: "individual", label: "Individual" },
  { value: "other", label: "Other" },
];

/**
 * Add / Edit Sponsor. Mirrors CorporateClientModal.jsx's structure —
 * same kind of "organization" entity, same save/toast/error pattern.
 */
export default function SponsorModal({ open, existingSponsor, onClose, onSave }) {
  const toast = useToast();
  const isEdit = !!existingSponsor;

  const [name, setName] = useState("");
  const [type, setType] = useState("ngo");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [maxLearners, setMaxLearners] = useState("");

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open) return;
    const s = existingSponsor;
    setName(s?.name || "");
    setType(s?.type || "ngo");
    setContactName(s?.contactName || "");
    setContactPhone(s?.contactPhone || "");
    setContactEmail(s?.contactEmail || "");
    setNotes(s?.notes || "");
    setMaxLearners(s?.maxLearners != null ? String(s.maxLearners) : "");
    setFormError(null);
  }, [open, existingSponsor]);

  if (!open) return null;

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Sponsor name is required.");
      return;
    }
    let maxLearnersValue = null;
    if (maxLearners.trim() !== "") {
      const n = Number(maxLearners);
      if (!Number.isInteger(n) || n < 1) {
        setFormError("Max learners must be a positive whole number, or left blank for no limit.");
        return;
      }
      maxLearnersValue = n;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        name: trimmedName,
        type,
        contactName: contactName.trim() || null,
        contactPhone: contactPhone.trim() || null,
        contactEmail: contactEmail.trim() || null,
        notes: notes.trim() || null,
        maxLearners: maxLearnersValue,
      };
      await onSave(existingSponsor?.id || null, payload);
      toast.success(isEdit ? "Sponsor updated." : "Sponsor created.");
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
      title={isEdit ? "Edit Sponsor" : "New Sponsor"}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {isEdit ? "Save changes" : "Create Sponsor"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FormField label="Sponsor name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rotary Club of Accra" />
        </FormField>

        <FormField label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {SPONSOR_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </FormField>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormField label="Contact name">
            <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </FormField>
          <FormField label="Contact phone">
            <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
          </FormField>
        </div>

        <FormField label="Contact email">
          <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
        </FormField>

        <FormField label="Max sponsored learners" helperText="Total learners this sponsor may ever cover, across every coordinator tied to it. Leave blank for no limit.">
          <Input type="number" min="1" value={maxLearners} onChange={(e) => setMaxLearners(e.target.value)} placeholder="No limit" />
        </FormField>

        <FormField label="Notes" helperText="Internal only — funding terms, coverage scope, renewal dates, etc.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </FormField>

        {formError && <Alert variant="danger">{formError}</Alert>}
      </div>
    </Modal>
  );
}
