import express from "express";
import http from "http";
import cors from "cors";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import stmts, { db } from "./db.js";
import {
  attachUser,
  requireAuth,
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

const PORT = process.env.PORT || 4001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");
const SERVE_STATIC = process.env.SERVE_STATIC === "1" || process.env.NODE_ENV === "production";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: allowedOrigins(), credentials: true }));
app.use(securityHeaders);
app.use(express.json({ limit: "10kb" }));
app.use(attachUser);
app.use(originGuard);

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

function rotateCodeForProfile(p) {
  const code = generateCode();
  const expiresAt = Date.now() + TRACK_CODE_TTL_MS;
  stmts.updateProfileCode.run(code, expiresAt, p.id);
  p.track_code = code;
  p.code_expires_at = expiresAt;
  return p;
}

function ensureFreshCode(p) {
  if (p.code_expires_at <= Date.now()) rotateCodeForProfile(p);
  return p;
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

// ---------------- Booking helpers ----------------

function makeId() {
  return crypto.randomBytes(6).toString("hex");
}

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function createBooking(userId, data) {
  const now = Date.now();
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
    status: "pending",
    created_at: now,
    person_online: 0,
    simulating: 0,
    location: null,
    path: [],
  };
  stmts.insertBooking.run(
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
    booking.simulating,
    null,
    JSON.stringify([])
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
    simulating: !!row.simulating,
  };
}

function saveBooking(b) {
  stmts.updateBooking.run(
    b.person_name,
    b.phone,
    b.note,
    b.pickup ? JSON.stringify(b.pickup) : null,
    b.destination ? JSON.stringify(b.destination) : null,
    b.status,
    b.person_online ? 1 : 0,
    b.simulating ? 1 : 0,
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
  };
}

function broadcast(booking) {
  const pub = toPublic(booking);
  io.to(`watch:${booking.id}`).emit("booking:update", pub);
  io.to(`user:${booking.user_id}`).emit("booking:update", pub);
}

function emitToOwner(event, booking) {
  io.to(`user:${booking.user_id}`).emit(event, toPublic(booking));
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
app.get("/api/route", async (req, res) => {
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

app.get("/api/auth/me", (req, res) => {
  if (!req.userId) return res.status(401).json({ error: "Authentication required." });
  const user = stmts.findUserById.get(req.userId);
  if (!user) return res.status(401).json({ error: "Authentication required." });
  res.json({ user: publicUser(user), csrf: req.session.csrf });
});

app.post(
  "/api/auth/register",
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5, keyBy: (req) => `register:${req.ip}` }),
  (req, res) => {
    const name = String(req.body?.name || "").trim().slice(0, 60);
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!name) return res.status(400).json({ error: "Name is required." });
    if (!isValidEmail(email)) return res.status(400).json({ error: "A valid email is required." });
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: "Password must be 10–128 characters." });
    }
    if (stmts.findUserByEmail.get(email)) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const { lastInsertRowid } = stmts.insertUser.run(name, email, hashPassword(password), Date.now());
    const user = stmts.findUserById.get(Number(lastInsertRowid));
    const session = createSession(user.id, req);
    setSessionCookie(res, session.token);
    res.status(201).json({ user: publicUser(user), csrf: session.csrf });
  }
);

app.post(
  "/api/auth/login",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyBy: (req) => `login:${req.ip}:${normalizeEmail(req.body?.email)}` }),
  (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const user = stmts.findUserByEmail.get(email);

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
        stmts.updateUserAttempts.run(attempts, lockedUntil, user.id);
      }
      return res.status(401).json({ error: "Invalid email or password." });
    }

    stmts.updateUserAttempts.run(0, null, user.id);
    const session = createSession(user.id, req);
    setSessionCookie(res, session.token);
    res.json({ user: publicUser(user), csrf: session.csrf });
  }
);

