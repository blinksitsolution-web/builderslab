import { useAdminTranscripts } from "./useAdminTranscripts";
import { PageHeader, Card, FormField, Select, Button, Alert, DataTable, Skeleton, EmptyState, ErrorState } from "../../components/ui";
import styles from "./AdminTranscriptsPage.module.css";

// Same run-label convention as legacy renderTranscript()'s runLabel() /
// the parent portal's ParentTranscriptsPage.jsx (Phase 22): a module whose
// grade records span more than one Learning Instance is flagged rather
// than silently blended into one implied run.
function runLabel(row) {
  if (row.mixedLearningInstances && row.contributingLearningInstances?.length) {
    const names = row.contributingLearningInstances.map((i) => `${i.name} (${i.status})`).join(", ");
    return <span title={names}>⚠ Multiple runs</span>;
  }
  if (row.learningInstanceName) {
    return (
      <>
        {row.learningInstanceName} <span className="text-helper">({row.learningInstanceStatus || ""})</span>
      </>
    );
  }
  return "—";
}

function StarRow({ n }) {
  return (
    <div className={styles.stars} aria-label={`${n} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= n ? styles.filled : ""}>
          ★
        </span>
      ))}
    </div>
  );
}

// Full academic column set — Tests/Midterm/End-of-Term/Total/Grade/
// Interpretation are all already computed by transcriptEngine.js and
// returned on each row by grades.js; this just renders what's already
// there. Headers show the live weighting (t.weights, from the same
// transcriptEngine settings) instead of hardcoding 10/20/70 so the table
// never drifts from what was actually used to calculate Total.
function buildColumns(weights) {
  const w = weights || { tests: 10, midterm: 20, endOfTerm: 70 };
  // Stage 4F: the server already converts each component to points out of
  // its own weight (see routes/grades.js's toWeightedScore) — this just
  // renders the "x/max" fraction. Do not re-derive or re-scale here, or
  // the value gets converted twice.
  const fraction = (value, max) => (value == null ? "—" : `${value}/${max}`);
  return [
    { key: "module", header: "Course", render: (r) => `${r.courseId} — ${r.title}` },
    { key: "tests", header: `Tests (${w.tests}%)`, align: "right", render: (r) => fraction(r.tests, r.testsMax ?? w.tests) },
    { key: "midterm", header: `Midterm Examination (${w.midterm}%)`, align: "right", render: (r) => fraction(r.midterm, r.midtermMax ?? w.midterm) },
    { key: "endOfTerm", header: `End-of-Term Examination (${w.endOfTerm}%)`, align: "right", render: (r) => fraction(r.endOfTerm, r.endOfTermMax ?? w.endOfTerm) },
    { key: "total", header: "Total (100%)", align: "right", render: (r) => (r.total ?? "—") },
    { key: "grade", header: "Grade", align: "center", render: (r) => (r.grade ?? "—") },
    { key: "interpretation", header: "Interpretation", render: (r) => (r.interpretation ?? "—") },
    { key: "run", header: "Run", render: runLabel },
  ];
}

// Transcript Summary — surfaces the term-level figures grades.js already
// returns alongside the per-module rows (totalRawScore, overallAverage,
// overallPerformance, attendance). Purely presentational: no value here is
// computed on the frontend, all four come straight off the transcript
// response. Attendance keeps the exact sentence format already used
// elsewhere in this document, just relocated into this section.
function TranscriptSummary({ t }) {
  const attendanceText = t.attendance?.totalSessions
    ? `${t.attendance.present} present, ${t.attendance.late} late, ${t.attendance.absent} absent out of ${t.attendance.totalSessions} session(s) — ${t.attendance.attendanceRate}% attendance rate.`
    : "No attendance recorded yet.";

  return (
    <div className={styles.summary}>
      <p className={styles.summaryTitle}>Transcript Summary</p>
      <div className="grid-2">
        <div className={styles.summaryItem}>
          <span className="text-helper">Total Raw Score</span>
          <span className={styles.summaryValue}>{t.totalRawScore ?? "—"}</span>
        </div>
        <div className={styles.summaryItem}>
          <span className="text-helper">Overall Average</span>
          <span className={styles.summaryValue}>{t.overallAverage ?? "—"}</span>
        </div>
        <div className={styles.summaryItem}>
          <span className="text-helper">Overall Performance</span>
          <span className={styles.summaryValue}>{t.overallPerformance ?? "—"}</span>
        </div>
        <div className={styles.summaryItem}>
          <span className="text-helper">Attendance</span>
          <span className={styles.summaryValue}>{attendanceText}</span>
        </div>
      </div>
    </div>
  );
}

// One rendered transcript document — used for both the individual view and
// each page of the bulk batch (bulk adds a page-break wrapper, matching
// legacy generateBulkTranscripts()'s `page-break-after: always`).
function TranscriptDocument({ t, bulk }) {
  return (
    <Card padding className={styles.transcript} style={bulk ? { pageBreakAfter: "always", marginBottom: "var(--space-6)" } : undefined}>
      <div className={styles.brandRow}>
        {t.branding?.logoPath && <img src={t.branding.logoPath} alt="" className={styles.logo} />}
        <span className={styles.tag}>Official Transcript</span>
      </div>
      <h2 style={{ textAlign: "center" }}>The Builders' Lab</h2>
      <div className={styles.metaRow}>
        <span>
          Learner: <strong>{t.learner.name}</strong>
        </span>
        <span>Class/Level: {t.className || "—"}</span>
        <span>Campus: {t.learner.campus || "—"}</span>
        <span>Issued: {t.issued}</span>
        {t.academicPeriodName && (
          <span>
            Run: {t.learningInstanceName} — {t.academicPeriodName}
          </span>
        )}
      </div>

      <DataTable columns={buildColumns(t.weights)} rows={t.rows} getRowKey={(r) => r.courseId} emptyState={<EmptyState title="No grades recorded yet" />} />

      <TranscriptSummary t={t} />

      <div className={styles.footerRow}>
        <div>
          <p className="text-helper">Overall rating</p>
          <StarRow n={t.stars || 0} />
        </div>
        <div style={{ textAlign: "center" }}>
          {t.branding?.signaturePath ? <img src={t.branding.signaturePath} alt="" className={styles.signatureImg} /> : <div className={styles.signatureLine} />}
          <p className="text-helper" style={{ marginTop: "var(--space-1)" }}>
            {t.branding?.adminSignatureName || "Admin"}
          </p>
        </div>
      </div>

      <p className="text-helper" style={{ marginTop: "var(--space-4)" }}>
        Grades reflect project defenses and quiz performance across the term. Generated automatically by The Builders' Lab portal.
      </p>
    </Card>
  );
}

/**
 * Admin Transcripts (Phase 26) — migrates legacy adminTranscripts() /
 * refreshTranscriptScope() / renderAdminTranscript() /
 * generateBulkTranscripts() (dashboard.html): the same Offering Type/
 * Programme/Learning Instance scope cascade as Manage Accounts (Phase 17),
 * an individual-learner transcript view, and bulk generation across a
 * class, a campus, or everyone matching the scope filter.
 *
 * Scope note: legacy's individual admin view (renderTranscript(id, true))
 * passes `editable=true`, rendering Midterm/End-of-Term as inline
 * grade-entry inputs — inline grade editing is the existing Grade Projects
 * workflow's responsibility elsewhere in the app, not this migration's
 * scope (Transcripts, not grade entry), so both individual and bulk
 * transcripts here render read-only, same presentation as the parent
 * portal's transcript view (Phase 22).
 */
export default function AdminTranscriptsPage() {
  const t = useAdminTranscripts();

  if (t.catalogStatus === "loading") {
    return (
      <div>
        <PageHeader title="Transcripts" />
        <Skeleton height={220} width="100%" />
      </div>
    );
  }

  if (t.catalogStatus === "error") {
    return <ErrorState description="Couldn't load the transcripts screen." action={{ label: "Try again", onClick: () => window.location.reload() }} />;
  }

  return (
    <div>
      <PageHeader title="Transcripts" />

      <Card padding className="no-print">
        <h3 style={{ marginTop: 0 }}>Scope</h3>
        <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
          Narrows both the individual-learner picker and the bulk generator below — defaults to Active runs only.
        </p>
        <div className="grid-3">
          <FormField label="Learning Offering Type">
            <Select value={t.offeringTypeId} onChange={(e) => t.setOfferingTypeId(e.target.value)}>
              <option value="">All offering types</option>
              {t.offeringTypes.map((ot) => (
                <option key={ot.id} value={ot.id}>
                  {ot.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Programme">
            <Select value={t.programmeId} onChange={(e) => t.setProgrammeId(e.target.value)}>
              <option value="">All programmes</option>
              {t.visibleProgrammes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
          {!t.instancesForbidden && (
            <FormField label="Learning Instance (run)">
              <Select value={t.instanceSelection} onChange={(e) => t.setInstanceSelection(e.target.value)}>
                <option value="">Active runs only</option>
                {t.visibleInstances.map((li) => (
                  <option key={li.id} value={li.id}>
                    {(li.name || li.programmeName || li.moduleTitle || "Unnamed run") + " — " + li.status}
                  </option>
                ))}
                <option value="ALL">All Learning Instances (consolidated)</option>
              </Select>
            </FormField>
          )}
        </div>
      </Card>

      <Card padding className="no-print" style={{ marginTop: "var(--space-4)" }}>
        <h3 style={{ marginTop: 0 }}>Individual learner</h3>
        <FormField label="Select learner">
          <Select value={t.selectedLearnerId} onChange={(e) => t.setSelectedLearnerId(e.target.value)} disabled={t.learnersStatus !== "ready" || !t.learners.length}>
            {t.learners.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </FormField>
        {/* Phase 10 — only offered once a specific Learning Instance run is
            selected above (not "Active runs only" or "All, consolidated") —
            a period only means something within one specific run. */}
        {t.selectedInstanceAcademicPeriods.length > 0 && (
          <FormField label="Academic Period">
            <Select value={t.academicPeriodId} onChange={(e) => t.setAcademicPeriodId(e.target.value)}>
              <option value="">Default (current term)</option>
              {t.selectedInstanceAcademicPeriods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
      </Card>

      <Card padding className="no-print" style={{ marginTop: "var(--space-4)" }}>
        <h3 style={{ marginTop: 0 }}>Bulk generation</h3>
        <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
          Generates one transcript per learner in the chosen scope, all in one printable batch. The Scope filter above is always applied first.
        </p>
        <FormField label="Scope">
          <Select value={t.bulkScope} onChange={(e) => t.setBulkScope(e.target.value)}>
            <option value="class">Entire Class / Batch / Cohort / Learning Group</option>
            <option value="campus">One Campus</option>
            <option value="all-campuses">Everyone matching the Scope filter above</option>
          </Select>
        </FormField>
        {t.bulkScope === "class" && (
          <FormField label="Class / Batch / Cohort / Learning Group">
            <Select value={t.bulkClassId} onChange={(e) => t.setBulkClassId(e.target.value)}>
              <option value="">Select…</option>
              {t.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.programmeName || "") + " — " + c.name + " (" + c.displayLabel + ")"}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        {t.bulkScope === "campus" && (
          <FormField label="Campus">
            <Select value={t.bulkCampus} onChange={(e) => t.setBulkCampus(e.target.value)}>
              <option value="">Select…</option>
              {t.campuses.map((c) => (
                <option key={c.id || c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <Button style={{ marginTop: "var(--space-3)" }} onClick={t.generateBulkTranscripts} disabled={t.bulkStatus === "loading"}>
          Generate transcripts
        </Button>
      </Card>

      <div style={{ marginTop: "var(--space-6)" }}>
        {t.transcriptStatus === "loading" && !t.bulkTranscripts.length && <Skeleton height={320} width="100%" />}
        {t.transcriptStatus === "error" && <ErrorState description={t.transcriptError} action={{ label: "Try again", onClick: t.reloadTranscript }} />}
        {t.transcriptStatus === "ready" && t.transcript && (
          <>
            <div style={{ textAlign: "right", marginBottom: "var(--space-3)" }} className="no-print">
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                🖨 Print / Save transcript as PDF
              </Button>
            </div>
            <TranscriptDocument t={t.transcript} />
          </>
        )}

        {t.bulkStatus === "loading" && <p className="text-helper">Generating transcripts…</p>}
        {t.bulkStatus === "error" && <Alert variant="danger">{t.bulkError}</Alert>}
        {t.bulkStatus === "ready" && t.bulkTranscripts.length === 0 && <EmptyState title="No learners match this scope." />}
        {t.bulkStatus === "ready" && t.bulkTranscripts.length > 0 && (
          <>
            <div style={{ textAlign: "center", marginBottom: "var(--space-4)" }} className="no-print">
              <Button variant="secondary" onClick={() => window.print()}>
                🖨 Print / Save all {t.bulkTranscripts.length} transcripts as PDF
              </Button>
            </div>
            {t.bulkTranscripts.map((bt) => (
              <TranscriptDocument key={bt.learner.id} t={bt} bulk />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
