import { Badge, ProgressBar, Alert } from "../../components/ui";

/**
 * Guided-workflow completion panel for a Programme Run (ABRS v2.1 §15's
 * canonical ordering, Run-owned portion — Activate Participation
 * Structures through Assign Instructors). Reads `workflowStatus` off the
 * Learning Instance DTO (`computeLearningInstanceWorkflowStatus` on the
 * backend) — this component never re-derives completion itself, so the
 * admin UI and the backend's publish gate can never disagree about what
 * "ready" means.
 *
 * Purely presentational: "not applicable" steps (e.g. Configure Campuses
 * for an online-only Run) are shown as skipped, not as outstanding work.
 */
export default function ProgrammeRunWorkflowStatus({ workflowStatus, status }) {
  if (!workflowStatus) return null;
  const { steps, readyToPublish, missingSteps } = workflowStatus;
  const applicableSteps = steps.filter((s) => s.applicable);
  const doneCount = applicableSteps.filter((s) => s.complete).length;
  const pct = applicableSteps.length ? (doneCount / applicableSteps.length) * 100 : 100;
  const alreadyPublished = status && status !== "upcoming";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 8,
        background: "var(--surface-subtle, #f9fafb)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Programme Run setup</span>
        <Badge tone={readyToPublish ? "success" : "warning"}>
          {doneCount}/{applicableSteps.length} complete
        </Badge>
      </div>
      <ProgressBar value={pct} tone={readyToPublish ? "success" : "brand"} label="Programme Run setup progress" />
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {steps.map((step) => (
          <li
            key={step.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: step.applicable ? "inherit" : "var(--text-muted, #9ca3af)",
            }}
          >
            <span aria-hidden="true">
              {!step.applicable ? "—" : step.complete ? "✅" : "⬜"}
            </span>
            <span style={step.applicable && !step.complete ? { fontWeight: 600 } : undefined}>{step.label}</span>
            {!step.applicable && <span style={{ fontSize: 11 }}>(not applicable)</span>}
          </li>
        ))}
      </ul>
      {!readyToPublish && !alreadyPublished && (
        <Alert variant="warning" title="Not ready to publish yet">
          Complete the remaining setup steps before publishing this Programme Run: {missingSteps.join(", ")}.
        </Alert>
      )}
    </div>
  );
}
