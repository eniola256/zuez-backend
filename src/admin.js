import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool, query } from "./db.js";
import { adminEnabled, checkPassword, makeToken, requireAdmin } from "./auth.js";
import { cloudinaryEnabled, uploadPermission } from "./cloudinary.js";
import { sendShippedEmail } from "./email.js";

export const admin = Router();

class Bad extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// wraps a route so errors become clean JSON replies
const h = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (e instanceof Bad) return res.status(e.status).json({ error: e.message });
    console.error("admin error:", e);
    res.status(500).json({ error: "Something went wrong." });
  });

// ───────── login ─────────
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, message: { error: "Too many attempts. Try again in 15 minutes." } });

admin.post(
  "/login",
  loginLimit,
  h(async (req, res) => {
    if (!adminEnabled()) throw new Bad("Admin isn't set up on the server yet.", 503);
    if (!checkPassword(req.body?.password)) throw new Bad("Wrong password.", 401);
    res.json({ token: makeToken() });
  })
);

// everything below needs the token
admin.use(requireAdmin);

admin.get("/me", (_req, res) => res.json({ ok: true, uploads: cloudinaryEnabled() }));

admin.get(
  "/upload-permission",
  h(async (_req, res) => {
    if (!cloudinaryEnabled()) throw new Bad("Photo upload isn't set up yet (Cloudinary keys missing).", 503);
    res.json(uploadPermission());
  })
);

// ───────── orders ─────────
const SHIP_STATES = ["paid", "shipped", "delivered"];

admin.get(
  "/orders",
  h(async (req, res) => {
    const status = String(req.query.status || "all");
    const search = String(req.query.q || "").trim().slice(0, 80);
    const where = [];
    const params = [];

    if (status !== "all") {
      params.push(status);
      where.push(`o.status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(o.ref ILIKE $${params.length} OR o.email ILIKE $${params.length} OR o.customer_name ILIKE $${params.length})`);
    }

    const { rows } = await query(
      `SELECT o.ref, o.status, o.currency, o.total, o.customer_name, o.email, o.city, o.country,
              o.created_at, o.paid_at, o.needs_attention,
              COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id = o.id), 0)::int AS item_count
       FROM orders o
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY o.created_at DESC LIMIT 200`,
      params
    );
    const counts = Object.fromEntries(
      (await query("SELECT status, COUNT(*)::int n FROM orders GROUP BY status")).rows.map((r) => [r.status, r.n])
    );
    const attention = (await query("SELECT COUNT(*)::int n FROM orders WHERE needs_attention IS NOT NULL")).rows[0].n;
    res.json({ orders: rows, counts, attention });
  })
);

admin.get(
  "/orders/:ref",
  h(async (req, res) => {
    const { rows: [o] } = await query("SELECT * FROM orders WHERE ref = $1", [req.params.ref.toUpperCase()]);
    if (!o) throw new Bad("Order not found", 404);
    const { rows: items } = await query("SELECT name, variant, size, qty, unit_price FROM order_items WHERE order_id = $1 ORDER BY id", [o.id]);
    res.json({
      ref: o.ref, status: o.status, currency: o.currency,
      subtotal: o.subtotal, shippingFee: o.shipping_fee, total: o.total,
      customer: { name: o.customer_name, email: o.email, phone: o.phone, address: o.address, city: o.city, state: o.state, country: o.country },
      createdAt: o.created_at, paidAt: o.paid_at, shippedAt: o.shipped_at, deliveredAt: o.delivered_at,
      trackingNote: o.tracking_note, needsAttention: o.needs_attention, paymentProvider: o.payment_provider,
      items: items.map((i) => ({ name: i.name, variant: i.variant, size: i.size, qty: i.qty, unitPrice: i.unit_price })),
    });
  })
);

