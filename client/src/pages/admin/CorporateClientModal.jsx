import { useEffect, useState } from "react";
import { Modal, Button, FormField, Input, Select, Alert } from "../../components/ui";
import { useToast } from "../../context/ToastContext";

const REPORT_MODES = [
  { value: "certificate_only", label: "Certificate only" },
  { value: "attendance_only", label: "Attendance only" },
  { value: "transcript_and_certificate", label: "Transcript + Certificate" },
];

/**
 * Add / Edit Corporate Client (Phase 33). Migrates legacy
 * openCorporateClientModal()/saveCorporateClient() — same POST/PATCH
 * /api/learning-offerings/corporate-clients... request shape, including
 * the logo upload as a separate follow-up request after create/update,
 * same as legacy's DTL.uploadCorporateClientLogo() call.
 */
export default function CorporateClientModal({ open, existingClient, onClose, onSave }) {
  const toast = useToast();
  const isEdit = !!existingClient;

  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [reportMode, setReportMode] = useState("certificate_only");
  const [logoFile, setLogoFile] = useState(null);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (!open) return;
    const c = existingClient;
    setName(c?.name || "");
    setContactName(c?.contactName || "");
    setContactPhone(c?.contactPhone || "");
    setContactEmail(c?.contactEmail || "");
    setReportMode(c?.defaultReportOutputMode || "certificate_only");
    setLogoFile(null);
    setFormError(null);
  }, [open, existingClient]);

  if (!open) return null;

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Company name is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        name: trimmedName,
        contactName: contactName.trim() || null,
        contactPhone: contactPhone.trim() || null,
        contactEmail: contactEmail.trim() || null,
        defaultReportOutputMode: reportMode,
      };
      await onSave(existingClient?.id || null, payload, logoFile);
      toast.success(isEdit ? "Corporate Client updated." : "Corporate Client created.");
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
      title={isEdit ? "Edit Corporate Client" : "New Corporate Client"}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {isEdit ? "Save changes" : "Create Corporate Client"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FormField label="Company name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. MTN Ghana" />
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

        <FormField label="Default report output mode">
          <Select value={reportMode} onChange={(e) => setReportMode(e.target.value)}>
            {REPORT_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Logo">
          <input type="file" accept="image/*" onChange={(e) => setLogoFile(e.target.files?.[0] || null)} />
        </FormField>
        {existingClient?.logoPath && <img src={existingClient.logoPath} alt="" style={{ maxWidth: 96, borderRadius: 8 }} />}

        {formError && <Alert variant="danger">{formError}</Alert>}
      </div>
    </Modal>
  );
}
