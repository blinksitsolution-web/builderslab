import { useNavigate } from "react-router-dom";
import { useToast } from "../../context/ToastContext";
import { useParentDashboard } from "./useParentDashboard";
import WardCard from "./WardCard";
import { PageHeader, Card, Skeleton, EmptyState, ErrorState, Button } from "../../components/ui";

function DashboardSkeleton() {
  return (
    <div>
      <Skeleton height={32} width="35%" />
      <div className="grid-2" style={{ marginTop: "var(--space-6)" }}>
        {[1, 2].map((i) => (
          <Card key={i} padding>
            <Skeleton height={20} width="50%" />
            <div style={{ marginTop: "var(--space-2)" }}>
              <Skeleton height={12} width="70%" />
            </div>
            <div style={{ marginTop: "var(--space-3)" }}>
              <Skeleton height={12} width="60%" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * Parent portal (Phase 6, completed final migration pass). "Add a child"
 * now opens AddChildPage.jsx (/app/parent/add-child) instead of the
 * legacy overview screen — same fields/rules as self-registration (see
 * server/src/routes/users.js POST /:parentId/children), just ported to
 * React. Removing a child was already fully migrated below.
 */
export default function ParentDashboard() {
  const toast = useToast();
  const navigate = useNavigate();
  const { status, errorMessage, parent, wards, reload, removeWard } = useParentDashboard();

  if (status === "loading") return <DashboardSkeleton />;

  if (status === "error") {
    return <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />;
  }

  async function handleRemove(childId) {
    const child = wards.find((w) => w.data?.id === childId)?.data;
    try {
      await removeWard(childId);
      toast.success(`${child?.name || "Child"} was removed from your account.`);
    } catch (err) {
      toast.error(err.message || "Couldn't remove this child.");
      throw err; // keeps ConfirmationDialog open so the person sees why
    }
  }

  const firstName = (parent.name || "").split(" ")[0] || "there";
  // Part 8 legacy remediation — a Sponsor Account coordinator (sponsor_id
  // set) registers learners through Bulk Registration now, never one at a
  // time; an ordinary parent (no sponsor_id) keeps the original per-child
  // flow, completely unchanged.
  const isCoordinator = !!parent.sponsor_id;

  return (
    <div>
      <PageHeader
        title={`Welcome, ${firstName}`}
        description="An overview of the children linked to your account."
        actions={
          <Button variant="secondary" onClick={() => navigate(isCoordinator ? "/app/parent/bulk-registration" : "/app/parent/add-child")}>
            {isCoordinator ? "+ Bulk register learners" : "+ Add a child"}
          </Button>
        }
      />

      {wards.length === 0 ? (
        <EmptyState title="No learner linked to this account yet" description="Once a child is linked to your account, their progress and status will show up here." />
      ) : (
        <div className="grid-2">
          {wards.map((ward) => (
            <WardCard key={ward.id} ward={ward} onRemove={handleRemove} />
          ))}
        </div>
      )}
    </div>
  );
}
