// Emails go out through Resend's web API (Render's free plan blocks SMTP).
// Without RESEND_API_KEY nothing is sent: the email is printed in the log instead.
import { pool } from "./db.js";
import { money } from "./money.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function sendMail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[email not sent: no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "ZUEZ <onboarding@resend.dev>",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const itemRows = (items, currency) =>
  items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0">${esc(i.name)}<br><span style="color:#777;font-size:13px">${esc(i.variant)}${
          i.size ? " · " + esc(i.size) : " · One size"
        } · ×${i.qty}</span></td><td style="padding:6px 0;text-align:right">${money(i.unit_price * i.qty, currency)}</td></tr>`
    )
    .join("");

const wrap = (inner) =>
  `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111">${inner}</div>`;

function customerHtml(o, items) {
  return wrap(`
    <h2 style="margin:0 0 4px">Thank you, ${esc(o.customer_name.split(" ")[0])}.</h2>
    <p style="color:#555;margin:0 0 20px">Your ZUEZ order <b>${esc(o.ref)}</b> is confirmed and being prepared.</p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #ddd">${itemRows(items, o.currency)}</table>
    <table style="width:100%;margin-top:12px;border-top:1px solid #ddd;padding-top:8px">
      <tr><td>Subtotal</td><td style="text-align:right">${money(o.subtotal, o.currency)}</td></tr>
      <tr><td>Delivery</td><td style="text-align:right">${money(o.shipping_fee, o.currency)}</td></tr>
      <tr><td><b>Total (${o.currency})</b></td><td style="text-align:right"><b>${money(o.total, o.currency)}</b></td></tr>
    </table>
    <h3 style="margin:24px 0 4px">Delivering to</h3>
    <p style="margin:0;line-height:1.5">${esc(o.customer_name)}<br>${esc(o.address)}<br>${esc(o.city)}${
      o.state ? ", " + esc(o.state) : ""
    }<br>${esc(o.country)}<br>${esc(o.phone)}</p>
    <p style="color:#777;font-size:13px;margin-top:24px">Questions? Just reply to this email and quote ${esc(o.ref)}.</p>`);
}

function ownerHtml(o, items) {
  return wrap(`
    <h2 style="margin:0 0 8px">New paid order ${esc(o.ref)}</h2>
    ${o.needs_attention ? `<p style="background:#fff3cd;padding:10px"><b>Needs attention:</b> ${esc(o.needs_attention)}</p>` : ""}
    <p><b>${money(o.total, o.currency)}</b> (${o.currency}) · delivery ${money(o.shipping_fee, o.currency)}</p>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #ddd">${itemRows(items, o.currency)}</table>
    <h3 style="margin:20px 0 4px">Customer</h3>
    <p style="margin:0;line-height:1.5">${esc(o.customer_name)}<br>${esc(o.email)}<br>${esc(o.phone)}<br>${esc(o.address)}, ${esc(o.city)}${
      o.state ? ", " + esc(o.state) : ""
    }, ${esc(o.country)}</p>`);
}

// Sends the customer + owner emails once per order, even if called twice.
export async function sendOrderEmails(orderId) {
  const { rows: [o] } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  if (!o) return;
  const { rows: items } = await pool.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [orderId]);

  if (!o.customer_email_sent_at) {
    try {
      await sendMail({ to: o.email, subject: `Your ZUEZ order ${o.ref}`, html: customerHtml(o, items) });
      await pool.query("UPDATE orders SET customer_email_sent_at = now() WHERE id = $1", [orderId]);
    } catch (e) {
      console.error("customer email failed:", e.message);
    }
  }

  if (!o.owner_email_sent_at && process.env.OWNER_EMAIL) {
    try {
      await sendMail({
        to: process.env.OWNER_EMAIL,
        subject: `${o.needs_attention ? "[CHECK] " : ""}New order ${o.ref} · ${money(o.total, o.currency)}`,
        html: ownerHtml(o, items),
      });
      await pool.query("UPDATE orders SET owner_email_sent_at = now() WHERE id = $1", [orderId]);
    } catch (e) {
      console.error("owner email failed:", e.message);
    }
  }
}