admin.post(
  "/orders/:ref/status",
  h(async (req, res) => {
    const target = req.body?.status;
    const note = typeof req.body?.trackingNote === "string" ? req.body.trackingNote.trim().slice(0, 500) : "";
    if (!SHIP_STATES.includes(target)) throw new Bad("Status must be paid, shipped or delivered.");

    const { rows: [o] } = await query("SELECT id, status FROM orders WHERE ref = $1", [req.params.ref.toUpperCase()]);
    if (!o) throw new Bad("Order not found", 404);
    if (!SHIP_STATES.includes(o.status)) throw new Bad(`An order that is ${o.status} can't be moved. Only paid orders can.`);

    await query(
      `UPDATE orders SET status = $2,
         shipped_at   = CASE WHEN $2 = 'shipped'   THEN COALESCE(shipped_at, now())   ELSE shipped_at END,
         delivered_at = CASE WHEN $2 = 'delivered' THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
         tracking_note = CASE WHEN $3 <> '' THEN $3 ELSE tracking_note END
       WHERE id = $1`,
      [o.id, target, note]
    );

    // The customer is told once, the first time the order is marked shipped
    if (target === "shipped") sendShippedEmail(o.id).catch((e) => console.error("shipped email:", e.message));
    res.json({ ok: true, status: target });
  })
);

admin.post(
  "/orders/:ref/resolve",
  h(async (req, res) => {
    const r = await query("UPDATE orders SET needs_attention = NULL WHERE ref = $1 RETURNING ref", [req.params.ref.toUpperCase()]);
    if (!r.rowCount) throw new Bad("Order not found", 404);
    res.json({ ok: true });
  })
);

// ───────── clothes ─────────
const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
const moneyToMinor = (v, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) throw new Bad(`${label} must be a number above 0.`);
  return Math.round(n * 100);
};

