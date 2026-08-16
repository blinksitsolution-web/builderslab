import { useEffect, useState } from "react";
import { Modal, Button, Card, CardHeader, FormField, Input, Textarea, Select, Badge, Alert } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import { fetchProgramme } from "../../api/admin";
import ProgrammeDefinitionStatus from "./ProgrammeDefinitionStatus";

const REPORT_MODES = [
  { value: "", label: "— inherit default —" },
  { value: "certificate_only", label: "Certificate only" },
  { value: "attendance_only", label: "Attendance only" },
  { value: "transcript_and_certificate", label: "Transcript + Certificate" },
];

// datetime-local <input> wants "YYYY-MM-DDTHH:mm"; the backend gives back a
// full ISO string. Same truncation legacy used (existing.startsAt.slice(0,16)).
function toDatetimeLocal(iso) {
  return iso ? iso.slice(0, 16) : "";
}
// Inverse — legacy's isoOrNull(): empty input -> null, else a real ISO string.
function fromDatetimeLocal(value) {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Add / Edit Programme (Phase 31). Migrates legacy openProgrammeModal()/
 * saveProgramme() — same POST/PATCH /api/learning-offerings/programmes...
 * request shape.
 *
 * Registration Window configuration (opens/deadline/force-open/
 * force-closed) does NOT live here — it belongs exclusively to the
 * Programme Run (§8.2/§16 Single Ownership Principle). Configure it via
 * LearningInstanceModal's Operational Configuration section instead. This
 * modal shows the *resolved* registration status read-only, sourced from
 * the Programme's active Run, purely as a convenience so an admin editing
 * a Programme can see at a glance whether registration is currently open.
 */
export default function ProgrammeModal({
  open,
  existingProgramme,
  offeringTypes,
  corporateClients,
  onClose,
  onSave,
  onNavigate,
  onOpenParticipationStructures,
  onOpenProgrammeLevels,
}) {
  const toast = useToast();
  const isEdit = !!existingProgramme;

  const [offeringTypeId, setOfferingTypeId] = useState("");
  const [name, setName] = useState("");
  const [durationLabel, setDurationLabel] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [groupLabel, setGroupLabel] = useState("");
  const [corporateClientId, setCorporateClientId] = useState("");
  const [reportOutputMode, setReportOutputMode] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [longDescription, setLongDescription] = useState("");
  const [projects, setProjects] = useState("");
  const [eligibilityAudience, setEligibilityAudience] = useState("both");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  // ABRS v2.1 Admin Workflow Redesign checkpoint, Part 1 — fetched fresh
  // (not read off the `existingProgramme` list-row prop, which omits it to
  // avoid the extra per-row queries a Programmes list would otherwise pay
  // for every row) the same way ProgrammeGroupsModal fetches its own copy
  // of the Programme rather than trusting the list row's shape.
  const [definitionStatus, setDefinitionStatus] = useState(null);

  useEffect(() => {
    if (!open) return;
    const p = existingProgramme;
    setOfferingTypeId(p?.offeringTypeId || (offeringTypes[0] && offeringTypes[0].id) || "");
    setName(p?.name || "");
    setDurationLabel(p?.durationLabel || "");
    setSortOrder(p?.sortOrder ?? 0);
    setGroupLabel(p?.learningGroupLabel || "");
    setCorporateClientId(p?.corporateClientId || "");
    setReportOutputMode(p?.reportOutputMode || "");
    setImageFile(null);
    setLongDescription(p?.longDescription || "");
    setProjects((p?.projects || []).join("\n"));
    setEligibilityAudience(p?.eligibilityAudience || "both");
    setStartsAt(toDatetimeLocal(p?.startsAt));
    setEndsAt(toDatetimeLocal(p?.endsAt));
    setFormError(null);
    setDefinitionStatus(null);
    if (p?.id) {
      fetchProgramme(p.id)
        .then((full) => setDefinitionStatus(full.programmeDefinitionStatus || null))
        .catch(() => {}); // non-fatal — the panel just stays hidden if this fails
    }
  }, [open, existingProgramme, offeringTypes]);

  if (!open) return null;

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Name is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        name: trimmedName,
        durationLabel: durationLabel.trim() || null,
        sortOrder: Number(sortOrder) || 0,
        learningGroupLabel: groupLabel.trim() || null,
        corporateClientId: corporateClientId || null,
        reportOutputMode: reportOutputMode || null,
        longDescription: longDescription.trim() || null,
        projects: projects.split("\n").map((s) => s.trim()).filter(Boolean),
        eligibilityAudience,
        startsAt: fromDatetimeLocal(startsAt),
        endsAt: fromDatetimeLocal(endsAt),
      };
      if (!isEdit) payload.offeringTypeId = offeringTypeId;
      await onSave(existingProgramme?.id || null, payload, imageFile);
      toast.success(isEdit ? "Programme updated." : "Programme created.");
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
      title={isEdit ? "Edit Programme" : "New Programme"}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {isEdit ? "Save changes" : "Create Programme"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ color: "var(--text-muted, #6b7280)", margin: 0 }}>
          A Programme is the actual course/offering a learner registers for — e.g. "Builders Lab", "Robotics", or one corporate client's workshop.
        </p>

        {isEdit && (
          <ProgrammeDefinitionStatus
            programmeDefinitionStatus={definitionStatus}
            programmeId={existingProgramme?.id}
            onNavigate={onNavigate}
            onOpenParticipationStructures={onOpenParticipationStructures}
            onOpenProgrammeLevels={onOpenProgrammeLevels}
          />
        )}

        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormField label="Offering Type">
              <Select value={offeringTypeId} onChange={(e) => setOfferingTypeId(e.target.value)} disabled={isEdit}>
                {offeringTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.icon || ""} {t.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Robotics" />
            </FormField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label="Duration label">
                <Input value={durationLabel} onChange={(e) => setDurationLabel(e.target.value)} placeholder="e.g. 12 weeks" />
              </FormField>
              <FormField label="Sort order">
                <Input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Learning Group label override" helperText="Blank = use the Offering Type's default.">
              <Input value={groupLabel} onChange={(e) => setGroupLabel(e.target.value)} placeholder="e.g. Cohort" />
            </FormField>
            <FormField label="Corporate Client" helperText="Only for a Corporate Training programme.">
              <Select value={corporateClientId} onChange={(e) => setCorporateClientId(e.target.value)}>
                <option value="">— none —</option>
                {corporateClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Report output mode">
              <Select value={reportOutputMode} onChange={(e) => setReportOutputMode(e.target.value)}>
                {REPORT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        </Card>

        <Card>
          <CardHeader title="Public registration details" subtitle="Mainly for Bootcamps, but available to any programme." />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormField label="Image">
              <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] || null)} />
            </FormField>
            {existingProgramme?.imagePath && <img src={existingProgramme.imagePath} alt="" style={{ maxWidth: 160, borderRadius: 8 }} />}
            <FormField label="Description">
              <Textarea rows={3} value={longDescription} onChange={(e) => setLongDescription(e.target.value)} placeholder="Shown on the public registration card" />
            </FormField>
            <FormField label="Project(s) to be built" helperText="One per line.">
              <Textarea rows={3} value={projects} onChange={(e) => setProjects(e.target.value)} />
            </FormField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label="Eligibility">
                <Select value={eligibilityAudience} onChange={(e) => setEligibilityAudience(e.target.value)}>
                  <option value="both">Adults & Children</option>
                  <option value="adults">Adults only</option>
                  <option value="children">Children only</option>
                </Select>
              </FormField>
              <FormField label="Registration status" helperText="Read-only — configure the actual window from the Programme Run's Operational Configuration.">
                {existingProgramme ? (
                  <div style={{ paddingTop: 6 }}>
                    <Badge tone={existingProgramme.registrationOpen ? "success" : "neutral"}>{existingProgramme.registrationOpen ? "Open" : "Closed"}</Badge>
                    {existingProgramme.registrationForceOpen && <span style={{ marginLeft: 6, color: "var(--text-muted, #6b7280)" }}>(force-opened by admin)</span>}
                    {existingProgramme.registrationForceClosed && <span style={{ marginLeft: 6, color: "var(--text-muted, #6b7280)" }}>(force-closed by admin)</span>}
                  </div>
                ) : (
                  <p style={{ color: "var(--text-muted, #6b7280)", margin: 0, paddingTop: 6 }}>— save first, then configure the active Run's Operational Configuration —</p>
                )}
              </FormField>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label="Starts">
                <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
              </FormField>
              <FormField label="Ends">
                <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
              </FormField>
            </div>
          </div>
        </Card>

        {formError && <Alert variant="danger">{formError}</Alert>}
      </div>
    </Modal>
  );
}
