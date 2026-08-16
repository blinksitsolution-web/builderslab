import { useSponsoredLearners } from "./useSponsoredLearners";
import { PageHeader, Card, Button, DataTable, Badge, Skeleton, EmptyState, ErrorState } from "../../components/ui";

const STATUS_TONE = { active: "success", pending_payment: "warning", inactive: "neutral", suspended: "danger" };

// Stage 4C: how a learner's access was funded — kept distinct so a
// coordinator can tell a sponsor-paid learner apart from one the
// hub/admin granted free access to via an Access Override.
const ACCESS_TYPE_LABEL = {
  // "Sponsor" only means a sponsor is responsible for this learner's fees
  // — see the Payment status column for whether that payment has
  // actually been made. Only "admin_free_access" (a Hub-granted override)
  // means no payment is required at all.
  sponsor: "Sponsor",
  admin_free_access: "Free access (Hub granted)",
  self_paid: "Self/parent-paid",
};
const ACCESS_TYPE_TONE = { sponsor: "info", admin_free_access: "success", self_paid: "neutral" };

// Minimal, dependency-free CSV export (Excel opens .csv natively) — the
// full binary .xlsx export (Stage 4F) reuses the same SheetJS dependency
// introduced for the bulk-upload template (Stage 4C) once that lands;
// this covers "export to Excel" safely in the meantime without adding a
// library just for this one screen.
function toCsv(learners) {
  const headers = ["Name", "Username", "Student ID", "Programme", "Access type", "Status", "Payment status", "Password"];
  const rows = learners.map((l) => [
    l.name,
    l.username,
    l.studentCode || "",
    l.programmeName || l.className || "",
    l.sponsorName ? `${ACCESS_TYPE_LABEL[l.accessType] || l.accessType} — ${l.sponsorName}` : ACCESS_TYPE_LABEL[l.accessType] || l.accessType,
    l.status,
    l.paymentStatus,
    l.password || "(already used to log in)",
  ]);
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
}

function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function SponsoredLearnersPage() {
  const { status, learners, errorMessage, reload } = useSponsoredLearners();

  return (
    <div>
      <PageHeader
        title="Sponsored Learners"
        description="Learners you've added, with login credentials while they're still available."
      />

      {status === "ready" && learners.length > 0 && (
        <div style={{ display: "flex", gap: "var(--space-3)", marginBottom: "var(--space-4)" }} className="no-print">
          <Button variant="secondary" size="sm" onClick={() => window.print()}>
            🖨 Print
          </Button>
          <Button variant="secondary" size="sm" onClick={() => downloadCsv("sponsored-learners.csv", toCsv(learners))}>
            ⬇ Export to Excel (CSV)
          </Button>
        </div>
      )}

      {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}

      {status !== "error" && (
        <Card padding>
          <DataTable
            loading={status === "loading"}
            rows={learners}
            getRowKey={(l) => l.id}
            emptyState={<EmptyState title="No sponsored learners yet" description="Learners you add will show up here with their login details." />}
            columns={[
              { key: "name", header: "Name", render: (l) => l.name },
              { key: "username", header: "Username", render: (l) => <span style={{ fontFamily: "monospace" }}>{l.username}</span> },
              { key: "studentCode", header: "Student ID", render: (l) => l.studentCode || "—" },
              { key: "programme", header: "Programme / Class", render: (l) => l.programmeName || l.className || "—" },
              {
                key: "accessType",
                header: "Access type",
                render: (l) => (
                  <span>
                    <Badge tone={ACCESS_TYPE_TONE[l.accessType] || "neutral"}>{ACCESS_TYPE_LABEL[l.accessType] || l.accessType}</Badge>
                    {l.sponsorName && <div className="text-helper">{l.sponsorName}</div>}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Account status",
                render: (l) => <Badge tone={STATUS_TONE[l.status] || "neutral"}>{l.status}</Badge>,
              },
              {
                key: "paymentStatus",
                header: "Payment status",
                render: (l) => (
                  <Badge tone={l.paymentStatus === "waived" || l.paymentStatus === "current" ? "success" : l.paymentStatus === "partial" ? "warning" : "danger"}>
                    {l.paymentStatus}
                  </Badge>
                ),
              },
              {
                key: "password",
                header: "Password",
                render: (l) =>
                  l.credentialsAvailable ? (
                    <span style={{ fontFamily: "monospace" }}>{l.password}</span>
                  ) : (
                    <span className="text-helper">Already used to log in</span>
                  ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}
