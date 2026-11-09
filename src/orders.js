import { pool } from "./db.js";
import { giveBackStock } from "./checkout.js";
import { sendOrderEmails } from "./email.js";

// What the order page is allowed to see: no address, phone or email.
export async function getPublicOrder(ref) {
  const { rows: [o] } = await pool.query(
    "SELECT id, ref, status, currency, subtotal, shipping_fee, total FROM orders WHERE ref = $1",
    [ref]
  );
  if (!o) return null;
  const { rows: items } = await pool.query(
    "SELECT name, variant, size, qty, unit_price FROM order_items WHERE order_id = $1 ORDER BY id",
    [o.id]
  );
  return {
    ref: o.ref,
    status: o.status,
    currency: o.currency,
    subtotal: o.subtotal,
    shippingFee: o.shipping_fee,
    total: o.total,
    items: items.map((i) => ({ name: i.name, variant: i.variant, size: i.size, qty: i.qty, unitPrice: i.unit_price })),
  };
}

export async function attachPayment(orderId, provider, paymentRef) {
  await pool.query("UPDATE orders SET payment_provider = $2, payment_ref = $3 WHERE id = $1", [
    orderId,
    provider,
    paymentRef ?? null,
  ]);
}

// The gateway couldn't even start a payment: cancel the order, free the stock.
export async function cancelOrder(orderId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "UPDATE orders SET status = 'failed' WHERE id = $1 AND status = 'pending' RETURNING id",
      [orderId]
    );
    await giveBackStock(client, rows.map((r) => r.id));
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Apply one verified payment event from a gateway.
 * ev = { eventId, type: "paid" | "failed" | "ignore", orderRef, paymentRef, amount, currency, raw }
 * Safe to call twice with the same event: the second call does nothing.
 */
export async function applyPaymentEvent(provider, ev) {
  const client = await pool.connect();
  let becamePaid = null;
  let result = "ok";

  try {
    await client.query("BEGIN");

    // 1. Have we seen this exact event before?
    const seen = await client.query(
      `INSERT INTO payment_events (provider, event_id, order_ref, type, payload)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      [provider, ev.eventId, ev.orderRef ?? ev.paymentRef ?? null, ev.type, JSON.stringify(ev.raw ?? {})]
    );
    if (seen.rowCount === 0) {
      await client.query("COMMIT");
      return "duplicate";
    }

    if (ev.type === "ignore" || (!ev.orderRef && !ev.paymentRef)) {
      await client.query("COMMIT");
      return "ignored";
    }

    // 2. Lock the order so two webhooks can't change it at the same time
    const { rows: [o] } = await client.query(
      `SELECT * FROM orders
       WHERE ref = $1 OR (payment_provider = $2 AND payment_ref = $3 AND $3 IS NOT NULL)
       FOR UPDATE`,
      [ev.orderRef ?? null, provider, ev.paymentRef ?? null]
    );
    if (!o) {
      await client.query("COMMIT");
      return "unknown-order";
    }

    if (ev.type === "failed") {
      if (o.status === "pending") {
        await client.query("UPDATE orders SET status = 'failed' WHERE id = $1", [o.id]);
        await giveBackStock(client, [o.id]);
      }
      await client.query("COMMIT");
      return "failed";
    }

    // ev.type === "paid"
    if (["paid", "shipped", "delivered"].includes(o.status)) {
      await client.query("COMMIT");
      return "already-paid";
    }

    // 3. Did they pay the right amount, in the right currency?
    const wrongAmount = ev.amount != null && ev.amount !== o.total;
    const wrongCurrency = ev.currency != null && ev.currency !== o.currency;
    if (wrongAmount || wrongCurrency) {
      await client.query("UPDATE orders SET needs_attention = $2 WHERE id = $1", [
        o.id,
        `Payment received does not match the order: got ${ev.amount ?? "?"} ${ev.currency ?? ""}, expected ${o.total} ${o.currency}. Check with the gateway before shipping.`,
      ]);
      await client.query("COMMIT");
      becamePaid = null;
      result = "mismatch";
      return result;
    }

    // 4. Mark it paid. If the hold already ran out, try to take the stock again.
    let note = null;
    if (o.status !== "pending") {
      const { rows: items } = await client.query(
        "SELECT variant_id, size, qty FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL",
        [o.id]
      );
      await client.query("SAVEPOINT retake");
      let ok = true;
      for (const it of items) {
        const r = await client.query(
          "UPDATE stock SET quantity = quantity - $3 WHERE variant_id = $1 AND size = $2 AND quantity >= $3",
          [it.variant_id, it.size, it.qty]
        );
        if (r.rowCount === 0) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        await client.query("ROLLBACK TO SAVEPOINT retake");
        note = "Paid after the 30-minute hold ran out and some items are now out of stock. Refund the customer or restock.";
      }
    }

    await client.query(
      "UPDATE orders SET status = 'paid', paid_at = now(), needs_attention = COALESCE($2, needs_attention) WHERE id = $1",
      [o.id, note]
    );
    await client.query("COMMIT");
    becamePaid = o.id;
    result = "paid";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Emails go out after the database has saved, and never block the webhook reply
  if (becamePaid) sendOrderEmails(becamePaid).catch((e) => console.error("emails:", e.message));
  return result;
}
