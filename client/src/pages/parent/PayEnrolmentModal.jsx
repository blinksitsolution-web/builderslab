import { useEffect, useRef, useState } from "react";
import { Modal, Button, FormField, Input, Select, Alert } from "../../components/ui";
import { initiateEnrolmentPayment, submitPaymentOtp, verifyPayment } from "../../api/parent";
import { DEFAULT_COUNTRY } from "../../utils/countries";

const NETWORKS = ["MTN", "Vodafone", "AirtelTigo"];
const MAX_POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 3000;
// Same key/shape RegisterPage.jsx's card-payment redirect uses, and the
// exact same reasoning as PayMonthlyFeeModal.jsx's copy of this constant —
// see that file's comment for why `kind: "enrolment"` matters here.
const CARD_PAYMENT_RESUME_KEY = "bl_pending_card_payment";

/**
 * "Pay registration fee to activate this programme" (Phase 33) — migrates
 * legacy openEnrolPayBox()/payAdditionalEnrolment() (dashboard.html): the
 * exact same Mobile Money charge/OTP/poll flow PayMonthlyFeeModal already
 * uses for the monthly fee, just tagged with programmeEnrollmentId so the
 * server activates this one additional enrolment instead of the account's
 * primary status (POST /api/payments/:childId/initiate — see
 * server/src/routes/payments.js and utils/paymentActivation.js).
 *
 * Reached two ways, same as legacy: right after enrolling via
 * EnrolAdditionalProgrammeModal, or from "Pay to activate" on an existing
 * pending_payment row in ParentProgrammesPage.
 *
 * `country` picks Mobile Money vs Paystack's hosted CARD checkout, same
 * boundary as PayMonthlyFeeModal.jsx and registration itself — see that
 * file's comment for why this is needed at all.
 */
export default function PayEnrolmentModal({ open, onClose, childId, childName, enrollmentId, programmeName, country, onSuccess }) {
  const isGhana = (country || DEFAULT_COUNTRY) === DEFAULT_COUNTRY;
  const [network, setNetwork] = useState("MTN");
  const [momoNumber, setMomoNumber] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState("form"); // "form" | "submitting" | "otp" | "polling" | "success" | "failed"
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const referenceRef = useRef(null);
  const pollRef = useRef(null);
  const attemptsRef = useRef(0);

  useEffect(() => {
    if (!open) {
      setNetwork("MTN");
      setMomoNumber("");
      setOtp("");
      setStage("form");
      setMessage(null);
      setError(null);
      attemptsRef.current = 0;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function startPolling(reference) {
    attemptsRef.current = 0;
    setStage("polling");
    setMessage("Waiting for confirmation…");
    pollRef.current = setInterval(async () => {
      attemptsRef.current += 1;
      try {
        const { status } = await verifyPayment(reference);
        if (status === "success") {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setStage("success");
          setMessage("Payment successful ✅ — programme activated.");
          onSuccess?.();
        } else if (status === "failed" || attemptsRef.current > MAX_POLL_ATTEMPTS) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setStage("failed");
          setError("Payment wasn't completed — try again.");
        }
      } catch (e) {
        if (attemptsRef.current > MAX_POLL_ATTEMPTS) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setStage("failed");
          setError(e.message);
        }
      }
    }, POLL_INTERVAL_MS);
  }

  async function handleSubmit() {
    setError(null);
    if (!/^0\d{9}$/.test(momoNumber)) {
      setError("Enter a valid 10-digit Mobile Money number.");
      return;
    }
    setStage("submitting");
    setMessage(`Sending prompt to ${momoNumber} — approve on your phone…`);
    try {
      const charge = await initiateEnrolmentPayment(childId, { network, momoNumber, programmeEnrollmentId: enrollmentId });
      referenceRef.current = charge.reference;
      if (charge.status === "success") {
        setStage("success");
        setMessage("Payment successful ✅ — programme activated.");
        onSuccess?.();
        return;
      }
      if (charge.status === "send_otp") {
        setStage("otp");
        setMessage(charge.displayText || "Enter the OTP your network just sent you.");
        return;
      }
      startPolling(charge.reference);
    } catch (e) {
      setStage("form");
      setError(e.message);
    }
  }

  // Non-Ghana path: same hosted-checkout redirect/resume as
  // PayMonthlyFeeModal.jsx's handleCardSubmit — see its comments.
  async function handleCardSubmit() {
    setError(null);
    setStage("submitting");
    setMessage("Redirecting you to secure checkout…");
    try {
      const charge = await initiateEnrolmentPayment(childId, { method: "CARD", programmeEnrollmentId: enrollmentId });
      referenceRef.current = charge.reference;
      if (charge.status === "success") {
        setStage("success");
        setMessage("Payment successful ✅ — programme activated.");
        onSuccess?.();
        return;
      }
      if (!charge.authorizationUrl) {
        setStage("form");
        setError("Couldn't start the card payment. Please try again.");
        return;
      }
      try {
        sessionStorage.setItem(CARD_PAYMENT_RESUME_KEY, JSON.stringify({ reference: charge.reference, kind: "enrolment" }));
      } catch {
        // sessionStorage unavailable — verification still works via the
        // reference in the return URL, resume just won't auto-confirm.
      }
      window.location.href = charge.authorizationUrl;
    } catch (e) {
      setStage("form");
      setError(e.message);
    }
  }

  async function handleOtpSubmit() {
    setError(null);
    if (!otp.trim()) {
      setError("Enter the OTP.");
      return;
    }
    try {
      await submitPaymentOtp(referenceRef.current, otp.trim());
      startPolling(referenceRef.current);
    } catch (e) {
      setError(e.message);
    }
  }

  function handleClose() {
    if (stage === "submitting" || stage === "polling") return;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    onClose();
  }

  const busy = stage === "submitting" || stage === "polling";
  const title = `Pay registration fee${programmeName ? ` — ${programmeName}` : ""}${childName ? ` (${childName})` : ""}`;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      footer={
        stage === "form" ? (
          <>
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={isGhana ? handleSubmit : handleCardSubmit}>{isGhana ? "Pay via Mobile Money" : "Continue to secure payment"}</Button>
          </>
        ) : stage === "otp" ? (
          <>
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={handleOtpSubmit}>Submit OTP</Button>
          </>
        ) : stage === "success" || stage === "failed" ? (
          <Button onClick={handleClose}>Close</Button>
        ) : (
          <Button loading disabled>
            {stage === "submitting" ? "Sending…" : "Waiting…"}
          </Button>
        )
      }
    >
      {stage === "form" && isGhana && (
        <>
          <FormField label="Network">
            <Select value={network} onChange={(e) => setNetwork(e.target.value)}>
              {NETWORKS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Mobile Money number">
            <Input value={momoNumber} onChange={(e) => setMomoNumber(e.target.value)} placeholder="05XXXXXXXX" disabled={busy} />
          </FormField>
        </>
      )}

      {stage === "form" && !isGhana && (
        <Alert variant="info">You'll be taken to Paystack's secure checkout to pay by card. Amounts are charged in GHS (your card issuer converts automatically).</Alert>
      )}

      {stage === "otp" && (
        <FormField label="OTP" helperText={message}>
          <Input value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoFocus />
        </FormField>
      )}

      {(stage === "submitting" || stage === "polling") && <p className="text-helper">{message}</p>}

      {stage === "success" && <Alert variant="success">{message}</Alert>}

      {error && (
        <div style={{ marginTop: "var(--space-3)" }}>
          <Alert variant="danger">{error}</Alert>
        </div>
      )}
    </Modal>
  );
}