app.post("/api/auth/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  destroySession(cookies[SESSION_COOKIE]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post(
  "/api/auth/reset/request",
  rateLimit({ windowMs: 60 * 60 * 1000, max: 3, keyBy: (req) => `reset:${req.ip}:${normalizeEmail(req.body?.email)}` }),
  async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const user = isValidEmail(email) ? stmts.findUserByEmail.get(email) : null;

    let devLink = null;
    if (user) {
      const token = createPasswordReset(user.id);
      const origin = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
      const link = `${origin}/reset?token=${token}`;
      await sendEmail({
        to: user.email,
        subject: "Reset your Vestigator password",
        text: `Someone requested a password reset for your Vestigator account.\n\nClick the link below to choose a new password. This link expires in 30 minutes.\n\n${link}\n\nIf you didn't request this, you can safely ignore this email — your password won't change.`,
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
  }
);

app.post(
  "/api/auth/reset/confirm",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyBy: (req) => `resetconfirm:${req.ip}` }),
  (req, res) => {
    const { token, password } = req.body || {};
    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Invalid or expired reset link." });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: "Password must be 10–128 characters." });
    }
    const reset = getPasswordReset(token);
    if (!reset) {
      return res.status(400).json({ error: "Invalid or expired reset link." });
    }
    const user = stmts.findUserById.get(reset.user_id);
    if (!user) {
      return res.status(400).json({ error: "Invalid or expired reset link." });
    }

    stmts.updateUserPassword.run(hashPassword(password), user.id);
    deletePasswordReset(token);
    revokeAllSessions(user.id);

    const session = createSession(user.id, req);
    setSessionCookie(res, session.token);
    res.json({ user: publicUser(user), csrf: session.csrf });
  }
);

app.get("/api/bookings", requireAuth, (req, res) => {
  const rows = stmts.listBookingsByUser.all(req.userId);
  res.json(rows.map((r) => toPublic(fromRow(r))));
});

app.post("/api/bookings", requireAuth, csrfGuard, (req, res) => {
  const { personName, phone, note, pickup, destination } = req.body || {};
  if (!personName || typeof personName !== "string") {
    return res.status(400).json({ error: "Person's name is required." });
  }
  if (!pickup || !destination || !pickup.lat || !destination.lat) {
    return res.status(400).json({ error: "Pickup and destination are required." });
  }
  const booking = createBooking(req.userId, { personName, phone, note, pickup, destination });
  emitToOwner("booking:created", booking);
  res.status(201).json(toPublic(booking));
});

app.get("/api/bookings/:id", requireAuth, (req, res) => {
  const b = fromRow(stmts.findBookingByUser.get(req.params.id, req.userId));
  if (!b) return res.status(404).json({ error: "Booking not found." });
  res.json(toPublic(b));
});

app.post("/api/bookings/:id/points", requireAuth, csrfGuard, (req, res) => {
  const b = fromRow(stmts.findBookingByUser.get(req.params.id, req.userId));
  if (!b) return res.status(404).json({ error: "Booking not found." });
  const { pickup, destination } = req.body || {};
  if (!pickup || !destination || !pickup.lat || !destination.lat) {
    return res.status(400).json({ error: "Pickup and destination are required." });
  }
  b.pickup = pickup;
  b.destination = destination;
  saveBooking(b);
  broadcast(b);
  res.json(toPublic(b));
});

app.get("/api/share/:id", (req, res) => {
  const b = fromRow(stmts.findBookingById.get(req.params.id));
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
});

// ---------------- Trackable profiles ----------------

app.get("/api/profiles", requireAuth, (_req, res) => {
  const rows = stmts.listActiveProfiles.all(_req.userId);
  const list = rows.map((r) => publicProfile(fromProfileRow(r)));
  const own = fromProfileRow(stmts.findProfileByUser.get(_req.userId));
  if (own && own.is_active && own.listed) {
    list.unshift({ ...publicProfile(own), isOwn: true });
  }
  res.json(list);
});

app.get("/api/profiles/:id", requireAuth, (req, res) => {
  const p = fromProfileRow(stmts.findProfileById.get(Number(req.params.id)));
  if (!p || !p.is_active) return res.status(404).json({ error: "Profile not found." });
  res.json(publicProfile(p));
});

app.post(
  "/api/track-by-code",
  requireAuth,
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, keyBy: (req) => `bycode:${req.ip}` }),
  (req, res) => {
    const code = String(req.body?.code || "").trim().toUpperCase().replace(/[\s-]/g, "");
    if (!code) return res.status(400).json({ error: "Enter a tracking code." });
    const p = fromProfileRow(stmts.findProfileByCode.get(code));
    if (!p || !p.is_active) {
      return res.status(404).json({ error: "No active person found with that code." });
    }
    rotateCodeForProfile(p); // codes are single-use: rotate once used
    const booking = createBooking(req.userId, {
      personName: p.name,
      phone: p.phone,
      note: `Tracked via profile${p.city ? ` — ${p.city}` : ""}`,
    });
    emitToOwner("booking:created", booking);
    res.status(201).json(toPublic(booking));
  }
);

