import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { query } from "./db.js";
import { createOrder, releaseExpiredOrders, CheckoutError, HOLD_MINUTES } from "./checkout.js";
import { applyPaymentEvent, attachPayment, cancelOrder, getPublicOrder } from "./orders.js";
import { getGateway, providerName, PaymentsOffError } from "./payments/index.js";
import { admin } from "./admin.js";
import { sign as mockSign } from "./payments/mock.js";

const app = express();
app.set("trust proxy", 1); // behind Render's proxy, so rate limits see the real visitor IP

// ── Payment webhooks: the gateway tells us "this order was paid" ──
// Registered BEFORE express.json() because the signature is checked
// against the exact raw bytes the gateway sent.
app.post("/api/webhooks/:provider", express.raw({ type: "*/*", limit: "200kb" }), async (req, res) => {
  const gateway = getGateway(req.params.provider);
  if (!gateway) return res.status(404).end();

  let event;
  try {
    event = gateway.verifyWebhook(req.body, req.headers);
  } catch (e) {
    console.warn("webhook rejected:", e.message);
    return res.status(401).json({ error: "invalid webhook" });
  }

  try {
    const result = await applyPaymentEvent(req.params.provider, event);
    res.json({ received: true, result });
  } catch (e) {
    console.error("webhook processing failed:", e);
    res.status(500).json({ error: "failed" }); // the gateway will retry
  }
});

app.use(express.json());
app.use(
  cors({ origin: (process.env.FRONTEND_URL || "").split(",").map((s) => s.trim()) })
);

// Quick "is it alive and can it reach the database?" check
app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// All products with their styles and stock, in one request
app.get("/api/products", async (_req, res) => {
  try {
    const { rows } = await query(`
      SELECT p.id, p.slug, p.name, p.description, p.category, p.is_new,
             p.price_ngn, p.price_usd,
             COALESCE(json_agg(json_build_object(
               'id', v.id, 'label', v.label, 'color', v.color, 'images', v.images,
               'stock', (SELECT COALESCE(json_object_agg(s.size, s.quantity), '{}'::json)
                         FROM stock s WHERE s.variant_id = v.id)
             ) ORDER BY v.position) FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
      FROM products p
      LEFT JOIN variants v ON v.product_id = p.id
      WHERE p.active
      GROUP BY p.id
      ORDER BY p.id`);
    res.json(rows);
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: "Could not load products" });
  }
});

// Owner admin (login + orders + clothes). Everything inside needs the owner token.
app.use("/api/admin", admin);

// Delivery options for the checkout form
app.get("/api/shipping-zones", async (_req, res) => {
  try {
    const { rows } = await query(
      "SELECT id, name, fee_ngn, fee_usd FROM shipping_zones ORDER BY id"
    );
    res.json(rows);
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: "Could not load delivery options" });
  }
});

// Start checkout: check the bag, hold the stock, create a pending order.
// (Taking the payment comes in the next step.)
const checkoutLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20 });

const siteUrl = () =>
  (process.env.SITE_URL || (process.env.FRONTEND_URL || "").split(",")[0] || "http://localhost:5173")
    .trim()
    .replace(/\/$/, "");

app.post("/api/checkout", checkoutLimit, async (req, res) => {
  let order;
  try {
    const gateway = getGateway();
    if (!gateway) throw new PaymentsOffError("Payments aren't switched on yet. Please try again soon.");

    order = await createOrder(req.body);

    // Ask the gateway for a payment page for this order
    let payment;
    try {
      payment = await gateway.createPayment({
        order,
        items: order.lines,
        customer: order.customer,
        successUrl: `${siteUrl()}/#/order/${order.ref}`,
        cancelUrl: `${siteUrl()}/#/checkout`,
        holdMinutes: HOLD_MINUTES,
      });
    } catch (e) {
      console.error("gateway createPayment failed:", e.message);
      await cancelOrder(order.id); // give the stock back straight away
      throw new PaymentsOffError("We couldn't start the payment. Please try again.");
    }

    await attachPayment(order.id, providerName(), payment.ref);

    res.status(201).json({
      ref: order.ref,
      currency: order.currency,
      subtotal: order.subtotal,
      shippingFee: order.shippingFee,
      total: order.total,
      paymentUrl: payment.url,
    });
  } catch (e) {
    if (e instanceof CheckoutError) return res.status(400).json({ error: e.message });
    if (e instanceof PaymentsOffError) return res.status(503).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// The order page asks "has this been paid yet?" (no personal details are returned)
const orderLimit = rateLimit({ windowMs: 60 * 1000, limit: 200 }); // the order page checks every 3s; shared wifi means many people per address

app.get("/api/orders/:ref", orderLimit, async (req, res) => {
  try {
    const order = await getPublicOrder(String(req.params.ref).toUpperCase());
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: "Could not load the order" });
  }
});

// ── TEST GATEWAY ONLY: a fake payment page, so you can try the flow without money ──
if (providerName() === "mock") {
  console.warn("⚠ PAYMENT_PROVIDER=mock: fake payments are ON. Never use this on the live site.");

  app.get("/api/mock-pay/:ref", async (req, res) => {
    const ref = String(req.params.ref).toUpperCase();
    const result = req.query.result;

    if (result === "paid" || result === "failed") {
      const order = await getPublicOrder(ref);
      if (!order) return res.status(404).send("Order not found");

      // send a properly signed webhook to ourselves, exactly like a real gateway would
      const body = JSON.stringify({
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        type: result === "paid" ? "payment.succeeded" : "payment.failed",
        ref,
        amount: order.total,
        currency: order.currency,
      });
      const base = (process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, "");
      await fetch(`${base}/api/webhooks/mock`, {
        method: "POST",
        headers: { "x-mock-signature": mockSign(Buffer.from(body)) },
        body,
      });
      return res.redirect(`${siteUrl()}/#/order/${ref}`);
    }

    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <body style="font-family:sans-serif;max-width:420px;margin:15vh auto;padding:0 20px">
      <h2>Test payment page</h2><p>Order <b>${ref.replace(/[^A-Z0-9-]/g, "")}</b>. No real money moves here.</p>
      <p><a href="?result=paid" style="display:block;padding:14px;background:#111;color:#fff;text-align:center;text-decoration:none">Pay (success)</a></p>
      <p><a href="?result=failed" style="display:block;padding:14px;border:1px solid #111;text-align:center;text-decoration:none;color:#111">Fail the payment</a></p>`);
  });
}

// Every minute, give back stock held by orders that were never paid
setInterval(() => {
  releaseExpiredOrders().catch((e) => console.error("expiry job:", e.message));
}, 60 * 1000);

app.listen(process.env.PORT || 4000, () =>
  console.log("ZUEZ backend on port", process.env.PORT || 4000)
);
