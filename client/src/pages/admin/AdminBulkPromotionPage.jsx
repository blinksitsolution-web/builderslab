import { useState } from "react";
import { useAdminBulkPromotion } from "./useAdminBulkPromotion";
import { PageHeader, Card, Button, FormField, Select, DataTable, LoadingState, ErrorState, UnauthorizedState, Checkbox, Alert, Input, Badge } from "../../components/ui";
import PromotionLogModal from "./PromotionLogModal";
import PromotionPolicyModal from "./PromotionPolicyModal";
import PromotionEligibilityModal from "./PromotionEligibilityModal";
import { useToast } from "../../context/ToastContext";

const ACTION_LABELS = {
  promote: "Promote to next class (legacy — no eligibility check)",
  promote_eligible: "Promote only learners who meet the Promotion Policy (automatic)",
  promote_override: "Promote selected, with override for anyone who doesn't meet policy (manual)",
  graduate: "Graduate (final class)",
  repeat: "Repeat this year (stay in class, move to new Academic Year)",
  transfer_class: "Transfer to a different class",
  transfer_campus: "Transfer to a different campus",
};

/**
 * Bulk Promotion (final admin migration pass). Migrates legacy
 * adminBulkPromotion()/previewBulkPromotion()/confirmBulkPromotion()
 * (dashboard.html) in full — pick a campus + class, find eligible
 * learners, select who this applies to, then promote/graduate/repeat/
 * transfer them. Every action here is written to each learner's promotion
 * history for audit — it never touches past terms' grades, attendance, or
 * payments.
 */
