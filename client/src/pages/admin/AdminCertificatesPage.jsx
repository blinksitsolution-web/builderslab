import { useAdminCertificates } from "./useAdminCertificates";
import CertificateCard from "./CertificateCard";
import { PageHeader, Card, FormField, Select, Button, Alert, Skeleton, ErrorState, EmptyState } from "../../components/ui";

/**
 * Admin Certificate Generator (Phase 26) — migrates legacy
 * adminCertificates() (dashboard.html): an Offering Type/Programme/
 * Learning Instance scope cascade (same as Manage Accounts, Phase 17),
 * a required certificate-template selector, single-learner issuance, and
 * bulk issuance for every learner enrolled in a module. Issued
 * certificates render with the same CertificateCard used by the parent
 * portal (Phase 22) and print the same way.
 *
 * This is a generator, not a browse-all-issued-certificates screen —
 * legacy adminCertificates() has no listing/search of previously issued
 * certificates either (the backend has no such endpoint: certificates.js
 * only exposes per-learner and per-id lookups), so none is introduced
 * here. See this phase's final report for that limitation.
 */
export default function AdminCertificatesPage() {
  const cert = useAdminCertificates();

  if (cert.catalogStatus === "loading") {
    return (
      <div>
        <PageHeader title="Certificates" />
        <Skeleton height={220} width="100%" />
      </div>
    );
  }

  if (cert.catalogStatus === "error") {
    return <ErrorState description="Couldn't load the certificate generator." action={{ label: "Try again", onClick: () => window.location.reload() }} />;
  }

  return (
    <div>
      <PageHeader title="Certificates" description="Generate module completion certificates for one learner or an entire module." />

      <Card padding>
        <h3 style={{ marginTop: 0 }}>Scope</h3>
        <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
          Narrows the Learner and Module pickers below. Every Learning Instance — active or historical — is included by default, since a learner's certificate
          eligibility comes from their completion record, not from whether their Programme Run is still active; pick "Active runs only" below to narrow to current
          runs instead.
        </p>
        <div className="grid-3">
          <FormField label="Learning Offering Type">
            <Select value={cert.offeringTypeId} onChange={(e) => cert.setOfferingTypeId(e.target.value)}>
              <option value="">All offering types</option>
              {cert.offeringTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Programme">
            <Select value={cert.programmeId} onChange={(e) => cert.setProgrammeId(e.target.value)}>
              <option value="">All programmes</option>
              {cert.visibleProgrammes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
          {!cert.instancesForbidden && (
            <FormField label="Learning Instance (run)">
              <Select value={cert.instanceSelection} onChange={(e) => cert.setInstanceSelection(e.target.value)}>
                <option value="">All Learning Instances (active + historical)</option>
                <option value="ACTIVE_ONLY">Active runs only</option>
                {cert.visibleInstances.map((li) => (
                  <option key={li.id} value={li.id}>
                    {(li.name || li.programmeName || li.moduleTitle || "Unnamed run") + " — " + li.status}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>
      </Card>

      <Card padding style={{ marginTop: "var(--space-4)" }}>
        <h3 style={{ marginTop: 0 }}>Certificate template</h3>
        {cert.templates.length === 0 && (
          <Alert variant="warning">
            No active Module Completion Certificate template exists yet — create one in Site Settings → Certificate Settings before certificates can be generated.
          </Alert>
        )}
        <FormField label="Template (required — a certificate cannot be generated without one)">
          <Select value={cert.templateId} onChange={(e) => cert.setTemplateId(e.target.value)}>
            <option value="">Select a template…</option>
            {cert.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </FormField>
      </Card>

      <Card padding style={{ marginTop: "var(--space-4)" }}>
        <h3 style={{ marginTop: 0 }}>Generate for one learner</h3>
        <div className="grid-2">
          <FormField label="Learner">
            <Select value={cert.learnerId} onChange={(e) => cert.setLearnerId(e.target.value)}>
              {cert.learners.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Course completed">
            <Select value={cert.moduleId} onChange={(e) => cert.setModuleId(e.target.value)}>
              {cert.visibleModules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <Button style={{ marginTop: "var(--space-3)" }} onClick={cert.generateOne} disabled={cert.issueStatus === "loading" || !cert.learnerId || !cert.moduleId}>
          Generate certificate
        </Button>
      </Card>

      <Card padding style={{ marginTop: "var(--space-4)" }}>
        <h3 style={{ marginTop: 0 }}>Generate for every learner in a module</h3>
        <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
          Produces one certificate per learner currently enrolled in the chosen module, ready to print in one batch.
        </p>
        <FormField label="Course">
          <Select value={cert.bulkModuleId} onChange={(e) => cert.setBulkModuleId(e.target.value)}>
            {cert.visibleModules.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </FormField>
        <Button style={{ marginTop: "var(--space-3)" }} onClick={cert.generateBulk} disabled={cert.issueStatus === "loading" || !cert.bulkModuleId}>
          Generate for all learners
        </Button>
      </Card>

      <div style={{ marginTop: "var(--space-6)" }}>
        {cert.issueError && <Alert variant="danger">{cert.issueError}</Alert>}
        {cert.issueStatus === "loading" && <Skeleton height={220} width="100%" />}
        {cert.issueStatus === "ready" && cert.issueNotice && <EmptyState title={cert.issueNotice} />}
        {cert.issueStatus === "ready" && cert.issuedCertificates.length > 0 && (
          <>
            <div style={{ textAlign: "center", marginBottom: "var(--space-4)" }} className="no-print">
              <Button variant="secondary" onClick={() => window.print()}>
                🖨 Print / Save as PDF
              </Button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              {cert.issuedCertificates.map((c) => (
                <CertificateCard key={c.id} certificate={c} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
