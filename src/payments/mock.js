// FAKE gateway so you can test the whole shop without real money.
// The "payment page" is /api/mock-pay/<ref> on this server.
import { createHmac, timingSafeEqual } from "node:crypto";

const secret = () => process.env.MOCK_SECRET || "dev-only-secret";

export const sign = (body) => createHmac("sha256", secret()).update(body).digest("hex");

export async function createPayment({ order }) {
  const base = (process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, "");
  return { url: `${base}/api/mock-pay/${order.ref}`, ref: `mock_${order.ref}` };
}

export function verifyWebhook(rawBody, headers) {
  const given = Buffer.from(String(headers["x-mock-signature"] || ""), "hex");
  const want = Buffer.from(sign(rawBody), "hex");
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new Error("bad signature");
  }
  const b = JSON.parse(rawBody.toString("utf8"));
  return {
    eventId: b.id,
    type: b.type === "payment.succeeded" ? "paid" : b.type === "payment.failed" ? "failed" : "ignore",
    orderRef: b.ref,
    amount: b.amount ?? null,
    currency: b.currency ?? null,
    raw: b,
  };
}