app.get("/api/profile", requireAuth, (req, res) => {
  const p = fromProfileRow(stmts.findProfileByUser.get(req.userId));
  if (!p) return res.status(404).json({ error: "No profile yet." });
  ensureFreshCode(p);
  res.json(ownProfile(p));
});

app.post("/api/profile", requireAuth, csrfGuard, (req, res) => {
  const clean = sanitizeProfileInput(req.body);
  if (clean.error) return res.status(400).json({ error: clean.error });
  const v = clean.value;
  const existing = fromProfileRow(stmts.findProfileByUser.get(req.userId));
  const now = Date.now();

  let p;
  if (existing) {
    stmts.updateProfile.run(v.name, v.bio, JSON.stringify(v.skills), v.avatar, v.phone, v.city, v.listed ? 1 : 0, 1, now, existing.id);
    p = fromProfileRow(stmts.findProfileById.get(existing.id));
  } else {
    const code = generateCode();
    const { lastInsertRowid } = stmts.insertProfile.run(
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
    );
    p = fromProfileRow(stmts.findProfileById.get(Number(lastInsertRowid)));
  }
  res.status(201).json(ownProfile(p));
});

app.post("/api/profile/rotate-code", requireAuth, csrfGuard, (req, res) => {
  const p = fromProfileRow(stmts.findProfileByUser.get(req.userId));
  if (!p) return res.status(404).json({ error: "No profile yet." });
  rotateCodeForProfile(p);
  res.json({ trackCode: p.track_code, codeExpiresAt: p.code_expires_at });
});

app.post("/api/profiles/:id/track", requireAuth, csrfGuard,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 30, keyBy: (req) => `track:${req.userId}` }),
  (req, res) => {
    const p = fromProfileRow(stmts.findProfileById.get(Number(req.params.id)));
    if (!p || !p.is_active) return res.status(404).json({ error: "Profile not found." });
    const { pickup, destination } = req.body || {};
    if (!pickup || !destination || !pickup.lat || !destination.lat) {
      return res.status(400).json({ error: "Pickup and destination are required." });
    }
    const booking = createBooking(req.userId, {
      personName: p.name,
      phone: p.phone,
      note: `Tracked via profile${p.city ? ` — ${p.city}` : ""}`,
      pickup,
      destination,
    });
    emitToOwner("booking:created", booking);
    res.status(201).json(toPublic(booking));
  }
);

// ---------------- Socket ----------------

function sessionFromSocket(socket) {
  const cookies = parseCookies(socket.handshake.headers.cookie || "");
  return getSession(cookies[SESSION_COOKIE]);
}

io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin && !allowedOrigins().includes(origin)) {
    return next(new Error("origin not allowed"));
  }
  const session = sessionFromSocket(socket);
  if (session) socket.userId = session.user_id;
  next();
});

