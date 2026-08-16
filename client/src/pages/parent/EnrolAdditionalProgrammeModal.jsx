import { useEffect, useState } from "react";
import { Modal, Button, FormField, Select, Alert, Spinner } from "../../components/ui";
import { fetchEligibleOfferings, enrolInAdditionalProgramme, fetchEnrolmentFeePreview } from "../../api/parent";
import { fetchProgrammesFor, fetchClassesFor } from "../../api/public";

/**
 * "+ Enrol in another programme" (Phase 33) — migrates legacy
 * toggleEnrolForm() / onEnrolOfferingChange() / onEnrolProgrammeChange() /
 * onEnrolClassChange() / submitAdditionalEnrolment() (dashboard.html): the
 * same cascading Offering Type -> Programme -> Batch/Cohort picker
 * self-registration uses, scoped to whichever audience (adult /
 * parent-learner) this child's account belongs to
 * (GET /api/enrolments/eligible-offerings), plus a live fee preview
 * (GET /api/enrolments/fee-preview) before committing.
 *
 * On successful submit (POST /api/enrolments), this closes and hands the
 * new pending_payment enrolment up via onEnrolled so the page can open
 * PayEnrolmentModal — exactly like legacy's submitAdditionalEnrolment()
 * handing off to openEnrolPayBox().
 */
export default function EnrolAdditionalProgrammeModal({ open, onClose, childId, childName, onEnrolled }) {
  const [loadStatus, setLoadStatus] = useState("loading"); // "loading" | "ready" | "error" | "empty"
  const [loadError, setLoadError] = useState(null);
  const [offerings, setOfferings] = useState([]);
  const [audience, setAudience] = useState(null);

  const [offeringId, setOfferingId] = useState("");
  const [programmes, setProgrammes] = useState([]);
  const [programmeId, setProgrammeId] = useState("");
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState("");

  const [feePreview, setFeePreview] = useState(null); // { amountGHS, discounted } | null

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setLoadStatus("loading");
    setLoadError(null);
    setOfferingId("");
    setProgrammes([]);
    setProgrammeId("");
    setClasses([]);
    setClassId("");
    setFeePreview(null);
    setError(null);
    setSubmitting(false);

    fetchEligibleOfferings(childId)
      .then(({ offerings: rows, audience: aud }) => {
        setOfferings(rows);
        setAudience(aud);
        setLoadStatus(rows.length ? "ready" : "empty");
      })
      .catch((e) => {
        setLoadError(e.message || "Couldn't load Learning Offerings.");
        setLoadStatus("error");
      });
  }, [open, childId]);

  async function handleOfferingChange(value) {
    setOfferingId(value);
    setProgrammeId("");
    setClasses([]);
    setClassId("");
    setFeePreview(null);
    if (!value) {
      setProgrammes([]);
      return;
    }
    const rows = await fetchProgrammesFor({ offeringTypeId: value, audience });
    setProgrammes(rows);
  }

  async function handleProgrammeChange(value) {
    setProgrammeId(value);
    setClassId("");
    setFeePreview(null);
    if (!value) {
      setClasses([]);
      return;
    }
    const rows = await fetchClassesFor(value);
    setClasses(rows);
  }

  async function handleClassChange(value) {
    setClassId(value);
    setFeePreview(null);
    if (!value) return;
    try {
      const preview = await fetchEnrolmentFeePreview(childId, value);
      setFeePreview(preview);
    } catch {
      // Fee preview is a courtesy — submitting still works if it fails to load.
      setFeePreview(null);
    }
  }

  async function handleSubmit() {
    if (!programmeId || !classId) {
      setError("Choose a Programme and a Batch/Cohort first.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { enrolment } = await enrolInAdditionalProgramme({ targetUserId: childId, programmeId, classId });
      onEnrolled?.(enrolment);
    } catch (e) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  const canSubmit = !!programmeId && !!classId && !submitting;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Enrol in another programme${childName ? ` — ${childName}` : ""}`}
      footer={
        loadStatus === "ready" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
              Enrol
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {loadStatus === "loading" && (
        <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-4)" }}>
          <Spinner />
        </div>
      )}

      {loadStatus === "error" && <Alert variant="danger">{loadError}</Alert>}

      {loadStatus === "empty" && <Alert variant="info">No additional Learning Offerings are currently open for self-enrolment on this account.</Alert>}

      {loadStatus === "ready" && (
        <>
          <FormField label="Learning Offering">
            <Select value={offeringId} onChange={(e) => handleOfferingChange(e.target.value)}>
              <option value="">Choose…</option>
              {offerings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.icon ? `${o.icon} ` : ""}
                  {o.name}
                </option>
              ))}
            </Select>
          </FormField>

          {offeringId && (
            <FormField label="Programme">
              <Select value={programmeId} onChange={(e) => handleProgrammeChange(e.target.value)}>
                <option value="">Choose…</option>
                {programmes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </FormField>
          )}

          {programmeId && (
            <FormField label="Batch / Cohort">
              <Select value={classId} onChange={(e) => handleClassChange(e.target.value)}>
                <option value="">Choose…</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
          )}

          {classId && (
            <p className="text-helper">
              {feePreview
                ? (
                  <>
                    Registration fee: <strong>GHS {feePreview.amountGHS}</strong>
                    {feePreview.discounted ? " (multi-ward discount applied)" : ""}
                  </>
                )
                : "Checking fee…"}
            </p>
          )}

          {error && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <Alert variant="danger">{error}</Alert>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
