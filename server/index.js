import express from "express";
import http from "http";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import stmts, { prisma } from "./db.js";
import {
  attachUser,
  requireAuth,
  requireAdmin,
  csrfGuard,
  originGuard,
  rateLimit,
  securityHeaders,
  createSession,
  getSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
  hashPassword,
  constantTimeVerify,
  normalizeEmail,
  isValidEmail,
  isValidPassword,
  publicUser,
  sessionCleanupLoop,
  allowedOrigins,
  createPasswordReset,
  getPasswordReset,
  deletePasswordReset,
  revokeAllSessions,
} from "./auth.js";
import { initMailer, isMailConfigured, sendEmail } from "./mailer.js";
import {
  createNotification,
  markNotificationRead,
  markAllNotificationsRead,
  listNotificationsPage,
  countUnreadNotifications,
  deleteOldNotifications,
  NOTIFICATION_PAGE_MAX,
  NOTIFICATION_TYPES,
} from "./notifications.js";
import {
  REQUEST_TTL_MS,
  TERMINAL_STATES,
  LEGACY_ENDED,
  transitionBooking,
  cancelBookingForActor,
} from "./booking-machine.mjs";
import {
  getDashboardStats,
  listUsersPage,
  getUserDetail,
  setUserStatus,
  setUserRole,
  listProvidersPage,
  getProviderDetail,
  setProviderVerified,
  setProviderListed,
  setProviderActive,
  listBookingsPage,
  getBookingDetail,
  listPaymentsPage,
  listReviewsPage,
  setReviewHidden,
  createReport,
  listReportsPage,
  updateReportStatus,
  createAuditLog,
  listAuditLogsPage,
} from "./admin.js";

const PORT = process.env.PORT || 4001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");
const SERVE_STATIC = process.env.SERVE_STATIC === "1" || process.env.NODE_ENV === "production";
const REQUEST_SWEEP_MS = Number(process.env.REQUEST_SWEEP_MS) || 60_000;
const PLATFORM_FEE_RATE = Number(process.env.PLATFORM_FEE_RATE) || 0.10;

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: allowedOrigins(), credentials: true }));
app.use(securityHeaders);
// Default to a strict 10kb body cap everywhere except POST /api/profile,
// which legitimately carries base64 avatars (up to 250 KB → ~333 KB body).
const jsonSmall = express.json({ limit: "10kb" });
const jsonAvatar = express.json({ limit: "512kb" });
app.use((req, res, next) => {
  const parser = req.method === "POST" && req.path === "/api/profile" ? jsonAvatar : jsonSmall;
  parser(req, res, next);
});
app.use(attachUser);
app.use(originGuard);

// Express 4 does not catch rejected promises from async handlers, so route
// them through here and let the error middleware turn them into a 500 JSON
// response instead of an unhandled rejection.
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins(), credentials: true, methods: ["GET", "POST"] },
});

const MAX_PATH = 2000;
const ARRIVE_THRESHOLD_M = Number(process.env.ARRIVE_THRESHOLD_M) || 80;
const TRACK_CODE_TTL_MS = (Number(process.env.TRACK_CODE_TTL_MIN) || 10) * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const AVATAR_MAX_BYTES = 250 * 1024;
const OSRM_BASE = process.env.OSRM_SERVER || "https://router.project-osrm.org";
const routeCache = new Map();
const ROUTE_CACHE_MS = 10 * 60 * 1000;
// bookingId -> Set<socket.id> of live "person" sockets sharing location
const personSockets = new Map();

// ---------------- Trackable profile helpers ----------------

function generateCode() {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function fromProfileRow(row) {
  if (!row) return null;
  return { ...row, skills: JSON.parse(row.skills || "[]") };
}

async function rotateCodeForProfile(p) {
  const code = generateCode();
  const expiresAt = Date.now() + TRACK_CODE_TTL_MS;
  await stmts.updateProfileCode(code, expiresAt, p.id);
  p.track_code = code;
  p.code_expires_at = expiresAt;
  return p;
}

async function ensureFreshCode(p) {
  if (p.code_expires_at <= Date.now()) await rotateCodeForProfile(p);
  return p;
}

function parseServiceArea(p) {
  if (!p?.service_area) return null;
  try {
    const v = JSON.parse(p.service_area);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function publicProfile(p) {
  return {
    id: p.id,
    name: p.name,
    bio: p.bio,
    skills: p.skills || [],
    avatar: p.avatar,
    phone: p.phone,
    city: p.city,
    listed: !!p.listed,
    createdAt: p.created_at,
    // Marketplace aggregates (already public on the Profile row): aggregate
    // rating, review count, and the JSON service area.
    rating: p.rating_avg ?? null,
    ratingCount: p.rating_count ?? 0,
    serviceArea: parseServiceArea(p),
  };
}

function ownProfile(p) {
  return {
    ...publicProfile(p),
    isActive: !!p.is_active,
    trackCode: p.track_code,
    codeExpiresAt: p.code_expires_at,
  };
}

function validAvatar(dataUrl) {
  if (dataUrl == null || dataUrl === "") return { ok: true, value: null };
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return { ok: false, error: "Avatar must be a PNG, JPEG or WebP image." };
  try {
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > AVATAR_MAX_BYTES) {
      return { ok: false, error: "Avatar image is too large (max 250 KB)." };
    }
    return { ok: true, value: dataUrl };
  } catch {
    return { ok: false, error: "Avatar is not a valid image." };
  }
}

function sanitizeProfileInput(body) {
  const name = String(body?.name || "").trim().slice(0, 60);
  if (!name) return { error: "A display name is required." };
  const bio = String(body?.bio || "").trim().slice(0, 500);
  const phone = String(body?.phone || "").trim().slice(0, 30);
  const city = String(body?.city || "").trim().slice(0, 60);

  let skills = body?.skills;
  if (typeof skills === "string") {
    skills = skills.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(skills)) skills = [];
  skills = skills.map((s) => String(s).slice(0, 30)).filter(Boolean).slice(0, 12);

  const listed = body?.listed !== false && body?.listed !== 0;

  const avatar = validAvatar(body?.avatar);
  if (!avatar.ok) return { error: avatar.error };

  return {
    value: { name, bio, phone, city, skills, listed, avatar: avatar.value },
  };
}

// ---------------- Availability ----------------

// Weekly availability is expressed in the provider's IANA timezone. Windows are
// wall-clock values: dow uses JS Date#getDay() semantics (0=Sunday..6=Saturday)
// and start/end are minutes since midnight. A profile without a timezone is
// interpreted as UTC.

const AVAILABILITY_MAX_ROWS = 28;

// IANA timezone ids pass Intl validation; anything else is rejected.
function isValidTimezone(tz) {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Local weekday (0=Sun..6=Sat) and minutes-since-midnight in a timezone.
function nowInTimezone(tz, now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return { dow, minutes };
}

// Is `now` inside one of the provider's active windows? Returns null when the
// provider has no availability configured (callers preserve legacy behaviour).
function availableNow(activeWindows, timezone, now = Date.now()) {
  if (!activeWindows.length) return null;
  const { dow, minutes } = nowInTimezone(timezone || "UTC", now);
  return activeWindows.some((w) => w.dow === dow && w.start_min <= minutes && minutes < w.end_min);
}

function toPublicWindow(a) {
  return { dow: a.dow, startMin: a.start_min, endMin: a.end_min };
}

// Validate/normalize a full availability payload (timezone + replace-all
// window list). Runs entirely server-side — client data is never trusted.
function sanitizeAvailabilityInput(body) {
  let timezone = null;
  if (body?.timezone != null && String(body.timezone).trim() !== "") {
    timezone = String(body.timezone).trim();
    if (!isValidTimezone(timezone)) {
      return { error: "Pick a valid timezone (e.g. Africa/Lagos)." };
    }
  }

  let rows = body?.availability;
  if (!Array.isArray(rows)) rows = [];
  if (rows.length > AVAILABILITY_MAX_ROWS) {
    return { error: `At most ${AVAILABILITY_MAX_ROWS} windows are allowed.` };
  }

  const out = [];
  for (const raw of rows) {
    const dow = Number(raw?.dow);
    const startMin = Number(raw?.startMin ?? raw?.start_min);
    const endMin = Number(raw?.endMin ?? raw?.end_min);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      return { error: "Each window needs a day between 0 (Sunday) and 6 (Saturday)." };
    }
    if (
      !Number.isInteger(startMin) || !Number.isInteger(endMin) ||
      startMin < 0 || startMin >= 1440 || endMin <= startMin || endMin > 1440
    ) {
      return { error: "Each window needs a start and end time where the end is after the start." };
    }
    out.push({ dow, start_min: startMin, end_min: endMin, active: raw?.active !== false });
  }

  // Reject overlapping ACTIVE windows on the same day. Inactive rows never
  // conflict; the DB CHECKs still guard every row independently.
  const sorted = [...out].sort((a, b) => a.dow - b.dow || a.start_min - b.start_min);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.dow === cur.dow && prev.active && cur.active && cur.start_min < prev.end_min) {
      return { error: "Availability windows on the same day cannot overlap." };
    }
  }

  return { value: { timezone, availability: out } };
}

// ---------------- Service validation ----------------

const PRICE_UNITS = new Set(["flat", "per_hour", "per_km"]);
// Small ISO-4217 set of currencies providers may price services in.
const SUPPORTED_CURRENCIES = new Set([
  "GHS", "USD", "EUR", "GBP", "NGN", "KES", "ZAR", "TZS", "UGX", "XOF", "XAF",
  "CAD", "AUD", "JPY", "CNY", "INR",
]);
const SERVICE_TITLE_MAX = 80;
const SERVICE_DESC_MAX = 1000;
const SERVICE_CATEGORY_MAX = 60;
const SERVICE_DURATION_MAX_MIN = 10080; // 7 days, in minutes
const PRICE_MAX = 2147483647; // Postgres int4 ceiling, matches the schema column

