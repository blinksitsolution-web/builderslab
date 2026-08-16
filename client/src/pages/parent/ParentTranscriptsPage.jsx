import { useParentTranscript } from "./useParentTranscript";
import WardPicker from "./WardPicker";
import { PageHeader, Card, Button, DataTable, Skeleton, EmptyState, ErrorState, UnauthorizedState, Select } from "../../components/ui";
import styles from "./ParentTranscriptsPage.module.css";

// Phase 10 — lets a parent pick a period-scoped transcript ("Semester 1"
// of a specific Learning Instance run) instead of the default current-
// term view, when the child has any Learning Instance with an academic
// structure configured. Purely a selector: it never invents a period the
// backend hasn't returned via GET .../transcript-options.
function PeriodSelector({ periodOptions, selectedInstanceId, selectedPeriodId, onSelectInstance, onSelectPeriod, onClear }) {
  if (!periodOptions.length) return null;
  const instance = periodOptions.find((i) => i.id === selectedInstanceId);
  return (
    <div className={styles.periodSelector} style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
      <div>
        <label className="text-helper" htmlFor="transcript-instance-select">Learning Instance</label>
        <Select id="transcript-instance-select" value={selectedInstanceId} onChange={(e) => onSelectInstance(e.target.value)}>
          <option value="">Default (current term)</option>
          {periodOptions.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name || "Unnamed run"} ({i.status})
            </option>
          ))}
        </Select>
      </div>
      {instance && (
        <div>
          <label className="text-helper" htmlFor="transcript-period-select">Academic Period</label>
          <Select id="transcript-period-select" value={selectedPeriodId} onChange={(e) => onSelectPeriod(e.target.value)}>
            <option value="">Choose a period…</option>
            {instance.academicPeriods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {selectedInstanceId && (
        <Button variant="secondary" size="sm" onClick={onClear}>
          Clear selection
        </Button>
      )}
    </div>
  );
}

// Same run-label convention as legacy renderTranscript()'s runLabel(): a
// module whose grade records span more than one Learning Instance is
// flagged rather than silently blended into one implied run.
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

/**
 * Transcripts (Phase 22) — migrates legacy parentTranscripts() /
 * loadParentTranscript() / renderTranscript(learnerId, false)
 * (dashboard.html). Read-only: no grade-editing controls, matching the
 * parent's legacy view.
 */
export default function ParentTranscriptsPage() {
  const {
    childrenStatus,
    childrenError,
    availableWards,
    reloadChildren,
    selectedChildId,
    setSelectedChildId,
    status,
    restricted,
    transcript: t,
    errorMessage,
    reload,
    periodOptions,
    selectedInstanceId,
    selectedPeriodId,
    selectInstance,
    selectPeriod,
    clearPeriodSelection,
  } = useParentTranscript();

  if (childrenStatus === "loading") {
    return (
      <div>
        <PageHeader title="Transcripts" />
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
        <PageHeader title="Transcripts" />
        <EmptyState title="No learner linked to this account yet" />
      </div>
    );
  }

  // Full academic column set — Tests/Midterm/End-of-Term/Total/Grade/
  // Interpretation are all already computed by transcriptEngine.js and
  // returned on each row by grades.js; this just renders what's already
  // there. Headers show the live weighting (t.weights) instead of
  // hardcoding 10/20/70 so the table never drifts from what was actually
  // used to calculate Total.
  const weights = t?.weights || { tests: 10, midterm: 20, endOfTerm: 70 };
  // Stage 4F: the server already converts each component to points out of
  // its own weight (see routes/grades.js's toWeightedScore) — this just
  // renders the "x/max" fraction. Do not re-derive or re-scale here, or
  // the value gets converted twice.
  const fraction = (value, max) => (value == null ? "—" : `${value}/${max}`);
  const columns = [
    { key: "module", header: "Course", render: (r) => `${r.courseId} — ${r.title}` },
    { key: "tests", header: `Tests (${weights.tests}%)`, align: "right", render: (r) => fraction(r.tests, r.testsMax ?? weights.tests) },
    { key: "midterm", header: `Midterm Examination (${weights.midterm}%)`, align: "right", render: (r) => fraction(r.midterm, r.midtermMax ?? weights.midterm) },
    { key: "endOfTerm", header: `End-of-Term Examination (${weights.endOfTerm}%)`, align: "right", render: (r) => fraction(r.endOfTerm, r.endOfTermMax ?? weights.endOfTerm) },
    { key: "total", header: "Total (100%)", align: "right", render: (r) => (r.total ?? "—") },
    { key: "grade", header: "Grade", align: "center", render: (r) => (r.grade ?? "—") },
    { key: "interpretation", header: "Interpretation", render: (r) => (r.interpretation ?? "—") },
    { key: "run", header: "Run", render: runLabel },
  ];

  return (
    <div>
      <PageHeader title="Transcripts" />

      <Card padding className="no-print">
        <WardPicker wards={availableWards} selectedId={selectedChildId} onChange={setSelectedChildId} />
        {periodOptions.length > 0 && (
          <div style={{ marginTop: "var(--space-3)" }}>
            <PeriodSelector
              periodOptions={periodOptions}
              selectedInstanceId={selectedInstanceId}
              selectedPeriodId={selectedPeriodId}
              onSelectInstance={selectInstance}
              onSelectPeriod={selectPeriod}
              onClear={clearPeriodSelection}
            />
          </div>
        )}
      </Card>

      <div style={{ marginTop: "var(--space-4)" }}>
        {status === "error" && <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />}

        {status === "ready" && restricted && (
          <UnauthorizedState
            title="Transcript unavailable"
            description="This account currently has a payment restriction, so the transcript isn't available. Resolve it from Payments to continue."
          />
        )}

        {status === "loading" && <Skeleton height={320} width="100%" />}

        {status === "ready" && !restricted && t && (
          <Card padding className={styles.transcript}>
            <div style={{ textAlign: "right", marginBottom: "var(--space-3)" }} className="no-print">
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                🖨 Print / Save transcript as PDF
              </Button>
            </div>

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

            <DataTable columns={columns} rows={t.rows} getRowKey={(r) => r.courseId} emptyState={<EmptyState title="No grades recorded yet" />} />

            <TranscriptSummary t={t} />

            <div className={styles.footerRow}>
              <div>
                <p className="text-helper">Overall rating</p>
                <StarRow n={t.stars || 0} />
              </div>
              <div style={{ textAlign: "center" }}>
                {t.branding?.signaturePath ? (
                  <img src={t.branding.signaturePath} alt="" className={styles.signatureImg} />
                ) : (
                  <div className={styles.signatureLine} />
                )}
                <p className="text-helper" style={{ marginTop: "var(--space-1)" }}>
                  {t.branding?.adminSignatureName || "Admin"}
                </p>
              </div>
            </div>

            <p className="text-helper" style={{ marginTop: "var(--space-4)" }}>
              Grades reflect project defenses and quiz performance across the term. Generated automatically by The Builders' Lab portal.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
