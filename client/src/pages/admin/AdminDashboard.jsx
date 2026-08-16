import { useAuth } from "../../context/AuthContext";
import { usePermissions } from "../../context/PermissionContext";
import { useAdminDashboard } from "./useAdminDashboard";
import { PageHeader, Card, Badge, Skeleton, ErrorState, UnauthorizedState, FormField, Select, DataTable, EmptyState } from "../../components/ui";

function DashboardSkeleton() {
  return (
    <div>
      <Skeleton height={32} width="30%" />
      <div className="grid-2" style={{ marginTop: "var(--space-6)" }}>
        {[1, 2, 3, 4].map((i) => (
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
 * Admin / Super Administrator portal (Phase 8). Same route and component
 * for both — Super Administrator is not a separate role (see Phase 1:
 * it's role:"admin" assigned to the built-in "Super Administrator" role
 * template, isSuperAdmin:true), so this reads that flag from
 * PermissionContext (sourced from GET /api/auth/me — see Phase 2's
 * AuthContext/PermissionContext) purely to decide what to *show*. Nothing
 * here grants access; every request below still goes through the
 * backend's own role/permission gates and can still fail — see
 * useAdminDashboard.js for how a 403 on the permission-gated statistics
 * section is handled distinctly from "no data."
 */
export default function AdminDashboard() {
  const { user } = useAuth();
  const { isSuperAdmin, roleTemplateName } = usePermissions();
  const { status, stats, reload, catalogStatus, offeringTypes, visibleProgrammes, visibleInstances, offeringTypeId, setOfferingTypeId, programmeId, setProgrammeId, instanceSelection, setInstanceSelection, instancesForbidden } =
    useAdminDashboard();

  if (status === "loading") return <DashboardSkeleton />;

  if (status === "error") {
    return <ErrorState description="We couldn't load the admin dashboard right now." action={{ label: "Try again", onClick: reload }} />;
  }

  const firstName = (user?.name || "").split(" ")[0] || "there";
  const completionPct =
    stats.status === "ready" && stats.value.totals.activeEnrolments + stats.value.totals.completedEnrolments
      ? Math.round((stats.value.totals.completedEnrolments / (stats.value.totals.activeEnrolments + stats.value.totals.completedEnrolments)) * 100)
      : 0;

  return (
    <div>
      <PageHeader
        title={`Welcome, ${firstName}`}
        description={
          <>
            {isSuperAdmin ? <Badge tone="brand">Super Administrator</Badge> : roleTemplateName ? <Badge tone="neutral">{roleTemplateName}</Badge> : null}{" "}
            Here's how the platform is doing right now.
          </>
        }
      />

      <section style={{ marginTop: "var(--space-6)" }}>
        <h2 className="text-section-title">Active Learning Instance statistics</h2>

        {catalogStatus === "ready" && (
          <div className="grid-3" style={{ marginTop: "var(--space-4)", marginBottom: "var(--space-4)" }}>
            <FormField label="Learning Offering Type">
              <Select value={offeringTypeId} onChange={(e) => setOfferingTypeId(e.target.value)}>
                <option value="">All offering types</option>
                {offeringTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Programme">
              <Select value={programmeId} onChange={(e) => setProgrammeId(e.target.value)}>
                <option value="">All programmes</option>
                {visibleProgrammes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </FormField>
            {!instancesForbidden && (
              <FormField label="Learning Instance (run)">
                <Select value={instanceSelection} onChange={(e) => setInstanceSelection(e.target.value)}>
                  <option value="">Active runs only</option>
                  {visibleInstances.map((li) => (
                    <option key={li.id} value={li.id}>
                      {(li.name || li.programmeName || li.moduleTitle || "Unnamed run") + " — " + li.status}
                    </option>
                  ))}
                  <option value="ALL">All Learning Instances (consolidated)</option>
                </Select>
              </FormField>
            )}
          </div>
        )}

        {stats.status === "loading" && (
          <div className="grid-2">
            <Card padding>
              <Skeleton height={28} width="40%" />
            </Card>
            <Card padding>
              <Skeleton height={28} width="40%" />
            </Card>
          </div>
        )}
        {stats.status === "forbidden" && (
          <UnauthorizedState
            title="Not included in your admin role"
            description="Your role template doesn't include permission to view Learning Instance statistics. Ask a Super Administrator if you need access."
          />
        )}
        {stats.status === "error" && <ErrorState description={stats.error} action={{ label: "Try again", onClick: reload }} />}
        {stats.status === "ready" && (
          <div className="grid-2">
            <Card padding>
              <p style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "var(--font-size-2xl)", color: "var(--color-primary-700)" }}>{stats.value.totals.activeLearners}</p>
              <p className="text-label" style={{ marginTop: "var(--space-2)" }}>
                Active learners
              </p>
            </Card>
            <Card padding>
              <p style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "var(--font-size-2xl)", color: "var(--color-primary-700)" }}>{stats.value.totals.activeEnrolments}</p>
              <p className="text-label" style={{ marginTop: "var(--space-2)" }}>
                Active enrolments
              </p>
            </Card>
            <Card padding>
              <p style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "var(--font-size-2xl)", color: "var(--color-primary-700)" }}>GHS {stats.value.totals.paymentsGHS}</p>
              <p className="text-label" style={{ marginTop: "var(--space-2)" }}>
                Payments
              </p>
            </Card>
            <Card padding>
              <p style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "var(--font-size-2xl)", color: "var(--color-primary-700)" }}>{completionPct}%</p>
              <p className="text-label" style={{ marginTop: "var(--space-2)" }}>
                Programme completion
              </p>
            </Card>
          </div>
        )}
        {stats.status === "ready" && (
          <div style={{ marginTop: "var(--space-4)" }}>
            <DataTable
              rows={stats.value.instances}
              getRowKey={(i) => i.id}
              emptyState={<EmptyState title="No Learning Instances match this scope yet." />}
              columns={[
                { key: "offeringType", header: "Offering Type", render: (i) => i.offeringTypeName },
                {
                  key: "programme",
                  header: "Programme / Course",
                  render: (i) => (
                    <>
                      {i.programmeName || i.moduleTitle || "—"}
                      {i.moduleTitle && i.programmeName ? (
                        <>
                          <br />
                          <span className="text-helper">{i.moduleTitle}</span>
                        </>
                      ) : null}
                    </>
                  ),
                },
                {
                  key: "instance",
                  header: "Learning Instance",
                  render: (i) => (
                    <>
                      {i.name || "Unnamed run"} <Badge tone={i.status === "active" ? "success" : "neutral"}>{i.status}</Badge>
                    </>
                  ),
                },
                { key: "activeLearners", header: "Active Learners", render: (i) => i.activeLearners },
                { key: "activeEnrolments", header: "Active Enrolments", render: (i) => i.activeEnrolments },
                { key: "payments", header: "Payments", render: (i) => `GHS ${i.paymentsGHS}` },
                { key: "completion", header: "Completion", render: (i) => (i.completionRate != null ? `${i.completionRate}%` : "—") },
              ]}
            />
          </div>
        )}
      </section>
    </div>
  );
}
