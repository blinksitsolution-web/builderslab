import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useLearnerDashboard } from "./useLearnerDashboard";
import ModuleProgressCard from "./ModuleProgressCard";
import { PageHeader, Card, Badge, Alert, EmptyState, ErrorState, Skeleton } from "../../components/ui";

const PAYMENT_LABEL = { current: "Current", partial: "Part paid", waived: "Sponsored" };

// Phase 2 — period payment status tones/labels (same map as LearnerPaymentsPage)
const PERIOD_STATUS_TONE = { paid: "success", partial: "warning", unpaid: "danger", not_required: "neutral" };
const PERIOD_STATUS_LABEL = { paid: "Paid in full", partial: "Paid in part", unpaid: "Not paid", not_required: "No payment required" };

function StatCard({ value, label }) {
  return (
    <Card padding className="animate-fade-in">
      <p style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "var(--font-size-3xl)", color: "var(--color-primary-700)", lineHeight: 1 }}>{value}</p>
      <p className="text-label" style={{ marginTop: "var(--space-2)" }}>
        {label}
      </p>
    </Card>
  );
}

function RecentSubmissions({ projects }) {
  if (!projects || projects.length === 0) return null;
  const recent = projects.slice(0, 3);
  return (
    <section style={{ marginTop: "var(--space-8)" }}>
      <h2 className="text-section-title">Recent submissions</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {recent.map((p) => (
          <Card key={p.id} padding>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)" }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}>{p.title}</p>
                <p className="text-helper" style={{ margin: 0 }}>
                  {p.module} · {new Date(p.date).toLocaleDateString()}
                </p>
              </div>
              <Badge tone={p.grade || p.mark != null ? "success" : "neutral"}>{p.grade || p.mark != null ? "Graded" : "Pending review"}</Badge>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div>
      <Skeleton height={32} width="40%" />
      <div className="grid-3" style={{ marginTop: "var(--space-6)" }}>
        {[1, 2, 3].map((i) => (
          <Card key={i} padding>
            <Skeleton height={36} width="50%" />
            <div style={{ marginTop: "var(--space-2)" }}>
              <Skeleton height={12} width="70%" />
            </div>
          </Card>
        ))}
      </div>
      <div style={{ marginTop: "var(--space-8)" }}>
        <Skeleton height={22} width="30%" />
        <div className="grid-2" style={{ marginTop: "var(--space-4)" }}>
          {[1, 2].map((i) => (
            <Card key={i} padding>
              <Skeleton height={18} width="60%" />
              <div style={{ marginTop: "var(--space-3)" }}>
                <Skeleton height={8} width="100%" />
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Learner portal (Phase 5). Also serves adult learners — same route, same
 * component, same backend role (role:"learner", is_adult:true/false) —
 * the only adaptation is cosmetic (see the badge next to the learner's
 * name below), matching how little the legacy dashboard actually
 * differentiates the two at the overview level (see Phase 1: is_adult
 * only ever changes which *extra* nav items appear, never the overview
 * content itself).
 *
 * Phase 2 addition: shows a level + academic period + period payment status
 * context row for learners in structured (term/semester) runs. Legacy
 * monthly learners see no change (periodPayments.length === 0).
 */
export default function LearnerDashboard() {
  const { user: authUser } = useAuth();
  const { status, errorMessage, learner, moduleSummaries, periodPayments, reload } = useLearnerDashboard();

  if (status === "loading") {
    return <DashboardSkeleton />;
  }

  if (status === "error") {
    return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  }

  const firstName = (learner.name || "").split(" ")[0] || "there";
  const paymentLabel = PAYMENT_LABEL[learner.payment_status] || "Due";

  // Phase 2 — pick the "current" period: the one that is either unpaid
  // (most actionable) or, if all are paid/satisfied, the last in sequence.
  const currentPeriodRow =
    periodPayments.length > 0
      ? periodPayments.find((p) => !p.satisfied) || periodPayments[periodPayments.length - 1]
      : null;

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description={
          authUser?.is_adult ? (
            <>
              <Badge tone="brand">Adult learner</Badge> Here's where things stand across your modules.
            </>
          ) : (
            "Here's where things stand across your modules."
          )
        }
      />

      {learner.accessRestricted && (
        <div style={{ marginBottom: "var(--space-6)" }}>
          <Alert variant="warning" title="Your account has a payment restriction">
            {learner.accessRestrictedReason || "Some learning content is limited until this is resolved."}{" "}
            <Link to="/app/learner/payments">Go to payments</Link>.
          </Alert>
        </div>
      )}

      {/* Phase 2 — level + period context card (structured/term/semester runs only).
          Rendered only when the learner has at least one period-payment row;
          legacy monthly learners see no change. */}
      {currentPeriodRow && (
        <Card
          padding
          style={{
            marginBottom: "var(--space-4)",
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-4)",
            alignItems: "center",
          }}
        >
          {learner.className && (
            <div>
              <p className="text-label" style={{ margin: 0, marginBottom: 2 }}>
                Level
              </p>
              <p style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}>{learner.className}</p>
            </div>
          )}
          <div>
            <p className="text-label" style={{ margin: 0, marginBottom: 2 }}>
              Current period
            </p>
            <p style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}>
              {currentPeriodRow.academicPeriod?.name || "—"}
              <span className="text-helper" style={{ marginLeft: 6 }}>
                ({currentPeriodRow.learningInstance?.name})
              </span>
            </p>
          </div>
          <div>
            <p className="text-label" style={{ margin: 0, marginBottom: 2 }}>
              Period payment
            </p>
            <Badge tone={PERIOD_STATUS_TONE[currentPeriodRow.status] || "neutral"}>
              {PERIOD_STATUS_LABEL[currentPeriodRow.status] || currentPeriodRow.status}
            </Badge>
          </div>
          {!currentPeriodRow.satisfied && (
            <Link to="/app/learner/payments" style={{ marginLeft: "auto", fontSize: "var(--font-size-sm)" }}>
              View payments →
            </Link>
          )}
        </Card>
      )}

      <div className="grid-3">
        <StatCard value={learner.accessRestricted ? "—" : moduleSummaries.length} label="Enrolled modules" />
        <StatCard value={learner.accessRestricted ? "—" : (learner.projects || []).length} label="Projects submitted" />
        <StatCard value={paymentLabel} label="Payment status" />
      </div>

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2 className="text-section-title">Your modules</h2>
        {learner.accessRestricted ? (
          <EmptyState
            title="Module details are hidden"
            description="Your account currently has a payment restriction, so module and lesson details aren't shown here. Resolve it to see your modules and progress again."
          />
        ) : moduleSummaries.length === 0 ? (
          <EmptyState title="No modules enrolled yet" description="Once you're enrolled in a module, your lessons and progress will show up here." />
        ) : (
          <div className="grid-2">
            {moduleSummaries.map((m) => (
              <ModuleProgressCard key={m.id} module={m} />
            ))}
          </div>
        )}
      </section>

      {!learner.accessRestricted && <RecentSubmissions projects={learner.projects} />}
    </div>
  );
}
