const crypto = require("crypto");
const { getSetting } = require("./settings");

const BASE = "https://api.paystack.co";
const NETWORK_TO_PROVIDER = { MTN: "mtn", Vodafone: "vod", AirtelTigo: "atl" };

function secretKey() {
  const key = getSetting("apiKeys", {}).paystackKey || process.env.PAYSTACK_SECRET_KEY;
  if (!key || key.includes("xxxxxxx") || key.includes("replace_with")) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured — set it in Admin → Settings → API Keys, or in .env.");
  }
  return key;
}

async function paystackFetch(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok) {
    const message = (json && json.message) || `Paystack request failed (${res.status})`;
    throw new Error(message);
  }
  return json;
}

// Initiates a Mobile Money charge. Ghanaian mobile money can resolve in a
// few different ways depending on the network: some return 'pay_offline'
// (customer approves a USSD prompt on their phone), some return 'send_otp'
// (customer must supply an OTP before the charge completes).
async function initiateMobileMoneyCharge({ email, amountGHS, phone, network, reference }) {
  const provider = NETWORK_TO_PROVIDER[network];
  if (!provider) throw new Error(`Unsupported network: ${network}`);
  const body = {
    email,
    amount: Math.round(amountGHS * 100), // Paystack expects the smallest currency unit (pesewas)
    currency: "GHS",
    mobile_money: { phone, provider },
    reference,
  };
  const json = await paystackFetch("/charge", { method: "POST", body: JSON.stringify(body) });
  return json.data; // { status, reference, display_text, ... }
}

// Initiates a hosted card-checkout transaction (the CARD/international
// path — see the international-payment provider readiness analysis).
// Unlike Mobile Money's /charge above (which resolves inline via an
// OTP/USSD prompt), this returns a Paystack-hosted `authorization_url`
// the customer is redirected to; Paystack's own checkout page handles
// card entry and 3D Secure, never this codebase. Charges in GHS
// unconditionally — a Ghana-based merchant settles international card
// payments in GHS regardless of the cardholder's own currency (their
// bank does the conversion) — so there is no FX/currency parameter here
// to get wrong. The webhook (charge.success/charge.failed) and
// verifyTransaction() below are NOT specific to how a transaction was
// started, so both already work for a reference created this way with
// zero changes.
async function initiateCardCharge({ email, amountGHS, reference, callbackUrl }) {
  const body = {
    email,
    amount: Math.round(amountGHS * 100), // pesewas, same unit as Mobile Money
    currency: "GHS",
    channels: ["card"],
    reference,
    callback_url: callbackUrl,
  };
  const json = await paystackFetch("/transaction/initialize", { method: "POST", body: JSON.stringify(body) });
  return json.data; // { authorization_url, access_code, reference }
}

async function submitOtp({ otp, reference }) {
  const json = await paystackFetch("/charge/submit_otp", {
    method: "POST",
    body: JSON.stringify({ otp, reference }),
  });
  return json.data;
}

async function verifyTransaction(reference) {
  const json = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
  return json.data; // { status: 'success'|'failed'|..., amount, reference, ... }
}

// Paystack signs webhook bodies with your secret key so you can trust the
// event actually came from Paystack (never trust a client-reported "success").
function verifyWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto.createHmac("sha512", secretKey()).update(rawBody).digest("hex");
  return hash === signatureHeader;
}

module.exports = { initiateMobileMoneyCharge, initiateCardCharge, submitOtp, verifyTransaction, verifyWebhookSignature };