// Validate/normalize a service payload. With { partial: true } (PUT) only the
// fields actually supplied are validated; omitted fields are untouched. Text is
// trimmed; price/unit/duration/active/currency are validated strictly.
function sanitizeServiceInput(body, { partial = false } = {}) {
  const out = {};
  const has = (key) => body != null && body[key] !== undefined && body[key] !== null;
  const hasEither = (...keys) => keys.some(has);

  if (!partial || has("title")) {
    const title = String(body?.title || "").trim();
    if (!title) return { error: "A service title is required." };
    if (title.length > SERVICE_TITLE_MAX) {
      return { error: `Service title must be at most ${SERVICE_TITLE_MAX} characters.` };
    }
    out.title = title;
  }

  if (!partial || has("description")) {
    const description = String(body?.description || "").trim();
    if (description.length > SERVICE_DESC_MAX) {
      return { error: `Description must be at most ${SERVICE_DESC_MAX} characters.` };
    }
    out.description = description;
  }

  if (!partial || has("category")) {
    const category = String(body?.category || "").trim() || "other";
    if (category.length > SERVICE_CATEGORY_MAX) {
      return { error: `Category must be at most ${SERVICE_CATEGORY_MAX} characters.` };
    }
    out.category = category;
  }

  if (!partial || hasEither("priceAmount", "price_amount")) {
    const raw = body?.priceAmount ?? body?.price_amount;
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      return { error: "Price must be a whole number of minor units." };
    }
    if (raw < 0 || raw > PRICE_MAX) {
      return { error: "Price must be a non-negative integer." };
    }
    out.price_amount = raw;
  }

  if (!partial || hasEither("priceCurrency", "price_currency")) {
    const currency = String((body?.priceCurrency ?? body?.price_currency) || "").trim().toUpperCase();
    if (!SUPPORTED_CURRENCIES.has(currency)) {
      return { error: "Unsupported currency." };
    }
    out.price_currency = currency;
  }

  if (!partial || hasEither("priceUnit", "price_unit")) {
    const unit = String((body?.priceUnit ?? body?.price_unit) || "").trim().toLowerCase();
    if (!PRICE_UNITS.has(unit)) {
      return { error: "price_unit must be one of: flat, per_hour, per_km." };
    }
    out.price_unit = unit;
  }

  if (!partial || hasEither("durationMin", "duration_min")) {
    const raw = body?.durationMin ?? body?.duration_min;
    if (raw == null || raw === "") {
      out.duration_min = null;
    } else if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > SERVICE_DURATION_MAX_MIN) {
      return { error: `Duration must be a whole number of minutes between 1 and ${SERVICE_DURATION_MAX_MIN}.` };
    } else {
      out.duration_min = raw;
    }
  }

  if (has("active")) {
    if (typeof body.active !== "boolean") {
      return { error: "active must be true or false." };
    }
    out.active = body.active;
  }

  return { value: out };
}

// ---------------- Booking helpers ----------------

function pageParams(req, maxLimit = 100) {
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), maxLimit)
      : maxLimit;
  const offset =
    Number.isFinite(rawOffset) && rawOffset >= 1 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

function makeId() {
  return crypto.randomBytes(6).toString("hex");
}

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

async function createBooking(userId, data, opts = {}) {
  const now = Date.now();
  const marketplace = !!opts.marketplace;
  const booking = {
    id: makeId(),
    user_id: userId,
    share_token: crypto.randomBytes(24).toString("hex"),
    code: makeCode(),
    person_name: String(data.personName || "").trim() || "Unknown person",
    phone: String(data.phone || "").trim(),
    note: String(data.note || "").trim(),
    pickup: data.pickup || null,
    destination: data.destination || null,
    // Marketplace requests start as REQUESTED and wait for the provider to act;
    // legacy tracking bookings keep their historical "pending" lifecycle.
    status: marketplace ? "REQUESTED" : "pending",
    created_at: now,
    person_online: 0,
    location: null,
    path: [],
    profile_id: marketplace ? (opts.profileId ?? null) : null,
    service_id: marketplace ? (opts.serviceId ?? null) : null,
    price_amount: marketplace ? (opts.priceAmount ?? null) : null,
    price_currency: marketplace ? (opts.priceCurrency || "GHS") : "GHS",
    expires_at: marketplace ? now + REQUEST_TTL_MS : null,
  };
  await stmts.insertBooking(
    booking.id,
    booking.user_id,
    booking.share_token,
    booking.code,
    booking.person_name,
    booking.phone,
    booking.note,
    booking.pickup ? JSON.stringify(booking.pickup) : null,
    booking.destination ? JSON.stringify(booking.destination) : null,
    booking.status,
    booking.created_at,
    booking.person_online,
    null,
    JSON.stringify([]),
    {
      profileId: booking.profile_id,
      serviceId: booking.service_id,
      priceAmount: booking.price_amount,
      priceCurrency: booking.price_currency,
      expiresAt: booking.expires_at,
    }
  );
  return booking;
}

function fromRow(row) {
  if (!row) return null;
  return {
    ...row,
    pickup: row.pickup ? JSON.parse(row.pickup) : null,
    destination: row.destination ? JSON.parse(row.destination) : null,
    location: row.location ? JSON.parse(row.location) : null,
    path: row.path ? JSON.parse(row.path) : [],
    person_online: !!row.person_online,
  };
}

async function saveBooking(b) {
  await stmts.updateBooking(
    b.person_name,
    b.phone,
    b.note,
    b.pickup ? JSON.stringify(b.pickup) : null,
    b.destination ? JSON.stringify(b.destination) : null,
    b.status,
    b.person_online ? 1 : 0,
    b.location ? JSON.stringify(b.location) : null,
    JSON.stringify(b.path),
    b.id
  );
}

function toPublic(b) {
  return {
    id: b.id,
    code: b.code,
    personName: b.person_name,
    phone: b.phone,
    pickup: b.pickup,
    destination: b.destination,
    note: b.note,
    status: b.status,
    createdAt: b.created_at,
    personOnline: b.person_online,
    location: b.location,
    path: b.path,
    shareToken: b.share_token,
    trackingLink: `/join/${b.id}?t=${b.share_token}`,
    profileId: b.profile_id,
    serviceId: b.service_id,
    service: b.service
      ? {
          id: b.service.id,
          title: b.service.title,
          category: b.service.category,
          description: b.service.description ?? "",
          priceUnit: b.service.price_unit ?? "flat",
        }
      : null,
    provider: b.profile ? { id: b.profile.id, name: b.profile.name } : null,
    priceAmount: b.price_amount,
    priceCurrency: b.price_currency,
    acceptedAt: b.accepted_at,
    startedAt: b.started_at,
    completedAt: b.completed_at,
    expiresAt: b.expires_at,
    reviewed: !!b.reviewed,
    paymentStatus: b.payment_status,
    paymentMethod: b.payment_method,
    paidAt: b.paid_at,
    platformFee: b.platform_fee,
  };
}

