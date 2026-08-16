import { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { useSponsorBulkRegistration } from "./useSponsorBulkRegistration";
import PayEnrolmentModal from "./PayEnrolmentModal";
import { PageHeader, Card, Button, Alert, Select, FormField, DataTable, Badge, EmptyState } from "../../components/ui";

const CATEGORY_LABELS = {
  newLearners: "New learners",
  existingAttached: "Already sponsored by you",
  existingNotAttached: "Existing learner — will be attached to your Sponsor Account",
  needsRegistrationOnly: "Needs registration only",
  needsEnrollmentOnly: "Needs enrollment only",
  alreadyRegistered: "Already registered",
  alreadyEnrolled: "Already enrolled",
  skipped: "Skipped",
};

/**
 * Sponsor coordinators' bulk registration workflow (implementation of
 * the Sponsor Bulk Registration remediation brief, Parts 1-6):
 * pick an active Programme Run -> download the system-generated Excel
 * template -> upload it back -> review the validation report and priced
 * registration preview -> commit -> pay the combined amount through the
 * existing payment pipeline (reused, not duplicated — see
 * PayEnrolmentModal below).
 */
export default function SponsorBulkRegistrationPage() {
  const { user: authUser } = useAuth();
  const toast = useToast();
  const sponsorId = authUser?.sponsor_id;
  const {
    instances,
    instancesStatus,
    learningInstanceId,
    stage,
    batch,
    busy,
    error,
    selectInstance,
    downloadTemplate,
    uploadFile,
    commit,
    downloadReport,
    reset,
  } = useSponsorBulkRegistration(sponsorId);
  const [file, setFile] = useState(null);
  const [payOpen, setPayOpen] = useState(false);

  if (!sponsorId) {
    return <EmptyState title="No Sponsor Account" description="This page is only available to Sponsor Account coordinators." />;
  }

  async function handleUpload() {
    if (!file) {
      toast.error("Choose the completed template file first.");
      return;
    }
    await uploadFile(file);
  }

  async function handleCommit() {
    try {
      await commit();
      toast.success("Batch processed — ready for payment.");
    } catch (e) {
      toast.error(e.message || "Couldn't process this batch.");
    }
  }

  return (
    <div>
      <PageHeader title="Bulk Registration" description="Register many learners into one Programme Run at once, from a single Excel upload." />

      {error && <Alert variant="error" style={{ marginBottom: "var(--space-4)" }}>{error}</Alert>}

      <Card padding>
        <FormField label="Programme Run">
          {instancesStatus === "loading" ? (
            <p>Loading active Programme Runs…</p>
          ) : instances.length === 0 ? (
            <p>There's no Active Programme Run open for registration right now.</p>
          ) : (
            <Select value={learningInstanceId} onChange={(e) => selectInstance(e.target.value)}>
              <option value="">Select a Programme Run…</option>
              {instances.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.programmeName}
                  {i.name ? ` — ${i.name}` : ""} ({i.courseTargetCount} course{i.courseTargetCount === 1 ? "" : "s"})
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </Card>

      {stage !== "pick-instance" && learningInstanceId && (
        <Card padding style={{ marginTop: "var(--space-4)" }}>
          <h3 style={{ marginTop: 0 }}>1. Download the registration template</h3>
          <p>The template always reflects the current registration fields.</p>
          <Button variant="secondary" onClick={downloadTemplate}>
            Download template (.xlsx)
          </Button>

          <h3 style={{ marginTop: "var(--space-6)" }}>2. Upload the completed template</h3>
          <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <div style={{ marginTop: "var(--space-3)" }}>
            <Button onClick={handleUpload} loading={busy} disabled={!file}>
              Validate & Preview
            </Button>
          </div>
        </Card>
      )}

      {batch && (
        <Card padding style={{ marginTop: "var(--space-4)" }}>
          <h3 style={{ marginTop: 0 }}>Validation report</h3>
          {(batch.validation?.errors || []).length === 0 ? (
            <Alert variant="success">No validation errors.</Alert>
          ) : (
            <DataTable
              columns={[
                { key: "rowNumber", header: "Row" },
                { key: "message", header: "Issue" },
              ]}
              rows={batch.validation.errors}
              getRowKey={(r, i) => `${r.rowNumber}-${i}`}
            />
          )}

          <h3 style={{ marginTop: "var(--space-6)" }}>Registration preview</h3>
          {Object.entries(batch.preview?.categories || {}).map(
            ([key, entries]) =>
              entries.length > 0 && (
                <div key={key} style={{ marginBottom: "var(--space-3)" }}>
                  <Badge>{CATEGORY_LABELS[key] || key}</Badge>{" "}
                  <span>
                    {entries.length} learner{entries.length === 1 ? "" : "s"}
                    {key === "skipped" ? ` — ${entries.map((e) => `${e.name} (${e.reason})`).join("; ")}` : ""}
                  </span>
                </div>
              )
          )}

          <p>
            <strong>Total payable: GHS {(batch.preview?.pricing?.totalPayableGHS || 0).toLocaleString()}</strong> for {batch.preview?.pricing?.chargeableCount || 0} learner(s)
            requiring a new registration.
          </p>

          <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
            {stage !== "committed" && (
              <Button onClick={handleCommit} loading={busy} disabled={!batch.validation?.validRowCount}>
                Process batch
              </Button>
            )}
            {stage === "committed" && (
              <Button onClick={() => setPayOpen(true)}>Pay now</Button>
            )}
            <Button variant="secondary" onClick={downloadReport}>
              Download report
            </Button>
            <Button variant="ghost" onClick={reset}>
              Start a new batch
            </Button>
          </div>
        </Card>
      )}

      <PayEnrolmentModal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        childId={authUser?.id}
        childName={null}
        programmeName="Bulk registration"
        country={authUser?.country}
        onSuccess={() => {
          setPayOpen(false);
          toast.success("Payment successful — learner access is being provisioned.");
        }}
      />
    </div>
  );
}
