// Bachs.io gateway. Built from Bachs's docs:
//   Create checkout:  https://docs.bachs.io (Accept a payment with Checkout)
//   Webhooks:         X-Bachs-Signature-V2 = "t=<unix seconds>,v1=<hex>[,v1=<hex>...]"
//                     v1 = HMAC-SHA256( secret, "<t>." + rawBody )
// Money to Bachs is a decimal STRING ("20500.00"), never kobo/cents.
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300; // reject webhooks older than 5 minutes (replay protection)

// sk_live_ keys talk to the real API, anything else to the sandbox (play money).
const base = () => {
  if (process.env.BACHS_API_BASE) return process.env.BACHS_API_BASE.replace(/\/$/, "");
  return (process.env.BACHS_API_KEY || "").startsWith("sk_live_")
    ? "https://api.bachs.io"
    : "https://sandbox-api.bachs.io";
};

// Which payment methods each currency offers. Naira stays naira (card + bank transfer),
// Dollar stays dollar (card + crypto). Change in .env if your account has other methods.
const methods = (currency) =>
  (process.env[`BACHS_METHODS_${currency}`] ||
    (currency === "NGN" ? "NGN_CARD,NGN_BANK_TRANSFER" : "USD_CARD,CRYPTO"))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const decimal = (minor) => (minor / 100).toFixed(2); // 2000000 -> "20000.00"
const toMinor = (str) => Math.round(Number(str) * 100); // "20000.00" -> 2000000

export async function createPayment({ order, customer, successUrl, cancelUrl, holdMinutes = 30 }) {
  if (!process.env.BACHS_API_KEY) throw new Error("BACHS_API_KEY is not set");

  // Bachs refuses localhost / private addresses for the return pages, even in the sandbox
  for (const url of [successUrl, cancelUrl]) {
    if (!/^https?:\/\//.test(url) || /^https?:\/\/(localhost|127\.|192\.168\.|10\.)/.test(url)) {
      throw new Error(`SITE_URL must be your public website address (got ${url}); Bachs refuses localhost`);
    }
  }

  const body = {
    // a raw amount in the customer's chosen currency, delivery included
    pricing: { currency: order.currency, amount: decimal(order.total) },
    payment_method_types: methods(order.currency),
    customer: { email: customer.email, name: customer.name },
    success_url: successUrl,
    cancel_url: cancelUrl,
    reference: order.ref, // our order number; Bachs keeps these unique
    metadata: { order_ref: order.ref },
    expires_in_minutes: holdMinutes, // same as how long we hold the stock
  };

  const res = await fetch(`${base()}/v1/checkout-sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.BACHS_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.checkout_url || !data.checkout_id) {
    throw new Error(`Bachs refused the checkout (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { url: data.checkout_url, ref: data.checkout_id };
}

// Check the signature, then turn Bachs's event into our simple shape.
export function verifyWebhook(rawBody, headers) {
  const secret = process.env.BACHS_WEBHOOK_SECRET;
  if (!secret) throw new Error("BACHS_WEBHOOK_SECRET is not set");

  const header = String(headers["x-bachs-signature-v2"] || "");
  const parts = header.split(",").map((p) => p.split("=", 2));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v);

  if (!Number.isFinite(t) || signatures.length === 0) throw new Error("missing signature");
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) throw new Error("signature too old");

  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();

  // During a secret rotation Bachs sends several v1 values: any one matching is enough
  const ok = signatures.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new Error("signature mismatch");

  const event = JSON.parse(rawBody.toString("utf8"));
  const d = event.data ?? {};

  // collection.succeeded carries the amount, so it is the one we trust to mark an order paid.
  // checkout.completed arrives too; we ignore it (the other event is enough, and has the money).
  const paid = event.type === "collection.succeeded" && d.status === "SUCCEEDED";

  return {
    eventId: event.id,
    type: paid ? "paid" : "ignore",
    orderRef: d.metadata?.order_ref ?? d.reference ?? null, // if Bachs includes it
    paymentRef: d.checkout_id ?? null, // we saved this when we created the checkout
    amount: d.amount != null ? toMinor(d.amount) : null,
    currency: d.currency ?? null,
    raw: event,
  };
}
