const express = require("express");
const db = require("../db/db");
const paystack = require("../utils/paystack");
const { activateSuccessfulPayment } = require("../utils/paymentActivation");

const router = express.Router();

// Paystack calls this directly — must use the RAW body for signature
// verification, so this router is mounted in server.js before express.json().
router.post("/", express.raw({ type: "*/*" }), (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!signature || !paystack.verifyWebhookSignature(req.body, signature)) {
    return res.status(401).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch (e) {
    return res.status(400).send("Bad payload");
  }

  if (event.event === "charge.success") {
    const reference = event.data.reference;
    const payment = db.prepare("SELECT * FROM payments WHERE paystack_ref = ?").get(reference);
    if (payment && payment.status !== "successful") activateSuccessfulPayment(payment);
  }
  if (event.event === "charge.failed") {
    db.prepare("UPDATE payments SET status='failed' WHERE paystack_ref=?").run(event.data.reference);
  }

  res.sendStatus(200);
});

module.exports = router;
