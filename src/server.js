import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { query } from "./db.js";
import { createOrder, releaseExpiredOrders, CheckoutError } from "./checkout.js";

const app = express();
app.set("trust proxy", 1); // behind Render's proxy, so rate limits see the real visitor IP

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

app.post("/api/checkout", checkoutLimit, async (req, res) => {
  try {
    const order = await createOrder(req.body);
    res.status(201).json(order);
  } catch (e) {
    if (e instanceof CheckoutError) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// Every minute, give back stock held by orders that were never paid
setInterval(() => {
  releaseExpiredOrders().catch((e) => console.error("expiry job:", e.message));
}, 60 * 1000);

app.listen(process.env.PORT || 4000, () =>
  console.log("ZUEZ backend on port", process.env.PORT || 4000)
);