// Validate and sanitize an optional review comment. Returns
// { ok: true, value } with the cleaned string, or { ok: false, error }.
function sanitizeComment(input) {
  if (input == null) return { ok: true, value: "" };
  if (typeof input !== "string") {
    return { ok: false, error: "Comment must be text." };
  }
  // Drop control characters (keep tabs and newlines), replace tabs with a
  // space, then trim and collapse runs of spaces and blank lines.
  let text = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\t/g, " ")
    .trim();
  text = text.replace(/[ ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  if (text.length > 500) {
    return { ok: false, error: "Comment is too long (max 500 characters)." };
  }
  return { ok: true, value: text };
}

function toPublicReview(r) {
  return {
    id: r.id,
    rating: r.rating,
    comment: r.comment,
    createdAt: r.created_at,
    reviewer: r.user ? { id: r.user.id, name: r.user.name } : null,
  };
}

function toProviderBooking(b) {
  return {
    ...toPublic(b),
    customer: b.user ? { id: b.user.id, name: b.user.name } : null,
  };
}

function toPublicService(s) {
  return {
    id: s.id,
    profileId: s.profile_id,
    title: s.title,
    description: s.description,
    category: s.category,
    priceAmount: s.price_amount,
    priceCurrency: s.price_currency,
    priceUnit: s.price_unit,
    durationMin: s.duration_min,
    active: !!s.active,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function toPublicServiceListing(s) {
  return {
    ...toPublicService(s),
    provider: {
      id: s.profile_id,
      name: s.profile_name,
      ratingAvg: s.rating_avg,
      ratingCount: s.rating_count,
    },
  };
}

// ---------------- Messaging ----------------

const MESSAGE_BODY_MAX = 2000;
const MESSAGE_PAGE_MAX = 80;

function sanitizeMessageBody(input) {
  if (typeof input !== "string") return { ok: false, error: "Message must be text." };
  let text = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\t/g, " ")
    .trim();
  text = text.replace(/[ ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  if (!text) return { ok: false, error: "Message cannot be empty." };
  if (text.length > MESSAGE_BODY_MAX) {
    return { ok: false, error: `Message is too long (max ${MESSAGE_BODY_MAX} characters).` };
  }
  return { ok: true, value: text };
}

// Verify that userId is the customer or provider for the booking.
// Returns the booking row (with profile relation) or null.
async function verifyBookingParticipant(bookingId, userId) {
  const b = fromRow(await stmts.findBookingById(bookingId));
  if (!b) return null;
  if (b.user_id === userId) return { booking: b, role: "customer" };
  if (b.profile_id != null) {
    const profile = fromProfileRow(await stmts.findProfileById(b.profile_id));
    if (profile && profile.user_id === userId) return { booking: b, role: "provider" };
  }
  return null;
}

// Nonce dedup: client-generated nonce prevents duplicate sends on retry.
const nonceDedup = new Map();
const NONCE_TTL_MS = 30_000;
function checkNonce(nonce) {
  if (!nonce || typeof nonce !== "string") return false;
  const now = Date.now();
  const prev = nonceDedup.get(nonce);
  if (prev && now - prev.ts < NONCE_TTL_MS) return prev.msg;
  nonceDedup.set(nonce, { ts: now });
  return null;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonceDedup) {
    if (now - v.ts >= NONCE_TTL_MS) nonceDedup.delete(k);
  }
}, 60_000).unref();

function toPublicMessage(m) {
  return {
    id: m.id,
    bookingId: m.booking_id,
    senderId: m.sender_id,
    body: m.body,
    createdAt: m.created_at,
    readAt: m.read_at,
    sender: m.sender ? { id: m.sender.id, name: m.sender.name } : null,
  };
}

function emitToProvider(booking, event, data) {
  if (!booking.profile_id) return;
  const profile ="profileCache" in booking ? booking._profileCache : null;
  if (profile) {
    io.to(`user:${profile.user_id}`).emit(event, data);
    return;
  }
  stmts.findProfileById(booking.profile_id).then((p) => {
    if (p) io.to(`user:${p.user_id}`).emit(event, data);
  }).catch(() => {});
}

async function emitMessageToParticipants(booking, event, data) {
  io.to(`user:${booking.user_id}`).emit(event, data);
  if (booking.profile_id) {
    try {
      const profile = await stmts.findProfileById(booking.profile_id);
      if (profile) io.to(`user:${profile.user_id}`).emit(event, data);
    } catch { /* ignore */ }
  }
}

function broadcast(booking) {
  const pub = toPublic(booking);
  io.to(`watch:${booking.id}`).emit("booking:update", pub);
  io.to(`user:${booking.user_id}`).emit("booking:update", pub);
}

function emitToOwner(event, booking) {
  io.to(`user:${booking.user_id}`).emit(event, toPublic(booking));
}

// Create a notification and push it to the user's socket in real time.
async function notifyAndEmit(userId, { type, title, body, link, refType, refId }) {
  try {
    const n = await createNotification(userId, { type, title, body, link, refType, refId });
    io.to(`user:${userId}`).emit("notification:new", n);
    return n;
  } catch (err) {
    console.error("notification failed:", err);
    return null;
  }
}

function ownsBooking(b, userId) {
  return b && b.user_id === userId;
}

function haversine(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------- HTTP API ----------------

app.get("/health", (_req, res) => res.json({ ok: true }));

// Google-Maps-style road routing via OSRM (free, no API key). Cached server-side.
app.get(
  "/api/route",
  rateLimit({ windowMs: 60 * 1000, max: 60, keyBy: (req) => `route:${req.ip}` }),
  async (req, res) => {
  const { from, to } = req.query;
  const parse = (s) => {
    if (!s) return null;
    const [lat, lng] = String(s).split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return res.status(400).json({ error: "from and to are required as lat,lng" });

  const key = `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < ROUTE_CACHE_MS) return res.json(hit.data);

  try {
    const url = `${OSRM_BASE}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=false`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const json = await resp.json();
    if (json.code !== "Ok" || !json.routes?.[0]) return res.status(502).json({ error: "No route found" });
    const route = json.routes[0];
    const data = {
      distanceKm: route.distance / 1000,
      durationSec: route.duration,
      coordinates: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
    };
    if (routeCache.size > 500) routeCache.clear();
    routeCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch {
    res.status(502).json({ error: "Routing service unavailable" });
  }
});

app.get("/api/auth/me", asyncHandler(async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: "Authentication required." });
  const user = await stmts.findUserById(req.userId);
  if (!user) return res.status(401).json({ error: "Authentication required." });
  res.json({ user: publicUser(user), csrf: req.session.csrf });
}));

app.post(
  "/api/auth/register",
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyBy: (req) => `register:${req.ip}` }),
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 60);
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!name) return res.status(400).json({ error: "Name is required." });
    if (!isValidEmail(email)) return res.status(400).json({ error: "A valid email is required." });
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: "Password must be 10–128 characters." });
    }
    const existing = await stmts.findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    let user;
    try {
      user = await stmts.insertUser(name, email, hashPassword(password), Date.now());
    } catch (err) {
      // Unique-email race: another request created the account in between.
      if (err?.code === "P2002") {
        return res.status(409).json({ error: "An account with that email already exists." });
      }
      throw err;
    }
    const session = await createSession(user.id, req);
    setSessionCookie(res, session.token);
    res.status(201).json({ user: publicUser(user), csrf: session.csrf });
  })
);

app.post(
  "/api/auth/login",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyBy: (req) => `login:${req.ip}:${normalizeEmail(req.body?.email)}` }),
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const user = await stmts.findUserByEmail(email);

    if (user && user.locked_until && user.locked_until > Date.now()) {
      const retry = Math.ceil((user.locked_until - Date.now()) / 1000);
      res.setHeader("Retry-After", retry);
      return res.status(423).json({ error: `Account locked. Try again in ${Math.ceil(retry / 60)} min.` });
    }

    const valid = user ? constantTimeVerify(password, user.password_hash) : constantTimeVerify(password);
    if (!user || !valid) {
      if (user) {
        const attempts = user.failed_attempts + 1;
        const lockedUntil = attempts >= 10 ? Date.now() + 15 * 60 * 1000 : null;
        await stmts.updateUserAttempts(attempts, lockedUntil, user.id);
      }
      return res.status(401).json({ error: "Invalid email or password." });
    }

    await stmts.updateUserAttempts(0, null, user.id);

    if (user.status === "suspended") {
      return res.status(403).json({ error: "This account has been suspended. Contact support." });
    }

    const session = await createSession(user.id, req);
    setSessionCookie(res, session.token);
    res.json({ user: publicUser(user), csrf: session.csrf });
  })
);

app.post("/api/auth/logout", asyncHandler(async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  await destroySession(cookies[SESSION_COOKIE]);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// Marketplace role switch. The client needs to know the caller's role for
// role-aware navigation, and users must be able to opt in to providing
// ("provider") or both ("both") without a manual database edit. The users.role
// CHECK constraint is the final gate — anything not in the whitelist here is
// rejected before it reaches the database.
const MARKETPLACE_ROLES = new Set(["customer", "provider", "both"]);
app.post(
  "/api/role",
  requireAuth,
  csrfGuard,
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyBy: (req) => `role:${req.userId}` }),
  asyncHandler(async (req, res) => {
    const role = String(req.body?.role || "").trim().toLowerCase();
    if (!MARKETPLACE_ROLES.has(role)) {
      return res.status(422).json({ error: "Role must be one of: customer, provider, both." });
    }
    const user = await stmts.updateUserRole(role, req.userId);
    res.json({ user: publicUser(user), csrf: req.session.csrf });
  })
);

app.post(
  "/api/auth/reset/request",
  rateLimit({ windowMs: 60 * 60 * 1000, max: 3, keyBy: (req) => `reset:${req.ip}:${normalizeEmail(req.body?.email)}` }),
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const user = isValidEmail(email) ? await stmts.findUserByEmail(email) : null;

    let devLink = null;
    if (user) {
      const token = await createPasswordReset(user.id);
      const origin = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
      const link = `${origin}/reset?token=${token}`;
      await sendEmail({
        to: user.email,
        subject: "Reset your Bookking password",
        text: `Someone requested a password reset for your Bookking account.\n\nClick the link below to choose a new password. This link expires in 30 minutes.\n\n${link}\n\nIf you didn't request this, you can safely ignore this email — your password won't change.`,
      });
      if (process.env.NODE_ENV !== "production" && !isMailConfigured()) {
        devLink = link;
      }
    }

    res.json({
      ok: true,
      message: "If an account exists for that email, a reset link was sent.",
      ...(devLink ? { devLink } : {}),
    });
  })
);

app.post(
  "/api/auth/reset/confirm",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyBy: (req) => `resetconfirm:${req.ip}` }),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Invalid or expired reset link." });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: "Password must be 10–128 characters." });
    }
    const reset = await getPasswordReset(token);
    if (!reset) {
      return res.status(400).json({ error: "Invalid or expired reset link." });
    }
    const user = await stmts.findUserById(reset.user_id);
    if (!user) {
      return res.status(400).json({ error: "Invalid or expired reset link." });
    }

    await stmts.updateUserPassword(hashPassword(password), user.id);
    await deletePasswordReset(token);
    await revokeAllSessions(user.id);

    const session = await createSession(user.id, req);
    setSessionCookie(res, session.token);
    res.json({ user: publicUser(user), csrf: session.csrf });
  })
);

app.get("/api/bookings", requireAuth, asyncHandler(async (req, res) => {
  const { limit, offset } = pageParams(req);
  const rows = await stmts.listBookingsByUserPage(req.userId, limit, offset);
  res.json(rows.map((r) => toPublic(fromRow(r))));
}));

app.post("/api/bookings", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const { personName, phone, note, pickup, destination, profileId, serviceId } = req.body || {};
  if (!personName || typeof personName !== "string") {
    return res.status(400).json({ error: "Person's name is required." });
  }
  if (!pickup || !destination || !pickup.lat || !destination.lat) {
    return res.status(400).json({ error: "Pickup and destination are required." });
  }

  if (profileId != null || serviceId != null) {
    // Marketplace request: the customer requests a provider's service. The
    // booking starts as REQUESTED and only the provider can accept it.
    // The provider, service, and price are all resolved server-side from the
    // database — any client-supplied price is ignored.
    let service = null;
    if (serviceId != null) {
      const sid = Number(serviceId);
      if (!Number.isInteger(sid)) {
        return res.status(400).json({ error: "Service not available from this provider." });
      }
      service = await stmts.findServiceById(sid);
      if (!service || !service.active) {
        return res.status(400).json({ error: "Service not available from this provider." });
      }
    }
    const pid = service ? service.profile_id : Number(profileId);
    if (!Number.isInteger(pid)) {
      return res.status(404).json({ error: "Provider profile not found." });
    }
    const profile = fromProfileRow(await stmts.findProfileById(pid));
    if (!profile || !profile.is_active || !profile.listed) {
      return res.status(404).json({ error: "Provider profile not found." });
    }
    // If the client named a profile too, the service must belong to it.
    if (service && profileId != null && Number(profileId) !== profile.id) {
      return res.status(400).json({ error: "Service not available from this provider." });
    }
    // Booking gate: when the provider has configured availability, requests
    // are only accepted while a window is active. Providers without any
    // availability rows keep the legacy behaviour (no gate).
    const activeWindows = await stmts.listActiveAvailability(profile.id);
    if (activeWindows.length > 0 && !availableNow(activeWindows, profile.timezone)) {
      return res.status(409).json({ error: `${profile.name} is not available right now.` });
    }
    try {
      const booking = await createBooking(req.userId, { personName, phone, note, pickup, destination }, {
        marketplace: true,
        profileId: profile.id,
        serviceId: service?.id ?? null,
        priceAmount: service ? service.price_amount : null,
        priceCurrency: service?.price_currency || "GHS",
      });
      const fresh = fromRow(await stmts.findBookingById(booking.id));
      emitToOwner("booking:created", fresh);
      const svcTitle = service?.title || "Service request";
      await notifyAndEmit(profile.user_id, {
        type: NOTIFICATION_TYPES.BOOKING_REQUEST_RECEIVED,
        title: "New request",
        body: `${personName} requested ${svcTitle}`,
        link: `/provider/requests/${fresh.id}`,
        refType: "booking",
        refId: fresh.id,
      });
      res.status(201).json(toPublic(fresh));
    } catch (err) {
      if (err?.code === "P2002") {
        return res.status(409).json({ error: "You already have an active request with this provider." });
      }
      throw err;
    }
    return;
  }

  const booking = await createBooking(req.userId, { personName, phone, note, pickup, destination });
  emitToOwner("booking:created", booking);
  res.status(201).json(toPublic(booking));
}));

app.get("/api/bookings/:id", requireAuth, asyncHandler(async (req, res) => {
  const b = fromRow(await stmts.findBookingByUser(req.params.id, req.userId));
  if (!b) return res.status(404).json({ error: "Booking not found." });
  res.json(toPublic(b));
}));

app.post("/api/bookings/:id/points", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const b = fromRow(await stmts.findBookingByUser(req.params.id, req.userId));
  if (!b) return res.status(404).json({ error: "Booking not found." });
  const { pickup, destination } = req.body || {};
  if (!pickup || !destination || !pickup.lat || !destination.lat) {
    return res.status(400).json({ error: "Pickup and destination are required." });
  }
  b.pickup = pickup;
  b.destination = destination;
  await saveBooking(b);
  broadcast(b);
  res.json(toPublic(b));
}));

// ---------------- Marketplace booking lifecycle ----------------

// Provider-facing list of bookings assigned to the caller's Profile.
app.get("/api/provider/bookings", requireAuth, asyncHandler(async (req, res) => {
  const user = await stmts.findUserById(req.userId);
  if (!user) return res.status(401).json({ error: "Authentication required." });
  if (user.role !== "provider" && user.role !== "both") {
    return res.status(403).json({ error: "Provider authorization required." });
  }
  const profile = fromProfileRow(await stmts.findProfileByUser(req.userId));
  if (!profile) return res.status(403).json({ error: "No provider profile." });
  const { limit, offset } = pageParams(req);
  const rows = await stmts.listBookingsByProfile(profile.id, limit, offset);
  res.json(rows.map((r) => toProviderBooking(fromRow(r))));
}));

// Provider-facing single booking detail (by profile ownership).
app.get("/api/provider/bookings/:id", requireAuth, asyncHandler(async (req, res) => {
  const user = await stmts.findUserById(req.userId);
  if (!user) return res.status(401).json({ error: "Authentication required." });
  if (user.role !== "provider" && user.role !== "both") {
    return res.status(403).json({ error: "Provider authorization required." });
  }
  const profile = fromProfileRow(await stmts.findProfileByUser(req.userId));
  if (!profile) return res.status(403).json({ error: "No provider profile." });
  const b = fromRow(await stmts.findBookingById(req.params.id));
  if (!b || b.profile_id !== profile.id) {
    return res.status(404).json({ error: "Booking not found." });
  }
  res.json(toProviderBooking(b));
}));

// Provider lifecycle actions. Authorization is verified server-side: the user
// must have the provider role, own a Profile, and the booking must be assigned
// to that Profile. The transition itself is a DB-guarded conditional update.
function providerAction(action) {
  return asyncHandler(async (req, res) => {
    const user = await stmts.findUserById(req.userId);
    if (!user) return res.status(401).json({ error: "Authentication required." });
    if (user.role !== "provider" && user.role !== "both") {
      return res.status(403).json({ error: "Provider authorization required." });
    }
    const profile = fromProfileRow(await stmts.findProfileByUser(req.userId));
    if (!profile) return res.status(403).json({ error: "No provider profile." });
    if (action === "accept") {
      // Availability gate on acceptance: catching a request that was created
      // inside a window but accepted after it ended. Providers without
      // configured availability are unaffected. The state machine itself is
      // unchanged.
      const activeWindows = await stmts.listActiveAvailability(profile.id);
      if (activeWindows.length > 0 && !availableNow(activeWindows, profile.timezone)) {
        return res.status(409).json({ error: "You are not currently within your availability hours." });
      }
    }
    const r = await transitionBooking({
      actorKind: "provider",
      userId: req.userId,
      profileId: profile.id,
      bookingId: req.params.id,
      action,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const b = fromRow(r.booking);
    broadcast(b);
    const providerName = profile.name;
    const svcTitle = b.service?.title || "your service";
    const notifMap = {
      accept: { type: NOTIFICATION_TYPES.BOOKING_ACCEPTED, title: "Request accepted", body: `${providerName} accepted your request for ${svcTitle}` },
      reject: { type: NOTIFICATION_TYPES.BOOKING_REJECTED, title: "Request declined", body: `${providerName} declined your request for ${svcTitle}` },
      start: { type: NOTIFICATION_TYPES.BOOKING_EN_ROUTE, title: "Provider on the way", body: `${providerName} is heading to you` },
      arrive: { type: NOTIFICATION_TYPES.BOOKING_ARRIVED, title: "Provider arrived", body: `${providerName} has arrived` },
      begin: { type: NOTIFICATION_TYPES.BOOKING_SERVICE_STARTED, title: "Service started", body: `${providerName} has started the service` },
      complete: { type: NOTIFICATION_TYPES.BOOKING_COMPLETED, title: "Service completed", body: `${providerName} completed your service — leave a review!` },
    };
    const n = notifMap[action];
    if (n) {
      await notifyAndEmit(b.user_id, { ...n, link: `/requests/${b.id}`, refType: "booking", refId: b.id });
    }
    res.json(toPublic(b));
  });
}

for (const action of ["accept", "reject", "start", "arrive", "begin", "complete"]) {
  app.post(`/api/bookings/:id/${action}`, requireAuth, csrfGuard, providerAction(action));
}

// Cancel by the customer (own booking) or the assigned provider. Marketplace
// bookings follow the guarded transition rules; legacy tracking bookings keep
// their historical owner-cancel-anytime behavior.
app.post("/api/bookings/:id/cancel", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const r = await cancelBookingForActor(req.userId, req.params.id);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const b = fromRow(r.booking);
  io.to(`watch:${b.id}`).emit("booking:cancelled", toPublic(b));
  broadcast(b);
  const notifyUserId = b.user_id === req.userId
    ? (b.profile_id ? (await stmts.findProfileById(b.profile_id))?.user_id : null)
    : b.user_id;
  if (notifyUserId) {
    await notifyAndEmit(notifyUserId, {
      type: NOTIFICATION_TYPES.BOOKING_CANCELLED,
      title: "Booking cancelled",
      body: "A booking has been cancelled",
      link: `/requests/${b.id}`,
      refType: "booking",
      refId: b.id,
    });
  }
  res.json(toPublic(b));
}));

// Minimal server-side review: only the booking owner can review, only after the
// booking is COMPLETED, and only once (guarded by reviews.booking_id @unique).
// A provider can never review their own service: the reviewer must not own the
// Profile the booking is assigned to. Rating averages are recomputed inside a
// transaction that takes a FOR UPDATE lock on the profile row, so concurrent
// reviews of the same provider serialize and the aggregate stays exact.
app.post("/api/bookings/:id/review", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const b = fromRow(await stmts.findBookingByUser(req.params.id, req.userId));
  if (!b) return res.status(404).json({ error: "Booking not found." });
  if (b.status !== "COMPLETED") {
    return res.status(409).json({ error: "Bookings can only be reviewed after completion." });
  }
  if (b.reviewed) return res.status(409).json({ error: "This booking has already been reviewed." });
  if (!b.profile_id) return res.status(400).json({ error: "This booking has no provider to review." });
  const rawRating = req.body?.rating;
  if (typeof rawRating !== "number" || !Number.isInteger(rawRating) || rawRating < 1 || rawRating > 5) {
    return res.status(400).json({ error: "Rating must be an integer from 1 to 5." });
  }
  const rating = rawRating;
  const cleaned = sanitizeComment(req.body?.comment);
  if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });
  // Never allow a provider to review their own service (covers role "both"
  // users booking their own profile).
  const profile = fromProfileRow(await stmts.findProfileById(b.profile_id));
  if (!profile) return res.status(400).json({ error: "This booking has no provider to review." });
  if (profile.user_id === req.userId) {
    return res.status(409).json({ error: "You cannot review your own service." });
  }
  try {
    const review = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "profiles" WHERE id = ${b.profile_id} FOR UPDATE`;
      const created = await tx.review.create({
        data: {
          booking_id: b.id,
          profile_id: b.profile_id,
          user_id: req.userId,
          rating,
          comment: cleaned.value,
          created_at: BigInt(Date.now()),
        },
      });
      await tx.booking.update({ where: { id: b.id }, data: { reviewed: true } });
      const agg = await tx.review.aggregate({
        where: { profile_id: b.profile_id },
        _avg: { rating: true },
        _count: true,
      });
      await tx.profile.update({
        where: { id: b.profile_id },
        data: { rating_avg: agg._avg.rating ?? 0, rating_count: agg._count },
      });
      return created;
    });
    const profile = fromProfileRow(await stmts.findProfileById(b.profile_id));
    if (profile) {
      await notifyAndEmit(profile.user_id, {
        type: NOTIFICATION_TYPES.REVIEW_RECEIVED,
        title: "New review",
        body: `You received a ${rating}-star review`,
        link: "/provider",
        refType: "review",
        refId: review.id,
      });
    }
    res.status(201).json({ ok: true, reviewId: review.id });
  } catch (err) {
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "This booking has already been reviewed." });
    }
    throw err;
  }
}));

