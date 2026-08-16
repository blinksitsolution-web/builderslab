import { useLearnerTranscript } from "./useLearnerTranscript";
import { PageHeader, Card, Button, DataTable, Skeleton, EmptyState, ErrorState, UnauthorizedState, Select } from "../../components/ui";
import styles from "../parent/ParentTranscriptsPage.module.css";

// Phase 10 — same picker as ParentTranscriptsPage.jsx's PeriodSelector
// (kept as its own copy per this project's existing per-role page
// organization — no page folder currently imports another role's
// components).
function PeriodSelector({ periodOptions, selectedInstanceId, selectedPeriodId, onSelectInstance, onSelectPeriod, onClear }) {
  if (!periodOptions.length) return null;
  const instance = periodOptions.find((i) => i.id === selectedInstanceId);
  return (
    <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
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

// Same run-label convention as ParentTranscriptsPage.jsx's runLabel().
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

// Same purely-presentational summary block as ParentTranscriptsPage.jsx —
// every value comes straight off the transcript response, nothing is
// computed here.
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
 * Transcripts — self-view for a learner logged in directly (adult
 * learner). Same read-only layout as ParentTranscriptsPage.jsx, minus the
 * Ward picker (a learner only ever views their own record).
 */
export default function LearnerTranscriptsPage() {
  const {
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
  } = useLearnerTranscript();

  if (status === "loading") {
    return (
      <div>
        <PageHeader title="Transcript" />
        <Skeleton height={320} width="100%" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div>
        <PageHeader title="Transcript" />
        <ErrorState description={errorMessage} action={{ label: "Try again", onClick: reload }} />
      </div>
    );
  }

  if (restricted) {
    return (
      <div>
        <PageHeader title="Transcript" />
        <UnauthorizedState
          title="Transcript unavailable"
          description="Your account currently has a payment restriction, so the transcript isn't available. Resolve it from Payments to continue."
        />
      </div>
    );
  }

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
      <PageHeader title="Transcript" />

      {periodOptions.length > 0 && (
        <Card padding className="no-print" style={{ marginBottom: "var(--space-4)" }}>
          <PeriodSelector
            periodOptions={periodOptions}
            selectedInstanceId={selectedInstanceId}
            selectedPeriodId={selectedPeriodId}
            onSelectInstance={selectInstance}
            onSelectPeriod={selectPeriod}
            onClear={clearPeriodSelection}
          />
        </Card>
      )}

      {t && (
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
            {t.participationStructure === "individual_course" ? (
              <span>Programme / Course transcript</span>
            ) : (
              <span>Class/Level: {t.className || "—"}</span>
            )}
            <span>Campus: {t.learner.campus || "—"}</span>
            <span>Issued: {t.issued}</span>
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
  );
}
