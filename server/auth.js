import crypto from "node:crypto";
import stmts from "./db.js";

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const SESSION_COOKIE = "vg_session";

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 128 * N * r needs ~32MB + overhead

// ---------------- Passwords (scrypt, memory-hard, no native deps) ----------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltHex, hashHex] = stored.split("$");
    if (algo !== "scrypt") return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_MAXMEM,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const DUMMY_HASH = hashPassword("dummy-password-to-equalize-timing");

// Runs scrypt regardless of whether the account exists, so login timing
// doesn't reveal if an email is registered.
export function constantTimeVerify(password, stored) {
  return verifyPassword(password, stored || DUMMY_HASH);
}

// ---------------- Sessions ----------------

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function isValidPassword(password) {
  return typeof password === "string" && password.length >= 10 && password.length <= 128;
}

export function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, createdAt: u.created_at };
}

export async function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  await stmts.insertSession({
    tokenHash: sha256(token),
    userId,
    csrf,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ip: req?.ip || "",
    userAgent: req?.headers?.["user-agent"] || "",
  });
  return { token, csrf };
}

export async function getSession(token) {
  if (!token) return null;
  const s = await stmts.findSession(sha256(token));
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    await stmts.deleteSession(s.token_hash);
    return null;
  }
  return s;
}

export async function destroySession(token) {
  if (token) await stmts.deleteSession(sha256(token));
}

// ---------------- Password reset tokens ----------------

export const RESET_TTL_MS = 30 * 60 * 1000;

export async function createPasswordReset(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  await stmts.deleteResetsForUser(userId);
  await stmts.insertReset(userId, sha256(token), now, now + RESET_TTL_MS);
  return token;
}

export async function getPasswordReset(token) {
  if (!token) return null;
  const row = await stmts.findReset(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await stmts.deleteReset(row.token_hash);
    return null;
  }
  return row;
}

export async function deletePasswordReset(token) {
  if (token) await stmts.deleteReset(sha256(token));
}

export async function revokeAllSessions(userId) {
  await stmts.deleteAllSessions(userId);
}

export function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

// ---------------- HTTP middleware ----------------

export function parseCookies(header = "") {
  const out = {};
  for (const pair of header.split(";")) {
    const i = pair.indexOf("=");
    if (i > 0) {
      try {
        out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
      } catch {
        /* ignore malformed cookie */
      }
    }
  }
  return out;
}

export async function attachUser(req, _res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const session = await getSession(cookies[SESSION_COOKIE]);
    if (session) {
      req.userId = session.user_id;
      req.session = session;
      req.csrf = session.csrf;
    }
  } catch (err) {
    return next(err);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.userId) {
    return res.status(401).json({ error: "Authentication required." });
  }
  next();
}

const safeEqual = (a, b) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

export function csrfGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const provided = req.get("X-CSRF-Token") || "";
  if (req.session && provided && safeEqual(provided, req.session.csrf)) return next();
  return res.status(403).json({ error: "Invalid CSRF token." });
}

export function originGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("Origin");
  if (!origin) return next();
  if (!allowedOrigins().includes(origin)) {
    return res.status(403).json({ error: "Cross-origin request blocked." });
  }
  next();
}

export function allowedOrigins() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
  ];
}

// ---------------- Rate limiting ----------------

const buckets = new Map();

export function rateLimit({ windowMs, max, keyBy }) {
  return (req, res, next) => {
    const key = `${req.ip}:${keyBy(req)}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      res.setHeader("Retry-After", Math.ceil((b.reset - now) / 1000));
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.reset < now) buckets.delete(k);
  }
}, 60_000).unref();

// ---------------- Security headers ----------------

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https://basemaps.cartocdn.com https://*.tile.openstreetmap.org; " +
      "font-src 'self' data: https://basemaps.cartocdn.com; " +
      "connect-src 'self' ws: wss: https://basemaps.cartocdn.com https://router.project-osrm.org https://*.tile.openstreetmap.org; " +
      "worker-src 'self' blob:; " +
      "child-src 'self' blob:; " +
      "frame-ancestors 'none'"
  );
  const secure = process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production";
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

export function sessionCleanupLoop() {
  setInterval(() => {
    stmts.deleteExpiredSessions(Date.now()).catch(() => {
      /* ignore */
    });
  }, 60 * 60 * 1000).unref();
}