// Provider confirms they received payment directly from the customer (cash / MoMo / etc.).
// Only the booking's assigned provider can confirm; only COMPLETED marketplace bookings qualify.
const VALID_PAYMENT_METHODS = new Set(["cash", "momo", "bank_transfer", "other"]);
app.post("/api/bookings/:id/confirm-payment", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const b = fromRow(await stmts.findBookingById(req.params.id));
  if (!b) return res.status(404).json({ error: "Booking not found." });
  if (!b.profile_id) return res.status(400).json({ error: "This booking has no provider." });
  if (b.status !== "COMPLETED") {
    return res.status(409).json({ error: "Payment can only be confirmed after the service is completed." });
  }
  if (b.payment_status === "PAID") {
    return res.status(409).json({ error: "Payment has already been confirmed for this booking." });
  }
  const profile = fromProfileRow(await stmts.findProfileById(b.profile_id));
  if (!profile || profile.user_id !== req.userId) {
    return res.status(403).json({ error: "Only the assigned provider can confirm payment." });
  }
  const method = String(req.body?.method || "").trim().toLowerCase();
  if (!VALID_PAYMENT_METHODS.has(method)) {
    return res.status(400).json({ error: "Invalid payment method. Choose: cash, momo, bank_transfer, other." });
  }
  if (b.price_amount == null) {
    return res.status(400).json({ error: "This booking has no price set." });
  }
  const now = Date.now();
  const platformFee = Math.round(b.price_amount * PLATFORM_FEE_RATE);
  const updated = fromRow(await stmts.confirmBookingPayment(b.id, method, now, platformFee));
  broadcast(updated);
  await notifyAndEmit(b.user_id, {
    type: NOTIFICATION_TYPES.PAYMENT_CONFIRMED,
    title: "Payment confirmed",
    body: `Provider confirmed receipt of ${b.price_currency} ${((b.price_amount) / 100).toFixed(2)} for ${b.service?.title || "your service"}`,
    link: `/requests/${b.id}`,
    refType: "booking",
    refId: b.id,
  });
  res.json(toPublic(updated));
}));

