import { useLearnerCertificates } from "./useLearnerCertificates";
import CertificateCard from "../parent/CertificateCard";
import { PageHeader, Button, Skeleton, EmptyState, ErrorState, UnauthorizedState } from "../../components/ui";

/**
 * Certificates — self-view for a learner logged in directly (adult
 * learner). Same layout as ParentCertificatesPage.jsx, minus the Ward
 * picker (a learner only ever views their own certificates).
 */
export default function LearnerCertificatesPage() {
  const { status, restricted, certificates, errorMessage, reload } = useLearnerCertificates();

  return (
    <div>
      <PageHeader title="Certificates" />

      <div style={{ marginTop: "var(--space-4)" }}>
        {status === "loading" && <Skeleton height={220} width="100%" />}

        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}

        {status === "ready" && restricted && (
          <UnauthorizedState
            title="Certificates unavailable"
            description="Your account currently has a payment restriction, so certificates aren't available. Resolve it from Payments to continue."
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