function cleanProduct(b) {
  const name = String(b?.name ?? "").trim();
  if (!name || name.length > 120) throw new Bad("Give the piece a name.");
  if (!["men", "women", "unisex"].includes(b.category)) throw new Bad("Pick men, women or unisex.");
  if (!Array.isArray(b.variants) || b.variants.length < 1 || b.variants.length > 12) throw new Bad("Add at least one style (max 12).");

  const variants = b.variants.map((v, i) => {
    const label = String(v?.label ?? "").trim();
    if (!label || label.length > 40) throw new Bad(`Style ${i + 1} needs a name.`);
    const color = v.color ? String(v.color) : null;
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Bad(`Style "${label}": colour must look like #E8E4DC.`);

    const images = (Array.isArray(v.images) ? v.images : []).map((u) => String(u).trim()).filter(Boolean);
    if (images.length > 8) throw new Bad(`Style "${label}": max 8 photos.`);
    for (const u of images) {
      if (u.length > 500 || !(u.startsWith("/") || /^https:\/\//.test(u))) throw new Bad(`Style "${label}": a photo link must start with https:// or /`);
    }

    const stock = {};
    for (const [size, qty] of Object.entries(v.stock ?? {})) {
      if (size.length > 10) throw new Bad(`Style "${label}": size name too long.`);
      const n = Number(qty);
      if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Bad(`Style "${label}", size ${size || "one size"}: stock must be a whole number.`);
      stock[size.trim()] = n;
    }
    if (Object.keys(stock).length === 0) throw new Bad(`Style "${label}": add at least one size (or One size).`);

    return { id: Number.isInteger(v.id) ? v.id : null, label, color, images, stock };
  });

  return {
    name,
    description: String(b.description ?? "").trim().slice(0, 1000),
    category: b.category,
    isNew: !!b.isNew,
    active: b.active !== false,
    priceNgn: moneyToMinor(b.priceNgn, "The naira price"),
    priceUsd: moneyToMinor(b.priceUsd, "The dollar price"),
    variants,
  };
}

async function loadProducts(where = "", params = []) {
  const { rows } = await query(
    `SELECT p.id, p.slug, p.name, p.description, p.category, p.is_new, p.active, p.price_ngn, p.price_usd,
            COALESCE(json_agg(json_build_object(
              'id', v.id, 'label', v.label, 'color', v.color, 'images', v.images,
              'stock', (SELECT COALESCE(json_object_agg(s.size, s.quantity), '{}'::json) FROM stock s WHERE s.variant_id = v.id)
            ) ORDER BY v.position) FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
     FROM products p LEFT JOIN variants v ON v.product_id = p.id
     ${where} GROUP BY p.id ORDER BY p.id`,
    params
  );
  return rows.map((r) => ({
    id: r.id, slug: r.slug, name: r.name, description: r.description, category: r.category,
    isNew: r.is_new, active: r.active, priceNgn: r.price_ngn / 100, priceUsd: r.price_usd / 100, variants: r.variants,
  }));
}

admin.get("/products", h(async (_req, res) => res.json(await loadProducts())));

// Writes a whole piece (details + styles + stock) in one go, all or nothing.
async function saveProduct(client, productId, p) {
  await client.query(
    `UPDATE products SET name=$2, description=$3, category=$4, is_new=$5, active=$6, price_ngn=$7, price_usd=$8 WHERE id=$1`,
    [productId, p.name, p.description, p.category, p.isNew, p.active, p.priceNgn, p.priceUsd]
  );

  const existing = (await client.query("SELECT id FROM variants WHERE product_id = $1", [productId])).rows.map((r) => r.id);
  const keep = new Set(p.variants.map((v) => v.id).filter(Boolean));
  for (const id of keep) if (!existing.includes(id)) throw new Bad("A style doesn't belong to this piece.");

  // styles that were removed in the editor
  const drop = existing.filter((id) => !keep.has(id));
  if (drop.length) await client.query("DELETE FROM variants WHERE id = ANY($1::int[])", [drop]);

  // move everything out of the way so the new order can't collide
  await client.query("UPDATE variants SET position = position + 1000 WHERE product_id = $1", [productId]);

  for (const [i, v] of p.variants.entries()) {
    let id = v.id;
    if (id) {
      await client.query("UPDATE variants SET label=$2, color=$3, images=$4, position=$5 WHERE id=$1", [id, v.label, v.color, v.images, i]);
    } else {
      id = (await client.query(
        "INSERT INTO variants (product_id, label, color, images, position) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [productId, v.label, v.color, v.images, i]
      )).rows[0].id;
    }

    const sizes = Object.keys(v.stock);
    for (const size of sizes) {
      await client.query(
        `INSERT INTO stock (variant_id, size, quantity) VALUES ($1,$2,$3)
         ON CONFLICT (variant_id, size) DO UPDATE SET quantity = $3`,
        [id, size, v.stock[size]]
      );
    }
    await client.query("DELETE FROM stock WHERE variant_id = $1 AND NOT (size = ANY($2::text[]))", [id, sizes]);
  }
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

admin.post(
  "/products",
  h(async (req, res) => {
    const p = cleanProduct(req.body);
    const id = await inTransaction(async (client) => {
      const base = slugify(String(req.body.slug || p.name)) || "piece";
      let slug = base;
      for (let n = 2; (await client.query("SELECT 1 FROM products WHERE slug = $1", [slug])).rowCount; n++) slug = `${base}-${n}`;

      const { rows: [row] } = await client.query(
        `INSERT INTO products (slug, name, category, price_ngn, price_usd) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [slug, p.name, p.category, p.priceNgn, p.priceUsd]
      );
      await saveProduct(client, row.id, p);
      return row.id;
    });
    res.status(201).json((await loadProducts("WHERE p.id = $1", [id]))[0]);
  })
);

admin.put(
  "/products/:id",
  h(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new Bad("Bad id");
    const p = cleanProduct(req.body);
    await inTransaction(async (client) => {
      if (!(await client.query("SELECT 1 FROM products WHERE id = $1 FOR UPDATE", [id])).rowCount) throw new Bad("Piece not found", 404);
      await saveProduct(client, id, p);
    });
    res.json((await loadProducts("WHERE p.id = $1", [id]))[0]);
  })
);

// Hide / show a piece in the shop without deleting it
admin.post(
  "/products/:id/active",
  h(async (req, res) => {
    const r = await query("UPDATE products SET active = $2 WHERE id = $1 RETURNING id", [Number(req.params.id), !!req.body?.active]);
    if (!r.rowCount) throw new Bad("Piece not found", 404);
    res.json({ ok: true });
  })
);

export { adminEnabled };