// Provider earnings summary.
app.get("/api/provider/earnings", requireAuth, asyncHandler(async (req, res) => {
  const profile = fromProfileRow(await stmts.findProfileByUser(req.userId));
  if (!profile) return res.status(403).json({ error: "No provider profile." });
  const agg = await stmts.sumProviderEarningsPage(profile.id);
  const count = await stmts.countProviderEarningsPage(profile.id);
  const totalEarned = Number(agg._sum.price_amount ?? 0);
  const totalFees = Number(agg._sum.platform_fee ?? 0);
  res.json({
    totalEarned,
    totalFees,
    netEarned: totalEarned - totalFees,
    paidBookings: count,
    currency: "GHS",
  });
}));

app.get("/api/share/:id", asyncHandler(async (req, res) => {
  const b = fromRow(await stmts.findBookingById(req.params.id));
  if (!b || b.share_token !== (req.query.t || "")) {
    return res.status(404).json({ error: "Tracking link is invalid or expired." });
  }
  res.json({
    id: b.id,
    code: b.code,
    personName: b.person_name,
    destination: b.destination,
    status: b.status,
  });
}));

// ---------------- Trackable profiles ----------------

app.get("/api/profiles", requireAuth, asyncHandler(async (req, res) => {
  const { limit, offset } = pageParams(req);
  const rows = await stmts.listActiveProfilesPage(req.userId, limit, offset);
  const list = rows.map((r) => publicProfile(fromProfileRow(r)));
  const own = fromProfileRow(await stmts.findProfileByUser(req.userId));
  if (own && own.is_active && own.listed) {
    list.unshift({ ...publicProfile(own), isOwn: true });
  }
  res.json(list);
}));

app.get("/api/profiles/:id", requireAuth, asyncHandler(async (req, res) => {
  const pid = Number(req.params.id);
  if (!Number.isInteger(pid)) return res.status(404).json({ error: "Profile not found." });
  const p = fromProfileRow(await stmts.findProfileById(pid));
  if (!p || !p.is_active) return res.status(404).json({ error: "Profile not found." });
  const services = await stmts.listActiveServicesByProfile(p.id, 50, 0);
  const activeWindows = await stmts.listActiveAvailability(p.id);
  res.json({
    ...publicProfile(p),
    availability: {
      timezone: p.timezone ?? null,
      configured: activeWindows.length > 0,
      availableNow: availableNow(activeWindows, p.timezone),
      schedule: activeWindows.map(toPublicWindow),
    },
    services: services.map(toPublicService),
  });
}));

// Public listing of a provider's active services. The profile must be active
// and listed; inactive services are never exposed here.
app.get("/api/profiles/:id/services", asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Provider profile not found." });
  const p = fromProfileRow(await stmts.findProfileById(id));
  if (!p || !p.is_active || !p.listed) {
    return res.status(404).json({ error: "Provider profile not found." });
  }
  const { limit, offset } = pageParams(req);
  const rows = await stmts.listActiveServicesByProfile(p.id, limit, offset);
  res.json(rows.map(toPublicService));
}));

// Public listing of a provider's reviews (newest first), with the same
// aggregate rating/count the profile exposes. Only the reviewer's name and the
// comment text are returned — never emails or other private data.
app.get("/api/profiles/:id/reviews", requireAuth, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Provider profile not found." });
  const p = fromProfileRow(await stmts.findProfileById(id));
  if (!p || !p.is_active) {
    return res.status(404).json({ error: "Provider profile not found." });
  }
  const { limit, offset } = pageParams(req);
  const rows = await prisma.review.findMany({
    where: { profile_id: id },
    orderBy: { created_at: "desc" },
    take: limit,
    skip: offset,
    include: { user: { select: { id: true, name: true } } },
  });
  res.json({
    profileId: p.id,
    rating: p.rating_avg ?? null,
    ratingCount: p.rating_count ?? 0,
    reviews: rows.map((r) => toPublicReview({ ...r, created_at: Number(r.created_at) })),
  });
}));

// ---------------- Service management ----------------

// Shared ownership gate for service mutations: authenticated, provider role,
// and an owned Profile. profileId is always resolved from the session.
async function requireProviderProfile(req, res) {
  const user = await stmts.findUserById(req.userId);
  if (!user) {
    res.status(401).json({ error: "Authentication required." });
    return null;
  }
  if (user.role !== "provider" && user.role !== "both") {
    res.status(403).json({ error: "Provider authorization required." });
    return null;
  }
  const profile = fromProfileRow(await stmts.findProfileByUser(req.userId));
  if (!profile) {
    res.status(403).json({ error: "Create a provider profile before managing services." });
    return null;
  }
  return profile;
}

// Public search across active services of listed providers. Filters: category
// (exact), q (title/description text), area (provider city or service area),
// plus pagination via limit/offset. No authentication required and no private
// provider data is included.
app.get("/api/services", asyncHandler(async (req, res) => {
  const { limit, offset } = pageParams(req);
  const category = String(req.query.category || "").trim().slice(0, SERVICE_CATEGORY_MAX) || null;
  const q = String(req.query.q || "").trim().slice(0, 100) || null;
  const area = String(req.query.area || "").trim().slice(0, SERVICE_CATEGORY_MAX) || null;
  const rows = await stmts.listActiveServicesPage({ category, q, area, limit, offset });
  res.json(rows.map(toPublicServiceListing));
}));

// Provider-facing list of the caller's own services (active and inactive).
app.get("/api/provider/services", requireAuth, asyncHandler(async (req, res) => {
  const profile = await requireProviderProfile(req, res);
  if (!profile) return;
  const { limit, offset } = pageParams(req);
  const rows = await stmts.listServicesByProfile(profile.id, limit, offset);
  res.json(rows.map(toPublicService));
}));

app.post("/api/services", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const profile = await requireProviderProfile(req, res);
  if (!profile) return;
  const clean = sanitizeServiceInput(req.body);
  if (clean.error) return res.status(400).json({ error: clean.error });
  const v = clean.value;
  const service = await stmts.insertService(
    profile.id,
    v.title,
    v.description,
    v.category,
    v.price_amount,
    v.price_currency,
    v.price_unit,
    v.duration_min ?? null,
    Date.now()
  );
  res.status(201).json(toPublicService(service));
}));

app.put("/api/services/:id", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const profile = await requireProviderProfile(req, res);
  if (!profile) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Service not found." });
  const existing = await stmts.findServiceById(id);
  if (!existing) return res.status(404).json({ error: "Service not found." });
  if (existing.profile_id !== profile.id) {
    return res.status(403).json({ error: "This service does not belong to your profile." });
  }
  const clean = sanitizeServiceInput(req.body, { partial: true });
  if (clean.error) return res.status(400).json({ error: clean.error });
  const v = clean.value;
  if (Object.keys(v).length === 0) {
    return res.status(400).json({ error: "No fields to update." });
  }
  const fields = {};
  if (v.title !== undefined) fields.title = v.title;
  if (v.description !== undefined) fields.description = v.description;
  if (v.category !== undefined) fields.category = v.category;
  if (v.price_amount !== undefined) fields.price_amount = v.price_amount;
  if (v.price_currency !== undefined) fields.price_currency = v.price_currency;
  if (v.price_unit !== undefined) fields.price_unit = v.price_unit;
  if (v.duration_min !== undefined) fields.duration_min = v.duration_min;
  if (v.active !== undefined) fields.active = v.active;
  const updated = await stmts.updateService(id, fields, Date.now());
  res.json(toPublicService(updated));
}));

app.delete("/api/services/:id", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const profile = await requireProviderProfile(req, res);
  if (!profile) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Service not found." });
  const existing = await stmts.findServiceById(id);
  if (!existing) return res.status(404).json({ error: "Service not found." });
  if (existing.profile_id !== profile.id) {
    return res.status(403).json({ error: "This service does not belong to your profile." });
  }
  // Historical bookings must keep their service/price information. Because the
  // FK is ON DELETE SET NULL, deleting would detach those rows from the service,
  // so services with any bookings are deactivated instead.
  const refs = await stmts.countBookingsForService(id);
  if (refs > 0) {
    return res.status(409).json({ error: "This service has bookings and cannot be deleted. Deactivate it instead." });
  }
  await stmts.deleteService(id);
  res.json({ ok: true, id });
}));

app.post(
  "/api/track-by-code",
  requireAuth,
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyBy: (req) => `bycode:${req.ip}` }),
  asyncHandler(async (req, res) => {
    const code = String(req.body?.code || "").trim().toUpperCase().replace(/[\s-]/g, "");
    if (!code) return res.status(400).json({ error: "Enter a tracking code." });
    const p = fromProfileRow(await stmts.findProfileByCode(code));
    if (!p || !p.is_active) {
      return res.status(404).json({ error: "No active person found with that code." });
    }
    await rotateCodeForProfile(p); // codes are single-use: rotate once used
    const booking = await createBooking(req.userId, {
      personName: p.name,
      phone: p.phone,
      note: `Tracked via profile${p.city ? ` — ${p.city}` : ""}`,
    });
    emitToOwner("booking:created", booking);
    res.status(201).json(toPublic(booking));
  })
);

