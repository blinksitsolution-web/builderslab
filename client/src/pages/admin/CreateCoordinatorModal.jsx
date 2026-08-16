import { useState } from "react";
import { Modal, Button, FormField, Input, Radio, Alert } from "../../components/ui";
import { createCoordinator } from "../../api/admin";

/**
 * Create a coordinator account (a "parent" account created BY staff for
 * an NGO/MP/organization representative) tied to one sponsor, optionally
 * capped at a number of children. Opened from AdminSponsorsPage.jsx's
 * "+ Add Coordinator" action on a given sponsor row.
 *
 * Unlike every other account-creation form in this app, this one shows
 * the generated credentials after success instead of just closing —
 * they need to be handed over to the coordinator directly (there's no
 * self-service password reset flow appropriate here, since this account
 * was never self-registered).
 */
export default function CreateCoordinatorModal({ sponsor, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState(""); // optional — leave blank to auto-generate
  const [maxChildren, setMaxChildren] = useState("");
  const [scope, setScope] = useState("child");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { id, temporaryPassword } | null

  if (!sponsor) return null;

  async function handleCreate() {
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }
    let maxChildrenValue = null;
    if (maxChildren.trim() !== "") {
      const n = Number(maxChildren);
      if (!Number.isInteger(n) || n < 1) {
        setError("Max children must be a positive whole number, or left blank for no limit.");
        return;
      }
      maxChildrenValue = n;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await createCoordinator({
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || null,
        password: password || undefined,
        sponsorId: sponsor.id,
        maxChildren: maxChildrenValue,
        scope,
      });
      setResult(res);
      onCreated?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    if (saving) return;
    onClose();
  }

  return (
    <Modal
      open={!!sponsor}
      onClose={handleClose}
      title={result ? "Coordinator created" : `New coordinator — ${sponsor.name}`}
      size="sm"
      footer={
        result ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={handleClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleCreate} loading={saving}>
              Create coordinator
            </Button>
          </>
        )
      }
    >
      {result ? (
        <>
          <Alert variant="success">Account created. Hand these credentials to the coordinator directly — this is the only time the password is shown.</Alert>
          <div style={{ marginTop: 16, fontFamily: "monospace", background: "var(--surface-subtle, #f5f5f5)", padding: 12, borderRadius: 8 }}>
            <div>Email: {email.trim()}</div>
            <div>Password: {result.temporaryPassword || password}</div>
          </div>
        </>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <p className="text-helper" style={{ marginTop: 0 }}>
            Creates a parent-style login for this person to manage sponsored children under. Every child they add is automatically sponsored by <b>{sponsor.name}</b> — no separate
            per-child step needed.
          </p>
          <FormField label="Coordinator's full name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ama Boateng" />
          </FormField>
          <FormField label="Email" helperText="This becomes their login.">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormField>
          <FormField label="Phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </FormField>
          <FormField
            label="Who can this coordinator register?"
            helperText="Kids STEM and Adult Professional/Corporate/Bootcamp are different registration flows — pick which this coordinator is allowed to use. 'Both' lets them choose per learner."
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Radio name="coordinatorScope" label="Child learners only (Kids STEM)" checked={scope === "child"} onChange={() => setScope("child")} />
              <Radio name="coordinatorScope" label="Adult learners only (Professional/Corporate/Bootcamp)" checked={scope === "adult"} onChange={() => setScope("adult")} />
              <Radio name="coordinatorScope" label="Both — coordinator picks per learner" checked={scope === "both"} onChange={() => setScope("both")} />
            </div>
          </FormField>
          <FormField label="Temporary password" helperText="Leave blank to auto-generate one.">
            <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Auto-generate" />
          </FormField>
          <FormField label="Max children" helperText="How many learners this coordinator may add. Leave blank for no limit.">
            <Input type="number" min="1" value={maxChildren} onChange={(e) => setMaxChildren(e.target.value)} placeholder="No limit" />
          </FormField>
          {error && <Alert variant="danger">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}