export default function AdminBulkPromotionPage() {
  const data = useAdminBulkPromotion();
  const toast = useToast();
  const [logLearner, setLogLearner] = useState(null);
  const [eligibilityLearner, setEligibilityLearner] = useState(null);
  const [policyModalOpen, setPolicyModalOpen] = useState(false);

  async function handleApply() {
    try {
      await data.applyAction();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleCheckEligibility() {
    await data.checkClassEligibility();
  }

  const allSelected = data.candidates.length > 0 && data.selectedIds.size === data.candidates.length;
  const selectedClass = data.classes.find((c) => c.id === data.classId);
  const selectedProgrammeId = selectedClass?.programmeId || null;
  const selectedProgrammeName = selectedClass?.programmeName || null;

  return (
    <div>
      <PageHeader title="Bulk Promotion" />

      {data.catalogStatus === "loading" && <LoadingState label="Loading classes and campuses…" />}
      {data.catalogStatus === "forbidden" && <UnauthorizedState description="Bulk Promotion is limited to administrators." />}
      {data.catalogStatus === "error" && <ErrorState description={data.catalogError} action={{ label: "Try again", onClick: data.reloadCatalogs }} />}

      {data.catalogStatus === "ready" && (
        <>
          <Card padding>
            <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
              Pick a campus and class/level, then find learners to promote to the next class in sequence (Foundation → Framework → Skyline), have them repeat the year, transfer them, or
              graduate final-class learners. Every action here is written to each learner's promotion history for audit — it never touches past terms' grades, attendance, or payments.
            </p>
            {/* Phase 2 — clarify that promotion does not lift period payment restrictions */}
            <Alert variant="info" style={{ marginBottom: "var(--space-3)" }}>
              Promoting a learner updates their level. It does not clear any outstanding period payment — learners with unpaid periods will remain access-restricted until those are settled.
            </Alert>
            <div className="grid-2">
              <FormField label="Campus">
                <Select value={data.campus} onChange={(e) => data.setCampus(e.target.value)}>
                  <option value="">All campuses</option>
                  {data.campuses.map((c) => (
                    <option key={c.id || c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Class / Level">
                <Select value={data.classId} onChange={(e) => data.setClassId(e.target.value)}>
                  {data.classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <div style={{ marginTop: "var(--space-3)", display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
              <Button onClick={data.findLearners}>Find learners</Button>
              <Button variant="secondary" onClick={() => setPolicyModalOpen(true)} disabled={!selectedProgrammeId}>
                Promotion Policy…
              </Button>
            </div>
          </Card>

          {data.previewStatus === "loading" && (
            <Card padding style={{ marginTop: "var(--space-4)" }}>
              <LoadingState label="Finding learners…" />
            </Card>
          )}
          {data.previewStatus === "error" && (
            <div style={{ marginTop: "var(--space-4)" }}>
              <ErrorState description={data.previewError} action={{ label: "Try again", onClick: data.findLearners }} />
            </div>
          )}

          {data.previewStatus === "ready" && (
            <Card padding style={{ marginTop: "var(--space-4)" }}>
              {data.resultSummary !== null ? (
                <>
                  <p className="text-helper">{data.resultSummary}</p>
                  <Button variant="secondary" size="sm" style={{ marginTop: "var(--space-3)" }} onClick={data.backToList}>
                    Back to list
                  </Button>
                </>
              ) : data.candidates.length === 0 ? (
                <p className="text-helper">No eligible learners found for that campus/class combination (graduated learners are excluded here — see their record in Manage Accounts for history).</p>
              ) : (
                <>
                  <p className="text-helper" style={{ marginBottom: "var(--space-3)" }}>
                    {data.candidates.length} learner(s) found. Select who this action applies to, then choose what to do with them.
                  </p>
                  <Button variant="secondary" size="sm" style={{ marginBottom: "var(--space-3)" }} loading={data.eligibilityStatus === "loading"} onClick={handleCheckEligibility}>
                    Check Promotion Policy eligibility
                  </Button>
                  {data.eligibilityStatus === "error" && (
                    <Alert variant="danger" style={{ marginBottom: "var(--space-3)" }}>
                      Couldn't check eligibility — try again.
                    </Alert>
                  )}
                  <DataTable
                    columns={[
                      {
                        key: "select",
                        header: <Checkbox checked={allSelected} onChange={(e) => data.toggleSelectAll(e.target.checked)} />,
                        render: (l) => <Checkbox checked={data.selectedIds.has(l.id)} onChange={() => data.toggleSelected(l.id)} />,
                      },
                      { key: "name", header: "Name", render: (l) => l.name },
                      { key: "campus", header: "Campus", render: (l) => l.campus || "—" },
                      {
                        key: "eligible",
                        header: "Promotion Policy",
                        render: (l) => {
                          const result = data.eligibilityByLearner[l.id];
                          if (!result) return "—";
                          if (result.blocked) return <span className="text-helper">n/a</span>;
                          return <Badge tone={result.eligible ? "success" : "danger"}>{result.eligible ? "Eligible" : "Not eligible"}</Badge>;
                        },
                      },
                      {
                        key: "eligibility",
                        header: "",
                        render: (l) => (
                          <Button variant="ghost" size="sm" onClick={() => setEligibilityLearner(l)}>
                            Eligibility
                          </Button>
                        ),
                      },
                      {
                        key: "history",
                        header: "",
                        render: (l) => (
                          <Button variant="ghost" size="sm" onClick={() => setLogLearner(l)}>
                            History
                          </Button>
                        ),
                      },
                    ]}
                    rows={data.candidates}
                    getRowKey={(l) => l.id}
                  />

                  <div className="grid-2" style={{ marginTop: "var(--space-4)", alignItems: "flex-end" }}>
                    <FormField label="Action">
                      <Select value={data.action} onChange={(e) => data.setAction(e.target.value)}>
                        <option value="promote">{ACTION_LABELS.promote}</option>
                        <option value="promote_eligible">{ACTION_LABELS.promote_eligible}</option>
                        <option value="promote_override">{ACTION_LABELS.promote_override}</option>
                        {data.isFinalClass && <option value="graduate">{ACTION_LABELS.graduate}</option>}
                        <option value="repeat">{ACTION_LABELS.repeat}</option>
                        <option value="transfer_class">{ACTION_LABELS.transfer_class}</option>
                        <option value="transfer_campus">{ACTION_LABELS.transfer_campus}</option>
                      </Select>
                    </FormField>
                    {data.action === "promote_override" && (
                      <FormField label="Override reason (only needed for learners who don't meet the Promotion Policy)">
                        <Input
                          type="text"
                          value={data.overrideReason}
                          onChange={(e) => data.setOverrideReason(e.target.value)}
                          placeholder="e.g. Admin discretion — special circumstances"
                        />
                      </FormField>
                    )}
                    {data.action === "transfer_class" && (
                      <FormField label="Target class">
                        <Select value={data.targetClassId} onChange={(e) => data.setTargetClassId(e.target.value)}>
                          <option value="">— select —</option>
                          {data.classes.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                    )}
                    {data.action === "transfer_campus" && (
                      <FormField label="Target campus">
                        <Select value={data.targetCampus} onChange={(e) => data.setTargetCampus(e.target.value)}>
                          <option value="">— select —</option>
                          {data.campuses.map((c) => (
                            <option key={c.id || c.name} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                    )}
                  </div>
                  {((data.action === "transfer_class" && !data.targetClassId) || (data.action === "transfer_campus" && !data.targetCampus)) && (
                    <Alert variant="info" style={{ marginTop: "var(--space-3)" }}>
                      Choose a target above before applying.
                    </Alert>
                  )}
                  <Button
                    style={{ marginTop: "var(--space-3)" }}
                    loading={data.applying}
                    disabled={(data.action === "transfer_class" && !data.targetClassId) || (data.action === "transfer_campus" && !data.targetCampus)}
                    onClick={handleApply}
                  >
                    Apply to selected
                  </Button>
                </>
              )}
            </Card>
          )}
        </>
      )}

      <PromotionLogModal
        learner={logLearner}
        loadLog={data.loadPromotionLog}
        onReverse={async (logId) => {
          await data.reversePromotion(logId);
          toast.success("Reversed — the learner's prior Programme Level has been restored.");
        }}
        onClose={() => setLogLearner(null)}
      />

      <PromotionEligibilityModal learner={eligibilityLearner} onClose={() => setEligibilityLearner(null)} />

      {policyModalOpen && selectedProgrammeId && (
        <PromotionPolicyModal
          programmeId={selectedProgrammeId}
          programmeName={selectedProgrammeName}
          onClose={() => setPolicyModalOpen(false)}
          onSaved={() => toast.success("Promotion Policy saved.")}
        />
      )}
    </div>
  );
}