io.on("connection", (socket) => {
  if (socket.userId) {
    socket.join(`user:${socket.userId}`);
  }

  socket.on("booking:create", (data, cb) => {
    if (!socket.userId) return typeof cb === "function" && cb({ error: "Authentication required." });
    const { personName, phone, note, pickup, destination } = data || {};
    if (!personName || typeof personName !== "string" || !pickup || !destination) {
      return typeof cb === "function" && cb({ error: "Missing booking details." });
    }
    const booking = createBooking(socket.userId, { personName, phone, note, pickup, destination });
    emitToOwner("booking:created", booking);
    if (typeof cb === "function") cb(toPublic(booking));
  });

  socket.on("watch:join", ({ bookingId }) => {
    if (!socket.userId) return;
    const b = fromRow(stmts.findBookingByUser.get(bookingId, socket.userId));
    if (!b) return;
    socket.join(`watch:${bookingId}`);
    socket.emit("booking:update", toPublic(b));
  });

  socket.on("watch:leave", ({ bookingId }) => {
    socket.leave(`watch:${bookingId}`);
  });

  socket.on("booking:cancel", ({ bookingId }) => {
    if (!socket.userId) return;
    const b = fromRow(stmts.findBookingByUser.get(bookingId, socket.userId));
    if (!b) return;
    b.status = "cancelled";
    saveBooking(b);
    io.to(`watch:${bookingId}`).emit("booking:cancelled", toPublic(b));
    broadcast(b);
  });

  // ---- The tracked person (anonymous, authenticated by share token) ----

  function authorizeToken(bookingId, token) {
    if (!bookingId || !token) return null;
    const b = fromRow(stmts.findBookingById.get(bookingId));
    if (!b) return null;
    const a = Buffer.from(b.share_token);
    const c = Buffer.from(String(token));
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
    return b;
  }

  function markPersonOffline(bookingId) {
    const set = personSockets.get(bookingId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      personSockets.delete(bookingId);
      const b = fromRow(stmts.findBookingById.get(bookingId));
      if (b && b.person_online) {
        b.person_online = 0;
        saveBooking(b);
        broadcast(b);
      }
    }
  }

  socket.on("person:join", ({ bookingId, token, personName }, cb) => {
    const b = authorizeToken(bookingId, token);
    if (!b) {
      return typeof cb === "function" && cb({ error: "Invalid tracking link." });
    }
    if (b.status === "arrived" || b.status === "cancelled") {
      return typeof cb === "function" && cb({ error: "This tracking session has ended." });
    }
    socket.vestBookingId = bookingId;
    if (!personSockets.has(bookingId)) personSockets.set(bookingId, new Set());
    personSockets.get(bookingId).add(socket.id);
    b.person_online = 1;
    if (personName && String(personName).trim()) b.person_name = String(personName).trim();
    if (b.status === "pending") b.status = "online";
    saveBooking(b);
    broadcast(b);
    if (typeof cb === "function") cb({ ok: true });
  });

  socket.on("person:leave", ({ bookingId }) => {
    if (bookingId === socket.vestBookingId) {
      socket.vestBookingId = null;
      markPersonOffline(bookingId);
    }
  });

  socket.on("location:update", ({ bookingId, token, lat, lng, accuracy, speed }) => {
    const b = authorizeToken(bookingId, token);
    if (!b || typeof lat !== "number" || typeof lng !== "number") return;
    const point = { lat, lng, accuracy: accuracy || 10, speed: speed || 0, t: Date.now() };
    b.path = [...b.path, point];
    if (b.path.length > MAX_PATH) b.path = b.path.slice(-MAX_PATH);
    b.person_online = 1;

    if (
      b.status !== "arrived" &&
      b.status !== "cancelled" &&
      b.destination &&
      haversine(point, b.destination) <= ARRIVE_THRESHOLD_M
    ) {
      b.status = "arrived";
      b.location = point;
      saveBooking(b);
      socket.emit("person:arrived", toPublic(b));
      broadcast(b);
      return;
    }

    if (b.status !== "arrived" && b.status !== "cancelled") {
      b.status = "in_transit";
    }
    b.location = point;
    saveBooking(b);
    broadcast(b);
  });

  socket.on("arrival:update", ({ bookingId, token }) => {
    const b = authorizeToken(bookingId, token);
    if (!b) return;
    b.status = "arrived";
    saveBooking(b);
    socket.emit("person:arrived", toPublic(b));
    broadcast(b);
  });

  socket.on("disconnect", () => {
    if (socket.vestBookingId) {
      const bookingId = socket.vestBookingId;
      socket.vestBookingId = null;
      markPersonOffline(bookingId);
    }
  });
});

sessionCleanupLoop();
initMailer();

// Rotate expired tracking codes even when nobody is looking, so old
// codes stop working.
setInterval(() => {
  const now = Date.now();
  for (const row of stmts.listExpiredCodes.all(now)) {
    const p = fromProfileRow(stmts.findProfileById.get(row.id));
    if (p) rotateCodeForProfile(p);
  }
}, 60_000).unref();

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
stmts.clearAllOnline.run();

server.listen(PORT, () => {
  console.log(
    `Vestigator server running on http://localhost:${PORT}` +
      (SERVE_STATIC && fs.existsSync(CLIENT_DIST) ? " (serving client)" : "")
  );
});
