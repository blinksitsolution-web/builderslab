import { useEffect, useState } from "react";
import { Modal, Button, Skeleton } from "../../components/ui";

const REVERSIBLE_ACTIONS = new Set(["promote", "auto_promote", "manual_promote"]);

/**
 * Bulk Promotion (final admin migration pass). Migrates legacy
 * viewPromotionLog() (dashboard.html) — same GET /api/promotion/log/:id
 * contract (see api/admin.js). Extended with a Reverse action for the
 * constitutional Promotion Subsystem entries (§12) — restores the
 * learner's prior Programme Level via POST /api/promotion/reverse and
 * records a new 'reversal' log entry pointing back at the original;
 * never touches campus, Academic Year, or financial status.
 */
export default function PromotionLogModal({ learner, loadLog, onReverse, onClose }) {
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [history, setHistory] = useState([]);
  const [reversingId, setReversingId] = useState(null);
  const [reverseError, setReverseError] = useState(null);

  function reload() {
    if (!learner) return;
    setStatus("loading");
    loadLog(learner.id)
      .then((rows) => {
        setHistory(rows);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }

  useEffect(() => {
    if (!learner) return;
    let cancelled = false;
    setStatus("loading");
    loadLog(learner.id)
      .then((rows) => {
        if (cancelled) return;
        setHistory(rows);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [learner, loadLog]);

  if (!learner) return null;

  async function handleReverse(logId) {
    if (!onReverse) return;
    setReverseError(null);
    setReversingId(logId);
    try {
      await onReverse(logId);
      reload();
    } catch (e) {
      setReverseError(e.message);
    } finally {
      setReversingId(null);
    }
  }

  return (
    <Modal open={!!learner} onClose={onClose} title={`Promotion history — ${learner.name}`} footer={<Button onClick={onClose}>Close</Button>}>
      {status === "loading" && <Skeleton height={16} width="60%" />}
      {status === "error" && <p className="text-helper">Couldn't load promotion history.</p>}
      {reverseError && <p className="text-helper" style={{ color: "var(--color-danger, #c0392b)" }}>{reverseError}</p>}
      {status === "ready" &&
        (history.length === 0 ? (
          <p className="text-helper">No promotion/repeat/transfer/graduation actions recorded yet for this learner.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Date</th>
                <th style={{ textAlign: "left" }}>Action</th>
                <th style={{ textAlign: "left" }}>From year</th>
                <th style={{ textAlign: "left" }}>To year</th>
                {onReverse && <th style={{ textAlign: "left" }}></th>}
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td>{r.action}</td>
                  <td>{r.from_year_name || "—"}</td>
                  <td>{r.to_year_name || "—"}</td>
                  {onReverse && (
                    <td>
                      {REVERSIBLE_ACTIONS.has(r.action) && !r.reversed_log_id && (
                        <Button variant="ghost" size="sm" loading={reversingId === r.id} onClick={() => handleReverse(r.id)}>
                          Reverse
                        </Button>
                      )}
                      {r.action === "reversal" && <span className="text-helper">reverses a prior entry</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </Modal>
  );
}
