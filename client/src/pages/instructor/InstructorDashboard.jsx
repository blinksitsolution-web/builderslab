import { useAuth } from "../../context/AuthContext";
import { useInstructorDashboard } from "./useInstructorDashboard";
import { PageHeader, Card, Badge, Skeleton, EmptyState, ErrorState } from "../../components/ui";

function StatCard({ section, label, compute }) {
  return (
    <Card padding className="animate-fade-in">
      {section.status === "loading" && <Skeleton height={36} width="40%" />}
      {section.status === "error" && (
        <p className="text-helper" style={{ margin: 0, color: "var(--color-danger-text)" }}>
          Unavailable
        </p>
      )}
      {section.status === "ready" && (
        <p style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "var(--font-size-3xl)", color: "var(--color-primary-700)", lineHeight: 1 }}>
          {compute(section.value)}
        </p>
      )}
      <p className="text-label" style={{ marginTop: "var(--space-2)" }}>
        {label}
      </p>
    </Card>
  );
}

function AssignmentList({ section, itemLabel, getName, getMeta, emptyDescription }) {
  if (section.status === "loading") {
    return (
      <Card padding>
        <Skeleton height={16} width="60%" />
        <div style={{ marginTop: "var(--space-2)" }}>
          <Skeleton height={16} width="45%" />
        </div>
      </Card>
    );
  }
  if (section.status === "error") {
    return <ErrorState title={`Couldn't load ${itemLabel}`} description={section.error} />;
  }
  if (section.value.length === 0) {
    return <EmptyState title={`No ${itemLabel} assigned yet`} description={emptyDescription} />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {section.value.map((item) => (
        <Card key={item.id} padding>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-3)" }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: "var(--font-weight-semibold)" }}>{getName(item)}</p>
              {getMeta(item) && (
                <p className="text-helper" style={{ margin: 0 }}>
                  {getMeta(item)}
                </p>
              )}
            </div>
            <Badge tone="brand">{item.id}</Badge>
          </div>
        </Card>
      ))}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div>
      <Skeleton height={32} width="35%" />
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
    </div>
  );
}

/**
 * Instructor portal (Phase 7). Mirrors legacy instructorOverview()'s three
 * KPIs exactly (total learners, projects awaiting grading, notes posted —
 * all backend-scoped per api/instructor.js's header comment), plus a
 * "Your teaching assignments" section surfacing myModules()/myClasses(),
 * which the legacy overview screen doesn't show but which existing,
 * already-scoped endpoints support (Phase 7 section 5).
 */
export default function InstructorDashboard() {
  const { user } = useAuth();
  const { status, learners, projects, notes, modules, classes, reload } = useInstructorDashboard();

  if (status === "loading") return <DashboardSkeleton />;

  if (status === "error") {
    return <ErrorState description="We couldn't load your dashboard right now." action={{ label: "Try again", onClick: reload }} />;
  }

  const firstName = (user?.name || "").split(" ")[0] || "there";
  const pendingCount = projects.status === "ready" ? projects.value.filter((p) => p.grade == null).length : null;

  return (
    <div>
      <PageHeader title={`Welcome, Coach ${firstName}`} description="Here's a snapshot of your learners and teaching workload." />

      <div className="grid-3">
        <StatCard section={learners} label="Total learners" compute={(v) => v.length} />
        <StatCard
          section={projects.status === "ready" ? { status: "ready", value: pendingCount } : projects}
          label="Projects to grade"
          compute={(v) => v}
        />
        <StatCard section={notes} label="Notes posted" compute={(v) => v.length} />
      </div>

      <section style={{ marginTop: "var(--space-8)" }}>
        <h2 className="text-section-title">Your teaching assignments</h2>
        <div className="grid-2">
          <div>
            <p className="text-label" style={{ marginBottom: "var(--space-2)" }}>
              Classes
            </p>
            <AssignmentList
              section={classes}
              itemLabel="classes"
              getName={(c) => c.name}
              getMeta={(c) => c.programmeName}
              emptyDescription="Once an administrator assigns you to a class, it will show up here."
            />
          </div>
          <div>
            <p className="text-label" style={{ marginBottom: "var(--space-2)" }}>
              Modules
            </p>
            <AssignmentList
              section={modules}
              itemLabel="modules"
              getName={(m) => m.title}
              getMeta={(m) => m.programmeName}
              emptyDescription="Once an administrator assigns you to a module, it will show up here."
            />
          </div>
        </div>
      </section>
    </div>
  );
}
