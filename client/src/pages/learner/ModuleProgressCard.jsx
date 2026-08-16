import { Link } from "react-router-dom";
import { Card, Badge, ProgressBar, Button } from "../../components/ui";

function gradeBadge(label, value) {
  if (value == null) return null;
  return (
    <Badge tone={value >= 50 ? "success" : "warning"}>
      {label}: {value}%
    </Badge>
  );
}

export default function ModuleProgressCard({ module }) {
  return (
    <Card padding className="animate-fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <div style={{ minWidth: 0 }}>
          <p className="text-caption" style={{ marginBottom: "2px" }}>
            {module.id}
          </p>
          <h3 style={{ margin: 0 }}>{module.title}</h3>
        </div>
        {module.restricted ? (
          <Badge tone="warning">Restricted</Badge>
        ) : module.unavailable ? (
          <Badge tone="neutral">Unavailable</Badge>
        ) : (
          <Badge tone={module.pct === 100 ? "success" : "brand"}>{module.pct}% complete</Badge>
        )}
      </div>

      {module.restricted ? (
        <p className="text-helper">Lesson progress is hidden while your account has a payment restriction.</p>
      ) : module.unavailable ? (
        <p className="text-helper">We couldn't load progress for this module right now.</p>
      ) : (
        <ProgressBar value={module.pct} tone={module.pct === 100 ? "success" : "brand"} label={`${module.title} progress`} />
      )}

      {(module.midterm != null || module.endOfTerm != null) && (
        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          {gradeBadge("Midterm", module.midterm)}
          {gradeBadge("End of term", module.endOfTerm)}
        </div>
      )}

      {!module.restricted && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <Link to={`/app/learner/modules/${encodeURIComponent(module.id)}`}>
            <Button variant="ghost" size="sm">
              {module.pct > 0 ? "Continue learning" : "Start learning"}
            </Button>
          </Link>
        </div>
      )}
    </Card>
  );
}