app.get("/api/profile", requireAuth, asyncHandler(async (req, res) => {
  const p = fromProfileRow(await stmts.findProfileByUser(req.userId));
  if (!p) return res.status(404).json({ error: "No profile yet." });
  await ensureFreshCode(p);
  res.json(ownProfile(p));
}));

app.post("/api/profile", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const clean = sanitizeProfileInput(req.body);
  if (clean.error) return res.status(400).json({ error: clean.error });
  const v = clean.value;
  const existing = fromProfileRow(await stmts.findProfileByUser(req.userId));
  const now = Date.now();

  let p;
  if (existing) {
    await stmts.updateProfile(v.name, v.bio, JSON.stringify(v.skills), v.avatar, v.phone, v.city, v.listed ? 1 : 0, 1, now, existing.id);
    p = fromProfileRow(await stmts.findProfileById(existing.id));
  } else {
    const code = generateCode();
    p = fromProfileRow(
      await stmts.insertProfile(
        req.userId,
        v.name,
        v.bio,
        JSON.stringify(v.skills),
        v.avatar,
        v.phone,
        v.city,
        v.listed ? 1 : 0,
        1,
        code,
        now + TRACK_CODE_TTL_MS,
        now,
        now
      )
    );
  }
  res.status(201).json(ownProfile(p));
}));

app.post("/api/profile/rotate-code", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const p = fromProfileRow(await stmts.findProfileByUser(req.userId));
  if (!p) return res.status(404).json({ error: "No profile yet." });
  await rotateCodeForProfile(p);
  res.json({ trackCode: p.track_code, codeExpiresAt: p.code_expires_at });
}));

// Provider availability: the recurring weekly schedule in the provider's own
// timezone. Only the profile owner may read or replace it; the public schedule
// (active windows only) is embedded in GET /api/profiles/:id.
app.get("/api/profile/availability", requireAuth, asyncHandler(async (req, res) => {
  const profile = await requireProviderProfile(req, res);
  if (!profile) return;
  const rows = await stmts.listAvailability(profile.id);
  const fresh = fromProfileRow(await stmts.findProfileById(profile.id));
  res.json({
    timezone: fresh?.timezone ?? null,
    availability: rows.map((a) => ({ id: a.id, ...toPublicWindow(a), active: !!a.active })),
  });
}));

// Replace the whole schedule in one transaction. Validation runs server-side;
// the DB CHECKs remain the final gate for any malformed window.
app.put("/api/profile/availability", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const profile = await requireProviderProfile(req, res);
  if (!profile) return;
  const clean = sanitizeAvailabilityInput(req.body);
  if (clean.error) return res.status(400).json({ error: clean.error });
  const v = clean.value;
  await stmts.replaceAvailability(profile.id, v.timezone, v.availability, Date.now());
  const rows = await stmts.listAvailability(profile.id);
  const fresh = fromProfileRow(await stmts.findProfileById(profile.id));
  res.json({
    timezone: fresh?.timezone ?? null,
    availability: rows.map((a) => ({ id: a.id, ...toPublicWindow(a), active: !!a.active })),
  });
}));

app.post("/api/profiles/:id/track", requireAuth, csrfGuard,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 30, keyBy: (req) => `track:${req.userId}` }),
  asyncHandler(async (req, res) => {
    const p = fromProfileRow(await stmts.findProfileById(Number(req.params.id)));
    if (!p || !p.is_active) return res.status(404).json({ error: "Profile not found." });
    const { pickup, destination } = req.body || {};
    if (!pickup || !destination || !pickup.lat || !destination.lat) {
      return res.status(400).json({ error: "Pickup and destination are required." });
    }
    const booking = await createBooking(req.userId, {
      personName: p.name,
      phone: p.phone,
      note: `Tracked via profile${p.city ? ` — ${p.city}` : ""}`,
      pickup,
      destination,
    });
    emitToOwner("booking:created", booking);
    res.status(201).json(toPublic(booking));
  })
);

// ---------------- Messaging (HTTP) ----------------

// GET /api/bookings/:id/messages — paginated history (newest-first, cursor-based)
app.get("/api/bookings/:id/messages", requireAuth, asyncHandler(async (req, res) => {
  const participant = await verifyBookingParticipant(req.params.id, req.userId);
  if (!participant) return res.status(404).json({ error: "Booking not found." });
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(Math.floor(rawLimit), MESSAGE_PAGE_MAX) : 50;
  const before = req.query.before ? Number(req.query.before) : null;
  const rows = await stmts.listMessagesPage(req.params.id, before, limit);
  const messages = rows.map(toPublicMessage).reverse();
  res.json(messages);
}));

// POST /api/bookings/:id/messages — send a message
app.post(
  "/api/bookings/:id/messages",
  requireAuth,
  csrfGuard,
  rateLimit({ windowMs: 60_000, max: 30, keyBy: (req) => `msg:${req.userId}:${req.params.id}` }),
  asyncHandler(async (req, res) => {
    const participant = await verifyBookingParticipant(req.params.id, req.userId);
    if (!participant) return res.status(404).json({ error: "Booking not found." });

    const { booking, role } = participant;
    const terminal = TERMINAL_STATES.has(booking.status) || LEGACY_ENDED.has(booking.status);
    if (terminal) {
      return res.status(409).json({ error: "This booking is no longer active." });
    }
    // In REQUESTED state only the customer may send (no bilateral relationship yet).
    if (booking.status === "REQUESTED" && role === "provider") {
      return res.status(409).json({ error: "You must accept the request before messaging." });
    }

    const nonce = req.body?.nonce;
    const cached = checkNonce(nonce);
    if (cached) return res.json(cached);

    const cleaned = sanitizeMessageBody(req.body?.body);
    if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });

    const now = Date.now();
    const row = await stmts.insertMessage(booking.id, req.userId, cleaned.value, now);
    const pub = toPublicMessage({ ...row, sender: { id: req.userId, name: participant.role === "customer" ? booking.person_name : undefined } });

    // Enrich sender name for the broadcast
    try {
      const senderUser = await stmts.findUserById(req.userId);
      if (senderUser) pub.sender = { id: req.userId, name: senderUser.name };
    } catch { /* use what we have */ }

    // Store for nonce dedup
    if (nonce && typeof nonce === "string") {
      const entry = nonceDedup.get(nonce);
      if (entry) entry.msg = pub;
      else nonceDedup.set(nonce, { ts: now, msg: pub });
    }

    // Broadcast to both participants
    await emitMessageToParticipants(booking, "message:new", { bookingId: booking.id, message: pub });

    // Notify the non-sender participant
    try {
      const senderUser = pub.sender;
      const senderName = senderUser?.name || "Someone";
      const notifyUserId = booking.user_id === req.userId
        ? (booking.profile_id ? (await stmts.findProfileById(booking.profile_id))?.user_id : null)
        : booking.user_id;
      if (notifyUserId) {
        await notifyAndEmit(notifyUserId, {
          type: NOTIFICATION_TYPES.MESSAGE_NEW,
          title: "New message",
          body: `${senderName} sent a message`,
          link: `/requests/${booking.id}`,
          refType: "booking",
          refId: booking.id,
        });
      }
    } catch { /* best effort */ }

    res.status(201).json(pub);
  })
);

// POST /api/bookings/:id/messages/read — mark unread messages as read
app.post(
  "/api/bookings/:id/messages/read",
  requireAuth,
  csrfGuard,
  asyncHandler(async (req, res) => {
    const participant = await verifyBookingParticipant(req.params.id, req.userId);
    if (!participant) return res.status(404).json({ error: "Booking not found." });
    const now = Date.now();
    const result = await stmts.markMessagesRead(req.params.id, req.userId, now);
    if (result.count > 0) {
      await emitMessageToParticipants(participant.booking, "message:read", {
        bookingId: participant.booking.id,
        readerId: req.userId,
      });
    }
    res.json({ ok: true, marked: result.count });
  })
);

// GET /api/messages/unread — returns { [bookingId]: unreadCount } for the caller
app.get("/api/messages/unread", requireAuth, asyncHandler(async (req, res) => {
  const rawBookings = await stmts.listBookingsByUserPage(req.userId, 200, 0);
  const result = {};
  for (const b of rawBookings) {
    if (!b.profile_id) continue;
    const count = await stmts.countUnreadByBooking(b.id, req.userId);
    if (count > 0) result[b.id] = count;
  }
  res.json(result);
}));

// ---------------- Notifications (HTTP) ----------------

app.get("/api/notifications", requireAuth, asyncHandler(async (req, res) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(Math.floor(rawLimit), NOTIFICATION_PAGE_MAX) : 20;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
  const [notifications, unreadCount] = await Promise.all([
    listNotificationsPage(req.userId, limit, offset),
    countUnreadNotifications(req.userId),
  ]);
  res.json({ notifications, unreadCount });
}));

app.get("/api/notifications/unread", requireAuth, asyncHandler(async (req, res) => {
  const count = await countUnreadNotifications(req.userId);
  res.json({ count });
}));

app.post("/api/notifications/:id/read", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid notification id." });
  const n = await markNotificationRead(id, req.userId);
  if (!n) return res.status(404).json({ error: "Notification not found." });
  res.json(n);
}));

app.post("/api/notifications/read-all", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const result = await markAllNotificationsRead(req.userId, Date.now());
  res.json({ ok: true, marked: result.count });
}));

// ---------------- Reports (user-facing) ----------------

app.post("/api/reports", requireAuth, csrfGuard, asyncHandler(async (req, res) => {
  const { targetType, targetId, reason } = req.body || {};
  const validTargets = new Set(["user", "provider", "booking", "review"]);
  if (!validTargets.has(targetType)) return res.status(400).json({ error: "Invalid target type." });
  if (!targetId) return res.status(400).json({ error: "Target ID is required." });
  const trimmed = String(reason || "").trim();
  if (trimmed.length < 10) return res.status(400).json({ error: "Reason must be at least 10 characters." });
  const report = await createReport({ reporterId: req.userId, targetType, targetId: String(targetId), reason: trimmed });
  res.status(201).json(report);
}));

// ---------------- Admin API ----------------
// All /api/admin/* routes require authentication + admin role.

// --- Dashboard ---
app.get("/api/admin/dashboard", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const stats = await getDashboardStats();
  res.json(stats);
}));

// --- Users ---
app.get("/api/admin/users", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await listUsersPage({
    search: req.query.search || null,
    role: req.query.role || null,
    status: req.query.status || null,
    limit, offset,
  });
  res.json(result);
}));

