import { useEffect, useRef, useState } from "react";
import { Modal, Button, FormField, Input, Select, Alert } from "../../components/ui";
import { initiateMonthlyPayment, submitPaymentOtp, verifyPayment } from "../../api/parent";
import { DEFAULT_COUNTRY } from "../../utils/countries";

const NETWORKS = ["MTN", "Vodafone", "AirtelTigo"];
const MAX_POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 3000;
// Same key/shape RegisterPage.jsx's card-payment redirect uses — every CARD
// charge (registration, monthly, enrolment) is sent back through the exact
// same Paystack callback_url (routes/payments.js), so RegisterPage's resume
// effect is the one place that ever reads this. The `kind: "monthly"` tag
// is what tells it this is NOT a new-account resume — see its handling of
// `saved.kind` for the standalone confirmation shown there instead.
const CARD_PAYMENT_RESUME_KEY = "bl_pending_card_payment";

/**
 * "Pay this month's fee" (Phase 22) — migrates legacy payMonthly()
 * (dashboard.html), same Mobile Money charge/OTP/poll flow against the
 * same endpoints (POST /api/payments/:childId/initiate, POST
 * /api/payments/otp, GET /api/payments/:reference/verify — see
 * api/parent.js). The backend (server/src/routes/payments.js) remains
 * the sole authority on amount, fee type, and success/failure; this only
 * drives the same three-step UI legacy did, in a modal with a keypad-
 * friendly OTP field instead of a native prompt().
 *
 * `country` (the paying account's users.country — pass the child/learner's
 * own value, same field RegisterPage's isGhanaRegistrant check uses) picks
 * Mobile Money vs Paystack's hosted CARD checkout, exactly like
 * registration's own payment-method boundary. Ghana Mobile Money numbers
 * don't exist for a non-Ghana account, so without this a non-Ghana learner
 * had no way at all to pay their monthly fee after registering by card.
 */
export default function PayMonthlyFeeModal({ open, onClose, childId, childName, country, onSuccess }) {
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

  // Stop polling on unmount so a closed/navigated-away modal doesn't keep
  // hitting the verify endpoint in the background.
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
          setMessage("Payment successful ✅");
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
      const charge = await initiateMonthlyPayment(childId, { network, momoNumber });
      referenceRef.current = charge.reference;
      if (charge.status === "success") {
        setStage("success");
        setMessage("Payment successful ✅");
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

  // Non-Ghana path: Paystack's hosted card checkout, same redirect/resume
  // mechanism RegisterPage.jsx's card path uses (see CARD_PAYMENT_RESUME_KEY
  // above) — no OTP step here, Paystack's own page handles it.
  async function handleCardSubmit() {
    setError(null);
    setStage("submitting");
    setMessage("Redirecting you to secure checkout…");
    try {
      const charge = await initiateMonthlyPayment(childId, { method: "CARD" });
      referenceRef.current = charge.reference;
      // Dev-mode fallback (no PAYSTACK_SECRET_KEY configured) resolves
      // inline, same as the Mobile Money dev fallback above.
      if (charge.status === "success") {
        setStage("success");
        setMessage("Payment successful ✅");
        onSuccess?.();
        return;
      }
      if (!charge.authorizationUrl) {
        setStage("form");
        setError("Couldn't start the card payment. Please try again.");
        return;
      }
      try {
        sessionStorage.setItem(CARD_PAYMENT_RESUME_KEY, JSON.stringify({ reference: charge.reference, kind: "monthly" }));
      } catch {
        // sessionStorage unavailable — the redirect/verification itself
        // still works fine via the reference in the return URL, resume
        // just won't auto-confirm.
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
    if (stage === "submitting" || stage === "polling") return; // mid-flow — don't let this get abandoned
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    onClose();
  }

  const busy = stage === "submitting" || stage === "polling";

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Pay this month's fee${childName ? ` — ${childName}` : ""}`}
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
