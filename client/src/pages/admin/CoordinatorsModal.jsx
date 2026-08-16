import { useEffect, useState } from "react";
import { Modal, Button, Badge, Alert, LoadingState } from "../../components/ui";
import { useToast } from "../../context/ToastContext";
import { fetchSponsorCoordinators, resetCoordinatorPassword } from "../../api/admin";

const SCOPE_LABEL = { child: "Child only", adult: "Adult only", both: "Both" };

/**
 * Lists a sponsor's coordinator accounts (role 'parent', sponsor_id set —
 * see CreateCoordinatorModal.jsx for how they're created) and lets an
 * admin reset a coordinator's password if the original handover (shown
 * once at creation) was missed or lost. Opened from AdminSponsorsPage.jsx.
 */
export default function CoordinatorsModal({ sponsor, onClose }) {
  const toast = useToast();
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [coordinators, setCoordinators] = useState([]);
  const [resettingId, setResettingId] = useState(null);
  const [revealed, setRevealed] = useState(null); // { id, password } | null

  useEffect(() => {
    if (!sponsor) return;
    setStatus("loading");
    setRevealed(null);
    fetchSponsorCoordinators(sponsor.id)
      .then((result) => {
        setCoordinators(result.coordinators);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [sponsor]);

  if (!sponsor) return null;

  async function handleReset(c) {
    setResettingId(c.id);
    setRevealed(null);
    try {
      const result = await resetCoordinatorPassword(c.id);
      setRevealed({ id: c.id, password: result.temporaryPassword });
      toast.success(`New password generated for ${c.name}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setResettingId(null);
    }
  }

  return (
    <Modal open={!!sponsor} onClose={onClose} title={`Coordinators — ${sponsor.name}`} size="md">
      {status === "loading" && <LoadingState label="Loading coordinators…" />}
      {status === "error" && <Alert variant="danger">Couldn't load coordinators.</Alert>}
      {status === "ready" && coordinators.length === 0 && <p>No coordinator accounts yet — create one from the sponsor's "+ Coordinator" button.</p>}
      {status === "ready" && coordinators.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {coordinators.map((c) => (
            <div key={c.id} style={{ border: "1px solid var(--border-default, #e5e7eb)", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div>
                  <b>{c.name}</b> <Badge tone="neutral">{SCOPE_LABEL[c.scope] || c.scope}</Badge>
                  <div className="text-helper">{c.email}</div>
                  <div className="text-helper">
                    {c.childCount} learner{c.childCount === 1 ? "" : "s"} added{c.maxChildren != null ? ` (limit ${c.maxChildren})` : ""}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleReset(c)} loading={resettingId === c.id}>
                  Reset password
                </Button>
              </div>
              {revealed?.id === c.id && (
                <div style={{ marginTop: 8 }}>
                  <Alert variant="success">
                    New password: <span style={{ fontFamily: "monospace" }}>{revealed.password}</span> — hand this to {c.name} now, it won't be shown again.
                  </Alert>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