app.get("/api/admin/users/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid user ID." });
  const user = await getUserDetail(id);
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json(user);
}));

app.put("/api/admin/users/:id/status", requireAuth, requireAdmin, csrfGuard, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid user ID." });
  const { status } = req.body || {};
  if (!["active", "suspended"].includes(status)) return res.status(400).json({ error: "Status must be 'active' or 'suspended'." });
  if (id === req.userId) return res.status(400).json({ error: "Cannot change your own status." });
  const user = await setUserStatus(id, status);
  await createAuditLog({ adminId: req.userId, action: "user_status", targetType: "user", targetId: id, meta: { status } });
  res.json(user);
}));

app.put("/api/admin/users/:id/role", requireAuth, requireAdmin, csrfGuard, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid user ID." });
  const { role } = req.body || {};
  if (!["customer", "provider", "both"].includes(role)) return res.status(400).json({ error: "Role must be 'customer', 'provider', or 'both'." });
  if (id === req.userId) return res.status(400).json({ error: "Cannot change your own role." });
  const user = await setUserRole(id, role);
  await createAuditLog({ adminId: req.userId, action: "user_role", targetType: "user", targetId: id, meta: { role } });
  res.json(user);
}));

// --- Providers ---
app.get("/api/admin/providers", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await listProvidersPage({
    search: req.query.search || null,
    verified: req.query.verified || null,
    listed: req.query.listed || null,
    limit, offset,
  });
  res.json(result);
}));

app.get("/api/admin/providers/:userId", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: "Invalid user ID." });
  const detail = await getProviderDetail(userId);
  if (!detail) return res.status(404).json({ error: "Provider not found." });
  res.json(detail);
}));

app.put("/api/admin/providers/:profileId/verified", requireAuth, requireAdmin, csrfGuard, asyncHandler(async (req, res) => {
  const profileId = Number(req.params.profileId);
  if (!Number.isInteger(profileId)) return res.status(400).json({ error: "Invalid profile ID." });
  const { verified } = req.body || {};
  if (typeof verified !== "boolean") return res.status(400).json({ error: "verified must be a boolean." });
  const profile = await setProviderVerified(profileId, verified);
  await createAuditLog({ adminId: req.userId, action: "provider_verified", targetType: "profile", targetId: profileId, meta: { verified } });
  res.json(profile);
}));

app.put("/api/admin/providers/:profileId/listed", requireAuth, requireAdmin, csrfGuard, asyncHandler(async (req, res) => {
  const profileId = Number(req.params.profileId);
  if (!Number.isInteger(profileId)) return res.status(400).json({ error: "Invalid profile ID." });
  const { listed } = req.body || {};
  if (typeof listed !== "boolean") return res.status(400).json({ error: "listed must be a boolean." });
  const profile = await setProviderListed(profileId, listed);
  await createAuditLog({ adminId: req.userId, action: "provider_listed", targetType: "profile", targetId: profileId, meta: { listed } });
  res.json(profile);
}));

app.put("/api/admin/providers/:profileId/active", requireAuth, requireAdmin, csrfGuard, asyncHandler(async (req, res) => {
  const profileId = Number(req.params.profileId);
  if (!Number.isInteger(profileId)) return res.status(400).json({ error: "Invalid profile ID." });
  const { active } = req.body || {};
  if (typeof active !== "boolean") return res.status(400).json({ error: "active must be a boolean." });
  const profile = await setProviderActive(profileId, active);
  await createAuditLog({ adminId: req.userId, action: "provider_active", targetType: "profile", targetId: profileId, meta: { active } });
  res.json(profile);
}));

// --- Bookings ---
app.get("/api/admin/bookings", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await listBookingsPage({
    status: req.query.status || null,
    profileId: req.query.profileId ? Number(req.query.profileId) : null,
    userId: req.query.userId ? Number(req.query.userId) : null,
    limit, offset,
  });
  res.json(result);
}));

app.get("/api/admin/bookings/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const booking = await getBookingDetail(req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  res.json(booking);
}));

// --- Payments ---
app.get("/api/admin/payments", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await listPaymentsPage({
    paymentStatus: req.query.paymentStatus || null,
    limit, offset,
  });
  res.json(result);
}));

// --- Reviews ---
app.get("/api/admin/reviews", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await listReviewsPage({
    hidden: req.query.hidden || null,
    profileId: req.query.profileId ? Number(req.query.profileId) : null,
    limit, offset,
  });
  res.json(result);
}));

app.put("/api/admin/reviews/:id/hidden", requireAuth, requireAdmin, csrfGuard, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid review ID." });
  const { hidden, hiddenReason } = req.body || {};
  if (typeof hidden !== "boolean") return res.status(400).json({ error: "hidden must be a boolean." });
  try {
    const review = await setReviewHidden(id, hidden, hiddenReason);
    await createAuditLog({ adminId: req.userId, action: "review_hidden", targetType: "review", targetId: id, meta: { hidden, hiddenReason } });
    res.json(review);
  } catch {
    res.status(404).json({ error: "Review not found." });
  }
}));

// --- Reports ---
app.get("/api/admin/reports", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await listReportsPage({
    status: req.query.status || null,
    targetType: req.query.targetType || null,
    limit, offset,
  });
  res.json(result);
}));

app.put("/api/admin/reports/:id/status", requireAuth, requireAdmin, csrfGuard, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid report ID." });
  const { status } = req.body || {};
  if (!["OPEN", "REVIEWED", "RESOLVED", "DISMISSED"].includes(status)) {
    return res.status(400).json({ error: "Status must be one of: OPEN, REVIEWED, RESOLVED, DISMISSED." });
  }
  try {
    const report = await updateReportStatus(id, status, req.userId);
    await createAuditLog({ adminId: req.userId, action: "report_status", targetType: "report", targetId: id, meta: { status } });
    res.json(report);
  } catch {
    res.status(404).json({ error: "Report not found." });
  }
}));

// --- Audit Log ---
app.get("/api/admin/audit", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = await listAuditLogsPage({
    adminId: req.query.adminId ? Number(req.query.adminId) : null,
    action: req.query.action || null,
    limit, offset,
  });
  res.json(result);
}));

// ---------------- Socket ----------------

async function sessionFromSocket(socket) {
  const cookies = parseCookies(socket.handshake.headers.cookie || "");
  return await getSession(cookies[SESSION_COOKIE]);
}

io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin && !allowedOrigins().includes(origin)) {
    return next(new Error("origin not allowed"));
  }
  sessionFromSocket(socket)
    .then((session) => {
      if (session) socket.userId = session.user_id;
      next();
    })
    .catch(next);
});

