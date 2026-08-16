import { useParentCertificates } from "./useParentCertificates";
import WardPicker from "./WardPicker";
import CertificateCard from "./CertificateCard";
import { PageHeader, Card, Button, Skeleton, EmptyState, ErrorState, UnauthorizedState } from "../../components/ui";

/**
 * Certificates (Phase 22) — migrates legacy parentCertificates() /
 * loadParentCertificates() (dashboard.html).
 */
export default function ParentCertificatesPage() {
  const {
    childrenStatus,
    childrenError,
    availableWards,
    reloadChildren,
    selectedChildId,
    setSelectedChildId,
    status,
    restricted,
    certificates,
    errorMessage,
    reload,
  } = useParentCertificates();

  if (childrenStatus === "loading") {
    return (
      <div>
        <PageHeader title="Certificates" />
        <Skeleton height={120} width="100%" />
      </div>
    );
  }

  if (childrenStatus === "error") {
    return <ErrorState description={childrenError} action={{ label: "Try again", onClick: reloadChildren }} />;
  }

  if (availableWards.length === 0) {
    return (
      <div>
        <PageHeader title="Certificates" />
        <EmptyState title="No learner linked to this account yet" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Certificates" />

      <Card padding className="no-print">
        <WardPicker wards={availableWards} selectedId={selectedChildId} onChange={setSelectedChildId} />
      </Card>

      <div style={{ marginTop: "var(--space-4)" }}>
        {status === "loading" && <Skeleton height={220} width="100%" />}

        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}

        {status === "ready" && restricted && (
          <UnauthorizedState
            title="Certificates unavailable"
            description="This account currently has a payment restriction, so certificates aren't available. Resolve it from Payments to continue."
          />
        )}

        {status === "ready" && !restricted && certificates.length === 0 && <EmptyState title="No certificates issued yet" />}

        {status === "ready" && !restricted && certificates.length > 0 && (
          <>
            <div style={{ textAlign: "center", marginBottom: "var(--space-4)" }} className="no-print">
              <Button variant="secondary" onClick={() => window.print()}>
                🖨 Print / Save as PDF
              </Button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              {certificates.map((c) => (
                <CertificateCard key={c.id} certificate={c} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
