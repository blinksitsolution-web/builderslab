import { useEffect, useState } from "react";
import { Modal, Button, Badge, Skeleton } from "../../components/ui";
import { fetchLearnerEligibility } from "../../api/admin";

/**
 * Promotion Subsystem (ABRS v2.1 §12), Checkpoint 4 report Remaining work
 * item 3 — per-learner eligibility breakdown display. Purely read-only:
 * shows exactly what GET /api/promotion/eligibility/:learnerId already
 * computes (score/attendance/instructor-recommendation against the
 * Programme's configured Promotion Policy), the same data source Manual
 * and Automatic promotion already act on — this modal just makes it
 * visible before an admin decides.
 */
export default function PromotionEligibilityModal({ learner, onClose }) {
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!learner) return;
    let cancelled = false;
    setStatus("loading");
    fetchLearnerEligibility(learner.id)
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [learner]);

  if (!learner) return null;

  return (
    <Modal open={!!learner} onClose={onClose} title={`Promotion eligibility — ${learner.name}`} footer={<Button onClick={onClose}>Close</Button>}>
      {status === "loading" && <Skeleton height={16} width="60%" />}
      {status === "error" && <p className="text-helper">Couldn't load eligibility for this learner.</p>}
      {status === "ready" && result?.blocked && (
        <p className="text-helper">{result.reasons?.[0] || "This learner cannot currently be evaluated for promotion."}</p>
      )}
      {status === "ready" && !result?.blocked && (
        <>
          <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
            {result.fromClassName || "Current level"} → {result.toClassName || "Next level"}
          </p>
          <Badge tone={result.eligible ? "success" : "danger"}>{result.eligible ? "Eligible" : "Not eligible"}</Badge>

          {result.reasons?.length > 0 && (
            <ul style={{ marginTop: "var(--space-3)" }}>
              {result.reasons.map((reason, i) => (
                <li key={i} className="text-helper">
                  {reason}
                </li>
              ))}
            </ul>
          )}

          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "var(--space-4)" }}>
            <tbody>
              <tr>
                <td>Average score</td>
                <td>
                  {result.breakdown?.averageScore != null ? `${result.breakdown.averageScore.toFixed(1)}%` : "No graded record yet"}
                  {result.breakdown?.policy?.minAverageScore != null && (
                    <span className="text-helper"> (minimum required: {result.breakdown.policy.minAverageScore}%)</span>
                  )}
                </td>
              </tr>
              <tr>
                <td>Attendance</td>
                <td>
                  {result.breakdown?.attendancePercent != null ? `${result.breakdown.attendancePercent.toFixed(1)}%` : "No attendance record yet"}
                  {result.breakdown?.policy?.minAttendancePercent != null && (
                    <span className="text-helper"> (minimum required: {result.breakdown.policy.minAttendancePercent}%)</span>
                  )}
                  {result.breakdown?.attendanceSince && (
                    <div className="text-helper">since {result.breakdown.attendanceSince} (start of the current Programme Level)</div>
                  )}
                </td>
              </tr>
              <tr>
                <td>Instructor recommendation</td>
                <td>
                  {result.breakdown?.instructorRecommendation == null
                    ? "None submitted yet"
                    : result.breakdown.instructorRecommendation
                    ? "Recommended"
                    : "Not recommended"}
                  {result.breakdown?.policy?.requiresInstructorRecommendation && <span className="text-helper"> (required by policy)</span>}
                </td>
              </tr>
            </tbody>
          </table>

          {!result.breakdown?.policy && (
            <p className="text-helper" style={{ marginTop: "var(--space-3)" }}>
              No Promotion Policy is configured (or it's inactive) for this learner's Programme — they're eligibility-neutral,
              so this is informational only.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