io.on("connection", (socket) => {
  if (socket.userId) {
    socket.join(`user:${socket.userId}`);
  }

  socket.on("booking:create", async (data, cb) => {
    if (!socket.userId) return typeof cb === "function" && cb({ error: "Authentication required." });
    const { personName, phone, note, pickup, destination } = data || {};
    if (!personName || typeof personName !== "string" || !pickup || !destination) {
      return typeof cb === "function" && cb({ error: "Missing booking details." });
    }
    try {
      const booking = await createBooking(socket.userId, { personName, phone, note, pickup, destination });
      emitToOwner("booking:created", booking);
      if (typeof cb === "function") cb(toPublic(booking));
    } catch (err) {
      console.error("booking:create failed:", err);
      if (typeof cb === "function") cb({ error: "Could not create booking." });
    }
  });

  socket.on("watch:join", async ({ bookingId }) => {
    if (!socket.userId) return;
    try {
      const b = fromRow(await stmts.findBookingByUser(bookingId, socket.userId));
      if (!b) return;
      socket.join(`watch:${bookingId}`);
      socket.emit("booking:update", toPublic(b));
    } catch (err) {
      console.error("watch:join failed:", err);
    }
  });

  socket.on("watch:leave", ({ bookingId }) => {
    socket.leave(`watch:${bookingId}`);
  });

  socket.on("booking:cancel", async ({ bookingId }, cb) => {
    if (!socket.userId) return typeof cb === "function" && cb({ error: "Authentication required." });
    try {
      const r = await cancelBookingForActor(socket.userId, bookingId);
      if (r.ok) {
        const b = fromRow(r.booking);
        io.to(`watch:${bookingId}`).emit("booking:cancelled", toPublic(b));
        broadcast(b);
        if (typeof cb === "function") cb(toPublic(b));
      } else if (typeof cb === "function") {
        cb({ error: r.error });
      }
    } catch (err) {
      console.error("booking:cancel failed:", err);
      if (typeof cb === "function") cb({ error: "Could not cancel booking." });
    }
  });

  // Owner confirms the person has arrived (additive — the person can still
  // self-report via arrival:update, and auto-arrival still fires on distance).
  // For marketplace bookings the transition is DB-guarded: only the assigned
  // provider (or the server's auto-arrival detection) may set ARRIVED, and only
  // from PROVIDER_EN_ROUTE — the owner cannot force an arbitrary arrival.
  socket.on("booking:arrived", async ({ bookingId }) => {
    if (!socket.userId) return;
    try {
      const b = fromRow(await stmts.findBookingByUser(bookingId, socket.userId));
      if (!b) return;
      if (b.profile_id) {
        const profile = fromProfileRow(await stmts.findProfileByUser(socket.userId));
        const r = await transitionBooking({
          actorKind: "provider",
          userId: socket.userId,
          profileId: profile?.id ?? null,
          bookingId,
          action: "arrive",
        });
        if (r.ok) broadcast(fromRow(r.booking));
        return;
      }
      b.status = "arrived";
      await saveBooking(b);
      const pub = toPublic(b);
      const personSet = personSockets.get(bookingId);
      if (personSet) {
        for (const sid of personSet) io.to(sid).emit("person:arrived", pub);
      }
      broadcast(b);
    } catch (err) {
      console.error("booking:arrived failed:", err);
    }
  });

  // ---- The tracked person (anonymous, authenticated by share token) ----

  async function authorizeToken(bookingId, token) {
    if (!bookingId || !token) return null;
    const b = fromRow(await stmts.findBookingById(bookingId));
    if (!b) return null;
    const a = Buffer.from(b.share_token);
    const c = Buffer.from(String(token));
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
    return b;
  }

  async function markPersonOffline(bookingId) {
    const set = personSockets.get(bookingId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      personSockets.delete(bookingId);
      try {
        const b = fromRow(await stmts.findBookingById(bookingId));
        if (b && b.person_online) {
          // Only touch the presence flag; never rewrite a status read earlier
          // (a concurrent marketplace transition must not be overwritten).
          await stmts.setBookingOnline(bookingId, 0);
          broadcast(fromRow(await stmts.findBookingById(bookingId)));
        }
      } catch (err) {
        console.error("markPersonOffline failed:", err);
      }
    }
  }

  socket.on("person:join", async ({ bookingId, token, personName }, cb) => {
    try {
      const b = await authorizeToken(bookingId, token);
      if (!b) {
        return typeof cb === "function" && cb({ error: "Invalid tracking link." });
      }
      const ended = b.profile_id ? TERMINAL_STATES.has(b.status) : LEGACY_ENDED.has(b.status);
      if (ended) {
        return typeof cb === "function" && cb({ error: "This tracking session has ended." });
      }
      socket.vestBookingId = bookingId;
      if (!personSockets.has(bookingId)) personSockets.set(bookingId, new Set());
      personSockets.get(bookingId).add(socket.id);
      b.person_online = 1;
      if (personName && String(personName).trim()) b.person_name = String(personName).trim();
      if (b.profile_id) {
        // Marketplace bookings: presence only — never rewrite lifecycle status.
        await stmts.updateBookingTracking(b.id, 1, b.location ? JSON.stringify(b.location) : null, JSON.stringify(b.path));
        if (personName && String(personName).trim()) await stmts.setBookingPersonName(b.id, String(personName).trim());
      } else {
        if (b.status === "pending") b.status = "online";
        await saveBooking(b);
      }
      broadcast(b);
      if (typeof cb === "function") cb({ ok: true });
    } catch (err) {
      console.error("person:join failed:", err);
      if (typeof cb === "function") cb({ error: "Could not join tracking session." });
    }
  });

  socket.on("person:leave", async ({ bookingId }) => {
    if (bookingId === socket.vestBookingId) {
      socket.vestBookingId = null;
      await markPersonOffline(bookingId);
    }
  });

  socket.on("location:update", async ({ bookingId, token, lat, lng, accuracy, speed }) => {
    try {
      const b = await authorizeToken(bookingId, token);
      if (!b || typeof lat !== "number" || typeof lng !== "number") return;
      const point = { lat, lng, accuracy: accuracy || 10, speed: speed || 0, t: Date.now() };
      b.path = [...b.path, point];
      if (b.path.length > MAX_PATH) b.path = b.path.slice(-MAX_PATH);

      if (b.profile_id) {
        // Marketplace bookings: the share-token person is the travelling
        // provider. Location is tracking-only — it must never overwrite the
        // lifecycle status. Auto-arrival is the single server-side transition,
        // only from PROVIDER_EN_ROUTE and within the arrival threshold.
        b.location = point;
        b.person_online = 1;
        await stmts.updateBookingTracking(b.id, 1, JSON.stringify(point), JSON.stringify(b.path));
        if (
          b.status === "PROVIDER_EN_ROUTE" &&
          b.destination &&
          haversine(point, b.destination) <= ARRIVE_THRESHOLD_M
        ) {
          const r = await transitionBooking({ actorKind: "system", bookingId: b.id, action: "arrive" });
          if (r.ok) {
            const fresh = fromRow(r.booking);
            socket.emit("person:arrived", toPublic(fresh));
            broadcast(fresh);
            return;
          }
        }
        broadcast(b);
        return;
      }

      // Legacy tracking flow (unchanged).
      if (
        b.status !== "arrived" &&
        b.status !== "cancelled" &&
        b.destination &&
        haversine(point, b.destination) <= ARRIVE_THRESHOLD_M
      ) {
        b.status = "arrived";
        b.location = point;
        await saveBooking(b);
        socket.emit("person:arrived", toPublic(b));
        broadcast(b);
        return;
      }

      if (b.status !== "arrived" && b.status !== "cancelled") {
        b.status = "in_transit";
      }
      b.location = point;
      await saveBooking(b);
      broadcast(b);
    } catch (err) {
      console.error("location:update failed:", err);
    }
  });

  socket.on("arrival:update", async ({ bookingId, token }) => {
    try {
      const b = await authorizeToken(bookingId, token);
      if (!b) return;
      if (b.profile_id) {
        // Person (provider) self-reports arrival — still routed through the
        // guarded transition so it can only fire from PROVIDER_EN_ROUTE.
        const r = await transitionBooking({ actorKind: "system", bookingId, action: "arrive" });
        if (r.ok) {
          const fresh = fromRow(r.booking);
          socket.emit("person:arrived", toPublic(fresh));
          broadcast(fresh);
        }
        return;
      }
      b.status = "arrived";
      await saveBooking(b);
      socket.emit("person:arrived", toPublic(b));
      broadcast(b);
    } catch (err) {
      console.error("arrival:update failed:", err);
    }
  });

  // ---- Messaging (Socket.IO) ----

  socket.on("message:send", async ({ bookingId, body, nonce }, cb) => {
    if (!socket.userId) return typeof cb === "function" && cb({ error: "Authentication required." });
    try {
      const participant = await verifyBookingParticipant(bookingId, socket.userId);
      if (!participant) return typeof cb === "function" && cb({ error: "Booking not found." });

      const { booking, role } = participant;
      const terminal = TERMINAL_STATES.has(booking.status) || LEGACY_ENDED.has(booking.status);
      if (terminal) return typeof cb === "function" && cb({ error: "This booking is no longer active." });
      if (booking.status === "REQUESTED" && role === "provider") {
        return typeof cb === "function" && cb({ error: "You must accept the request before messaging." });
      }

      const cached = checkNonce(nonce);
      if (cached) return typeof cb === "function" && cb(cached);

      const cleaned = sanitizeMessageBody(body);
      if (!cleaned.ok) return typeof cb === "function" && cb({ error: cleaned.error });

      const now = Date.now();
      const row = await stmts.insertMessage(booking.id, socket.userId, cleaned.value, now);

      let senderName = "User";
      try {
        const senderUser = await stmts.findUserById(socket.userId);
        if (senderUser) senderName = senderUser.name;
      } catch { /* ignore */ }

      const pub = toPublicMessage({ ...row, sender: { id: socket.userId, name: senderName } });

      if (nonce && typeof nonce === "string") {
        const entry = nonceDedup.get(nonce);
        if (entry) entry.msg = pub;
        else nonceDedup.set(nonce, { ts: now, msg: pub });
      }

      await emitMessageToParticipants(booking, "message:new", { bookingId: booking.id, message: pub });

      // Notify the non-sender participant
      const notifyUserId = booking.user_id === socket.userId
        ? (booking.profile_id ? (await stmts.findProfileById(booking.profile_id))?.user_id : null)
        : booking.user_id;
      if (notifyUserId) {
        await notifyAndEmit(notifyUserId, {
          type: NOTIFICATION_TYPES.MESSAGE_NEW,
          title: "New message",
          body: `${senderName} sent a message`,
          link: `/requests/${booking.id}`,
          refType: "booking",
          refId: booking.id,
        });
      }

      if (typeof cb === "function") cb(pub);
    } catch (err) {
      console.error("message:send failed:", err);
      if (typeof cb === "function") cb({ error: "Could not send message." });
    }
  });

  socket.on("disconnect", async () => {
    if (socket.vestBookingId) {
      const bookingId = socket.vestBookingId;
      socket.vestBookingId = null;
      await markPersonOffline(bookingId);
    }
  });
});

// Any error that escapes a route handler (e.g. a database failure) becomes a
// clean 500 JSON response instead of an unhandled rejection.
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error." });
});

sessionCleanupLoop();
initMailer();

// Rotate expired tracking codes even when nobody is looking, so old
// codes stop working.
setInterval(() => {
  stmts
    .listExpiredCodes(Date.now())
    .then((rows) =>
      Promise.all(
        rows.map(async (row) => {
          const p = fromProfileRow(await stmts.findProfileById(row.id));
          if (p) await rotateCodeForProfile(p);
        })
      )
    )
    .catch((err) => console.error("code rotation failed:", err));
}, 60_000).unref();

// Expire REQUESTED bookings whose deadline has passed. Every sweep is a
// guarded conditional update (status must still be REQUESTED), so a booking
// that was accepted / rejected / cancelled concurrently is never touched.
setInterval(() => {
  stmts
    .listExpiredRequests(Date.now())
    .then((rows) =>
      Promise.all(
        rows.map(async ({ id }) => {
          const count = await stmts.transitionBooking({
            id,
            fromStatuses: ["REQUESTED"],
            toStatus: "EXPIRED",
          });
          if (count === 1) {
            const b = fromRow(await stmts.findBookingById(id));
            if (b) {
              broadcast(b);
              notifyAndEmit(b.user_id, {
                type: NOTIFICATION_TYPES.BOOKING_EXPIRED,
                title: "Request expired",
                body: "Your service request has expired",
                link: "/bookings",
                refType: "booking",
                refId: b.id,
              });
            }
          }
        })
      )
    )
    .catch((err) => console.error("request expiration failed:", err));
}, REQUEST_SWEEP_MS).unref();

// Delete notifications older than 90 days.
const NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
setInterval(() => {
  deleteOldNotifications(NOTIFICATION_RETENTION_MS)
    .then((r) => { if (r.count > 0) console.log(`Cleaned ${r.count} old notifications`); })
    .catch((err) => console.error("notification cleanup failed:", err));
}, 6 * 60 * 60 * 1000).unref();

// In production the built client is served from the same server, so the
// whole app (API + socket + UI) runs as one process and tracking links
// like /join/:id?t=... work everywhere.
if (SERVE_STATIC && fs.existsSync(CLIENT_DIST)) {
  app.use(
    express.static(CLIENT_DIST, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
      },
    })
  );
  app.get(/^\/(?!api\/|socket\.io|health).*/, (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

// Any "online" flag persisted before this process started refers to sockets
// that no longer exist, so clear them at boot (startup reset for restarts).
try {
  await stmts.ping();
  await stmts.clearAllOnline();
} catch (err) {
  console.error("Database connection failed:", err.message);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(
    `Bookking server running on http://localhost:${PORT}` +
      (SERVE_STATIC && fs.existsSync(CLIENT_DIST) ? " (serving client)" : "")
  );
});
