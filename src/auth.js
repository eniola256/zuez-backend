// Owner login. One password (ADMIN_PASSWORD on Render), no user accounts.
// Logging in gives a signed token that expires after 12 hours. The website keeps
// it in sessionStorage and sends it as "Authorization: Bearer <token>".
import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 12 * 60 * 60 * 1000;

const secret = () => process.env.ADMIN_TOKEN_SECRET || "";
const b64 = (s) => Buffer.from(s).toString("base64url");
const mac = (payload) => createHmac("sha256", secret()).update(payload).digest("base64url");

export const adminEnabled = () => !!process.env.ADMIN_PASSWORD && secret().length >= 16;

function same(a, b) {
  // hash both first so the two buffers are always the same length
  const ha = createHmac("sha256", "cmp").update(String(a)).digest();
  const hb = createHmac("sha256", "cmp").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export const checkPassword = (given) => adminEnabled() && same(given ?? "", process.env.ADMIN_PASSWORD);

export function makeToken() {
  const payload = b64(JSON.stringify({ role: "owner", exp: Date.now() + TTL_MS }));
  return `${payload}.${mac(payload)}`;
}

export function verifyToken(token) {
  if (!adminEnabled() || typeof token !== "string") return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
  } catch {
    return false;
  }
}

export function requireAdmin(req, res, next) {
  if (!adminEnabled()) return res.status(503).json({ error: "Admin isn't set up on the server yet." });
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!verifyToken(token)) return res.status(401).json({ error: "Please log in again." });
  next();
}
