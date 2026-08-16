import { useState } from "react";
import { Modal, Button, FormField, Radio, Textarea } from "../../components/ui";
import { submitPromotionRecommendation } from "../../api/instructor";

/**
 * Promotion Subsystem (ABRS v2.1 §12), Checkpoint 4 report Remaining work
 * item 2 — instructor UI for submitting a promotion recommendation for a
 * learner currently in one of the instructor's assigned classes. Purely
 * additive: this recommendation only ever feeds into the Promotion
 * Policy's optional "requires instructor recommendation" criterion
 * (server/src/utils/promotionEngine.js) — it never itself promotes,
 * demotes, or otherwise changes the learner's Programme Level.
 */
export default function PromotionRecommendationModal({ learner, onClose, onSubmitted }) {
  const [recommends, setRecommends] = useState("yes");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (!learner) return null;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await submitPromotionRecommendation({ learnerId: learner.id, recommends: recommends === "yes", note: note.trim() || undefined });
      onSubmitted?.();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={!!learner}
      onClose={onClose}
      title={`Promotion recommendation — ${learner.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={submitting}>
            Submit recommendation
          </Button>
        </>
      }
    >
      <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
        This records whether you recommend {learner.name} for promotion to the next Programme Level. It's only used if their
        Programme's Promotion Policy requires an instructor recommendation — it doesn't promote them itself, and a new
        submission replaces your most recent one for their current level.
      </p>
      {error && <p className="text-helper" style={{ color: "var(--color-danger, #c0392b)", marginBottom: "var(--space-3)" }}>{error}</p>}
      <FormField label="Recommendation">
        <div style={{ display: "flex", gap: "var(--space-4)" }}>
          <Radio name="recommends" label="Recommend" checked={recommends === "yes"} onChange={() => setRecommends("yes")} />
          <Radio name="recommends" label="Do not recommend" checked={recommends === "no"} onChange={() => setRecommends("no")} />
        </div>
      </FormField>
      <FormField label="Note (optional)">
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the admin should know…" />
      </FormField>
    </Modal>
  );
}
