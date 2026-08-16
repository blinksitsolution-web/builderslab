import { useEffect, useState } from "react";
import { Modal, Button, FormField, Input, Checkbox, Skeleton } from "../../components/ui";
import { fetchPromotionPolicy, savePromotionPolicy } from "../../api/admin";

/**
 * Promotion Subsystem (ABRS v2.1 §12), Checkpoint 4 report Remaining work
 * item 1 — admin UI for configuring a Programme's Promotion Policy. The
 * API (fetchPromotionPolicy/savePromotionPolicy) has existed since
 * Checkpoint 4; this is its first screen.
 *
 * A Promotion Policy is Programme-owned configuration (§2.2) — thresholds
 * left blank are stored as NULL, which the evaluation engine treats as
 * "not evaluated," never a silently-inferred default (see
 * promotionEngine.js). No policy row at all means every learner in this
 * Programme stays eligibility-neutral.
 */
export default function PromotionPolicyModal({ programmeId, programmeName, onClose, onSaved }) {
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [error, setError] = useState(null);
  const [minAverageScore, setMinAverageScore] = useState("");
  const [minAttendancePercent, setMinAttendancePercent] = useState("");
  const [requiresInstructorRecommendation, setRequiresInstructorRecommendation] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!programmeId) return;
    let cancelled = false;
    setStatus("loading");
    setError(null);
    fetchPromotionPolicy(programmeId)
      .then((policy) => {
        if (cancelled) return;
        setMinAverageScore(policy?.min_average_score != null ? String(policy.min_average_score) : "");
        setMinAttendancePercent(policy?.min_attendance_percent != null ? String(policy.min_attendance_percent) : "");
        setRequiresInstructorRecommendation(!!policy?.requires_instructor_recommendation);
        setIsActive(policy ? !!policy.is_active : true);
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [programmeId]);

  if (!programmeId) return null;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await savePromotionPolicy(programmeId, {
        minAverageScore: minAverageScore === "" ? null : Number(minAverageScore),
        minAttendancePercent: minAttendancePercent === "" ? null : Number(minAttendancePercent),
        requiresInstructorRecommendation,
        isActive,
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={!!programmeId}
      onClose={onClose}
      title={`Promotion Policy — ${programmeName || "Programme"}`}
      footer={
        status === "ready" && (
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              Save policy
            </Button>
          </>
        )
      }
    >
      {status === "loading" && <Skeleton height={16} width="60%" />}
      {status === "error" && <p className="text-helper">Couldn't load this Programme's Promotion Policy.</p>}
      {status === "ready" && (
        <>
          <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
            Leave a threshold blank to skip evaluating it — a blank field is never treated as zero. If nothing is configured
            here, every learner in this Programme is eligibility-neutral and can be promoted with no criteria checked.
          </p>
          {error && <p className="text-helper" style={{ color: "var(--color-danger, #c0392b)", marginBottom: "var(--space-3)" }}>{error}</p>}
          <FormField label="Minimum average score (%)">
            <Input
              type="number"
              min="0"
              max="100"
              value={minAverageScore}
              onChange={(e) => setMinAverageScore(e.target.value)}
              placeholder="Not evaluated"
            />
          </FormField>
          <FormField label="Minimum attendance (%)">
            <Input
              type="number"
              min="0"
              max="100"
              value={minAttendancePercent}
              onChange={(e) => setMinAttendancePercent(e.target.value)}
              placeholder="Not evaluated"
            />
          </FormField>
          <Checkbox
            label="Require a positive instructor recommendation"
            checked={requiresInstructorRecommendation}
            onChange={(e) => setRequiresInstructorRecommendation(e.target.checked)}
          />
          <div style={{ marginTop: "var(--space-3)" }}>
            <Checkbox label="Policy is active" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          </div>
          {!isActive && (
            <p className="text-helper">An inactive policy is kept on record but ignored — every learner in this Programme stays eligibility-neutral until it's reactivated.</p>
          )}
        </>
      )}
    </Modal>
  );
}
