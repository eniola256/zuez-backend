// Picks the payment gateway from PAYMENT_PROVIDER in .env:
//   none   (default) payments are off: checkout refuses politely
//   mock   a fake gateway for testing on your own computer. NEVER use on the live site.
//   bachs  Bachs.io (see bachs.js: needs finishing from Bachs's docs)
//
// A gateway is a file that exports two functions:
//   createPayment({ order, items, customer, successUrl, cancelUrl }) -> { url, ref }
//   verifyWebhook(rawBody, headers) -> { eventId, type, orderRef, amount, currency, raw }
import * as mock from "./mock.js";
import * as bachs from "./bachs.js";

const gateways = { mock, bachs };

export const providerName = () => (process.env.PAYMENT_PROVIDER || "none").toLowerCase();

export function getGateway(name = providerName()) {
  return gateways[name] ?? null;
}

export class PaymentsOffError extends Error {}
