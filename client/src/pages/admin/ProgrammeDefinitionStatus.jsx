import { useNavigate } from "react-router-dom";
import { Badge, ProgressBar, Alert, Button } from "../../components/ui";

/**
 * Guided-workflow completion panel for a Programme's own definition
 * (ABRS v2.1 Admin Workflow Redesign checkpoint, Part 1 — Learning
 * Offering Type -> Programme -> Course Library -> Participation Structure
 * Definitions -> Programme Levels where applicable). Mirrors
 * ProgrammeRunWorkflowStatus's shape and reads `programmeDefinitionStatus`
 * straight off the Programme detail DTO (computeProgrammeDefinitionStatus
 * on the backend) so this panel and the backend can never disagree about
 * what "fully defined" means.
 *
 * Provides interactive one-click actions for each step in the wizard.
 */
export default function ProgrammeDefinitionStatus({
  programmeDefinitionStatus,
  programmeId,
  onNavigate,
  onOpenParticipationStructures,
  onOpenProgrammeLevels,
}) {
  const navigate = useNavigate();
  if (!programmeDefinitionStatus) return null;
  const { steps, complete, missingSteps } = programmeDefinitionStatus;
  const applicableSteps = steps.filter((s) => s.applicable);
  const doneCount = applicableSteps.filter((s) => s.complete).length;
  const pct = applicableSteps.length ? (doneCount / applicableSteps.length) * 100 : 100;

  const handleNav = (path, options) => {
    if (onNavigate) {
      onNavigate(path, options);
    } else {
      navigate(path, options);
    }
  };

  const getActionForStep = (step) => {
    if (!step.applicable) return null;

    switch (step.id) {
      case "offeringType":
        return (
          <Button variant="ghost" size="sm" onClick={() => handleNav("/app/admin/offering-types")}>
            Manage Types
          </Button>
        );
      case "courseLibrary":
        return (
          <Button variant="ghost" size="sm" onClick={() => handleNav("/app/admin/settings?tab=modules", { state: { initialTab: "modules" } })}>
            Manage Courses
          </Button>
        );
      case "participationStructures":
        return onOpenParticipationStructures && programmeId ? (
          <Button variant="ghost" size="sm" onClick={() => onOpenParticipationStructures(programmeId)}>
            Manage Structures
          </Button>
        ) : null;
      case "programmeLevels":
        return onOpenProgrammeLevels && programmeId ? (
          <Button variant="ghost" size="sm" onClick={() => onOpenProgrammeLevels(programmeId)}>
            Manage Levels
          </Button>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 8,
        background: "var(--surface-subtle, #f9fafb)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Programme Definition Workflow</span>
        <Badge tone={complete ? "success" : "warning"}>
          {doneCount}/{applicableSteps.length} complete
        </Badge>
      </div>
      <ProgressBar value={pct} tone={complete ? "success" : "brand"} label="Programme Definition progress" />
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {steps.map((step) => (
          <li
            key={step.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              fontSize: 13,
              color: step.applicable ? "inherit" : "var(--text-muted, #9ca3af)",
              padding: "4px 0",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span aria-hidden="true">{!step.applicable ? "—" : step.complete ? "✅" : "⬜"}</span>
              <span style={step.applicable && !step.complete ? { fontWeight: 600 } : undefined}>{step.label}</span>
              {!step.applicable && <span style={{ fontSize: 11 }}>(not applicable)</span>}
            </div>
            <div>{getActionForStep(step)}</div>
          </li>
        ))}
      </ul>
      {!complete && (
        <Alert variant="warning" title="Programme Definition incomplete">
          Complete the remaining setup steps before creating a Programme Run for this Programme: {missingSteps.join(", ")}.
        </Alert>
      )}
    </div>
  );
}

