import { useEffect, useMemo, useState } from "react";
import { Modal, Button, FormField, Input, Select } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import { fetchProgrammesForOfferingType, fetchClassesForProgramme } from "../../api/admin";

/**
 * Participants / Adult Learners (final admin migration pass). Migrates
 * legacy openParticipantModal()/onParticipantOfferingTypeChange()/
 * onParticipantProgrammeChange()/createParticipant()/
 * openParticipantCreatedModal()/downloadParticipantCreds()/
 * viewAdultInstructors() (dashboard.html) — same
 * Offering Type -> Programme -> Batch/Cohort cascade and
 * POST /api/users/participants contract (see api/admin.js and
 * server/src/routes/users.js). Only Offering Types whose Enrollment
 * settings don't require a parent account are offered here — Kids STEM
 * stays on the parent-led registration flow exclusively, matching the same
 * rule the backend enforces server-side (programmeRequiresParent).
 */
export function ParticipantCreateModal({ open, offeringTypes, onClose, onCreated }) {
  const toast = useToast();
  const eligibleTypes = useMemo(() => offeringTypes.filter((t) => t.settings?.enrollment?.parentAccountRequired !== "yes"), [offeringTypes]);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [campus, setCampus] = useState("");
  const [educationLevel, setEducationLevel] = useState("None");
  const [offeringTypeId, setOfferingTypeId] = useState("");
  const [programmes, setProgrammes] = useState([]);
  const [programmeId, setProgrammeId] = useState("");
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedType = eligibleTypes.find((t) => t.id === offeringTypeId);
  const groupLabel = selectedType?.learningGroupLabel || "Batch/Cohort";

  useEffect(() => {
    if (!open) {
      setName("");
      setEmail("");
      setPhone("");
      setCampus("");
      setEducationLevel("None");
      setOfferingTypeId("");
      setProgrammes([]);
      setProgrammeId("");
      setClasses([]);
      setClassId("");
      setPassword("");
      setError("");
    }
  }, [open]);

  async function handleOfferingTypeChange(value) {
    setOfferingTypeId(value);
    setProgrammeId("");
    setClasses([]);
    setClassId("");
    if (!value) {
      setProgrammes([]);
      return;
    }
    const result = await fetchProgrammesForOfferingType(value);
    setProgrammes(result);
  }

  async function handleProgrammeChange(value) {
    setProgrammeId(value);
    setClassId("");
    if (!value) {
      setClasses([]);
      return;
    }
    const result = await fetchClassesForProgramme(value);
    setClasses(result);
  }

  async function handleCreate() {
    setError("");
    if (!name.trim() || !email.trim() || !classId) {
      setError("Name, email and a Batch/Cohort are required.");
      return;
    }
    const programme = programmes.find((p) => p.id === programmeId);
    setSaving(true);
    try {
      const result = await onCreated({
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || null,
        campus: campus.trim() || null,
        educationLevel,
        classId,
        password: password || undefined,
        corporateClientId: programme?.corporateClientId || null,
      });
      onClose();
      return result;
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Participant"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} loading={saving}>
            Create Participant
          </Button>
        </>
      }
    >
      <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
        Creates a learner account directly under a non-Kids-STEM offering — no parent account required.
      </p>
      <div className="grid-2">
        <FormField label="Full name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormField>
      </div>
      <div className="grid-2" style={{ marginTop: "var(--space-3)" }}>
        <FormField label="Phone">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </FormField>
        <FormField label="Campus (optional)">
          <Input value={campus} onChange={(e) => setCampus(e.target.value)} />
        </FormField>
      </div>
      <FormField label="Education level" style={{ marginTop: "var(--space-3)" }}>
        <Select value={educationLevel} onChange={(e) => setEducationLevel(e.target.value)}>
          <option value="None">None</option>
          <option value="Senior High">Senior High</option>
          <option value="Tertiary">Tertiary</option>
        </Select>
      </FormField>
      <FormField label="Offering Type" style={{ marginTop: "var(--space-3)" }}>
        <Select value={offeringTypeId} onChange={(e) => handleOfferingTypeChange(e.target.value)}>
          <option value="">— select —</option>
          {eligibleTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.icon ? `${t.icon} ` : ""}
              {t.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Programme" style={{ marginTop: "var(--space-3)" }}>
        <Select value={programmeId} onChange={(e) => handleProgrammeChange(e.target.value)} disabled={!offeringTypeId}>
          <option value="">{offeringTypeId ? "— select —" : "Select an Offering Type first"}</option>
          {programmes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label={groupLabel} style={{ marginTop: "var(--space-3)" }}>
        <Select value={classId} onChange={(e) => setClassId(e.target.value)} disabled={!programmeId}>
          <option value="">{!programmeId ? "Select a Programme first" : classes.length ? "— select —" : "No Batch/Cohort yet — create one from Programmes first"}</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Temporary password (blank = auto-generate)" style={{ marginTop: "var(--space-3)" }}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </FormField>
      {error && (
        <p style={{ color: "var(--color-danger-text)", marginTop: "var(--space-3)" }} className="text-helper">
          {error}
        </p>
      )}
    </Modal>
  );
}

export function ParticipantCredentialsModal({ result, onClose }) {
  if (!result) return null;
  const { name, email, temporaryPassword } = result;

  function download() {
    const blob = new Blob([`The Builders' Lab — participant login\n\nName: ${name}\nEmail: ${email}\nPassword: ${temporaryPassword}\n`], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "participant-credentials.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Modal
      open={!!result}
      onClose={onClose}
      title="Participant created"
      footer={
        <>
          {temporaryPassword && (
            <Button variant="ghost" onClick={download}>
              ⬇ Download
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <p className="text-helper">Share these login credentials with {name} — the password is shown only once.</p>
      <div style={{ marginTop: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <div>
          <strong>Email:</strong> {email}
        </div>
        {temporaryPassword && (
          <div>
            <strong>Temporary password:</strong> {temporaryPassword}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function InstructorsForLearnerModal({ learner, instructors, modules, groupLabel, onClose }) {
  if (!learner) return null;
  const titleFor = (mid) => modules.find((m) => m.id === mid)?.title || mid;
  return (
    <Modal open={!!learner} onClose={onClose} title={`Instructors for ${learner.name}`} footer={<Button onClick={onClose}>Close</Button>}>
      {instructors.length === 0 ? (
        <p className="text-helper">
          No instructor is currently assigned to teach this learner's {(groupLabel || "module").toLowerCase()}(s). Assign one from Manage Accounts → Assign on the instructor's row.
        </p>
      ) : (
        <ul>
          {instructors.map((i) => (
            <li key={i.id}>
              <strong>{i.name}</strong> — {i.moduleIds.map(titleFor).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
