import { randomInt } from "node:crypto";
import { pool } from "./db.js";

export const MAX_QTY = 10;
const HOLD_MINUTES = 15;

// Errors we want the customer to see (vs. real crashes, which stay hidden)
export class CheckoutError extends Error {}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I mix-ups
const makeRef = () =>
  "ZUEZ-" + Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

const clean = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function validate(body) {
  const currency = body?.currency;
  if (!["NGN", "USD"].includes(currency)) throw new CheckoutError("Choose Naira or Dollar.");

  const c = body.customer ?? {};
  const customer = {
    name: clean(c.name, 120),
    email: clean(c.email, 200).toLowerCase(),
    phone: clean(c.phone, 40),
    address: clean(c.address, 300),
    city: clean(c.city, 100),
    state: clean(c.state, 100),
    country: clean(c.country, 100),
  };
  if (!customer.name) throw new CheckoutError("Please enter your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))
    throw new CheckoutError("Please enter a valid email.");
  if (customer.phone.replace(/\D/g, "").length < 7)
    throw new CheckoutError("Please enter a valid phone number.");
  if (!customer.address || !customer.city || !customer.country)
    throw new CheckoutError("Please fill in your delivery address.");

  const zoneId = Number(body.zoneId);
  if (!Number.isInteger(zoneId)) throw new CheckoutError("Choose where we're delivering to.");

  // merge duplicate lines, and check each one
  const merged = new Map();
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const variantId = Number(it.variantId);
    const qty = Number(it.qty);
    const size = clean(it.size, 10);
    if (!Number.isInteger(variantId) || !Number.isInteger(qty) || qty < 1)
      throw new CheckoutError("Something in your bag is invalid.");
    const key = `${variantId}|${size}`;
    merged.set(key, { variantId, size, qty: (merged.get(key)?.qty ?? 0) + qty });
  }
  const items = [...merged.values()];
  if (items.length === 0) throw new CheckoutError("Your bag is empty.");
  if (items.some((i) => i.qty > MAX_QTY)) throw new CheckoutError(`Maximum ${MAX_QTY} of each item.`);

  return { currency, customer, zoneId, items };
}

export async function createOrder(body) {
  const { currency, customer, zoneId, items } = validate(body);
  const priceCol = currency === "NGN" ? "price_ngn" : "price_usd";
  const feeCol = currency === "NGN" ? "fee_ngn" : "fee_usd";

  const client = await pool.connect();
  try {
    // A transaction = all of the steps below succeed together, or none do.
    await client.query("BEGIN");

    const zone = (
      await client.query(`SELECT name, ${feeCol} AS fee FROM shipping_zones WHERE id = $1`, [zoneId])
    ).rows[0];
    if (!zone || zone.fee === null)
      throw new CheckoutError(`We can't deliver there when paying in ${currency === "NGN" ? "Naira" : "Dollars"}.`);

    let subtotal = 0;
    const lines = [];

    for (const it of items) {
      // FOR UPDATE locks this stock row until we finish, so two customers
      // buying the last item at the same moment can't both get it.
      const { rows } = await client.query(
        `SELECT s.id AS stock_id, s.quantity, v.id AS variant_id, v.label,
                p.name, p.${priceCol} AS price
         FROM stock s
         JOIN variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE s.variant_id = $1 AND s.size = $2 AND p.active
         FOR UPDATE OF s`,
        [it.variantId, it.size]
      );
      const row = rows[0];
      if (!row) throw new CheckoutError("An item in your bag is no longer available.");
      if (row.quantity < it.qty)
        throw new CheckoutError(
          row.quantity === 0
            ? `${row.name} (${it.size || "one size"}) just sold out.`
            : `Only ${row.quantity} of ${row.name} (${it.size || "one size"}) left.`
        );

      await client.query("UPDATE stock SET quantity = quantity - $1 WHERE id = $2", [it.qty, row.stock_id]);

      subtotal += row.price * it.qty;
      lines.push({ ...it, name: row.name, variant: row.label, unitPrice: row.price });
    }

    const total = subtotal + zone.fee;
    const ref = makeRef();

    const { rows: [order] } = await client.query(
      `INSERT INTO orders (ref, currency, subtotal, shipping_fee, total,
                           customer_name, email, phone, address, city, state, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, ref`,
      [ref, currency, subtotal, zone.fee, total, customer.name, customer.email, customer.phone,
       customer.address, customer.city, customer.state, customer.country]
    );

    for (const l of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, variant_id, name, variant, size, qty, unit_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [order.id, l.variantId, l.name, l.variant, l.size, l.qty, l.unitPrice]
      );
    }

    await client.query("COMMIT");
    return { id: order.id, ref: order.ref, currency, subtotal, shippingFee: zone.fee, total };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Unpaid orders give their stock back after HOLD_MINUTES.
export async function releaseExpiredOrders(minutes = HOLD_MINUTES) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE orders SET status = 'expired'
       WHERE status = 'pending' AND created_at < now() - make_interval(mins => $1)
       RETURNING id`,
      [minutes]
    );
    if (rows.length) {
      await client.query(
        `UPDATE stock s SET quantity = s.quantity + x.qty
         FROM (SELECT variant_id, size, SUM(qty)::int AS qty
               FROM order_items WHERE order_id = ANY($1::uuid[]) AND variant_id IS NOT NULL
               GROUP BY variant_id, size) x
         WHERE s.variant_id = x.variant_id AND s.size = x.size`,
        [rows.map((r) => r.id)]
      );
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
