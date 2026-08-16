import { useEffect, useState } from "react";
import { Modal, Button, FormField, Select, Alert } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import { fetchSponsors } from "../../api/admin";

/**
 * Attach or remove a sponsor on one learner's account — opened from
 * AccountDetailDrawer.jsx. Backend: PATCH /api/users/:userId/sponsor
 * (see routes/users.js). Attaching a sponsor only records who is
 * responsible for this learner's fees — it is not a payment event and
 * does not change payment_status/status/balance. The learner remains
 * gated by the normal payment rules until a real payment is recorded, or
 * the Hub separately grants a free-access override.
 */
export default function SponsorAssignModal({ account, onClose, onSave }) {
  const toast = useToast();
  const [sponsors, setSponsors] = useState([]);
  const [loadStatus, setLoadStatus] = useState("loading"); // loading | ready | error
  const [selectedId, setSelectedId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!account) return;
    setLoadStatus("loading");
    setError(null);
    setSelectedId(account.sponsorId || "");
    fetchSponsors()
      .then((list) => {
        setSponsors(list.filter((s) => s.isActive || s.id === account.sponsorId));
        setLoadStatus("ready");
      })
      .catch((e) => {
        setError(e.message);
        setLoadStatus("error");
      });
  }, [account]);

  if (!account) return null;

  async function handleSave(nextSponsorId) {
    setSaving(true);
    setError(null);
    try {
      await onSave(account.id, nextSponsorId || null);
      toast.success(nextSponsorId ? "Sponsor attached." : "Sponsor removed.");
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`Sponsor — ${account.name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {account.sponsorId && (
            <Button variant="danger" onClick={() => handleSave(null)} loading={saving}>
              Remove sponsor
            </Button>
          )}
          <Button onClick={() => handleSave(selectedId)} loading={saving} disabled={!selectedId || selectedId === account.sponsorId}>
            {account.sponsorId ? "Change sponsor" : "Attach sponsor"}
          </Button>
        </>
      }
    >
      {loadStatus === "loading" && <p>Loading sponsors…</p>}
      {loadStatus === "error" && <Alert variant="danger">{error}</Alert>}
      {loadStatus === "ready" && (
        <>
          {account.sponsorId && (
            <p className="text-helper" style={{ marginTop: 0 }}>
              Currently sponsored by <b>{account.sponsorName}</b>.
            </p>
          )}
          <FormField
            label="Sponsor"
            helperText="Attaching a sponsor records who is responsible for this learner's fees — it does not waive payment. The learner stays access-restricted until a payment is recorded (Paystack, or an admin confirming one under Payments) or the Hub separately grants a free-access override."
          >

            <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              <option value="">— Select a sponsor —</option>
              {sponsors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FormField>
          {sponsors.length === 0 && <p className="text-helper">No sponsors yet — create one from the Sponsors admin page first.</p>}
          {error && <Alert variant="danger">{error}</Alert>}
        </>
      )}
    </Modal>
  );
}
