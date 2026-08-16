import { PrismaClient } from "@prisma/client";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load a local .env (gitignored) when the platform doesn't inject env vars
// directly (Render/Supabase set DATABASE_URL themselves). No-op if already set.
if (!process.env.DATABASE_URL && typeof process.loadEnvFile === "function") {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, ".env"), join(here, "..", ".env"), join(process.cwd(), ".env")]) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        /* best effort */
      }
      break;
    }
  }
}

// PostgreSQL (Supabase) access via Prisma. The rest of the app only ever sees
// plain JS values in the same shapes the old SQLite layer produced:
//   - timestamps:   ms numbers (Prisma BIGINT is converted to Number)
//   - booleans:     0/1 (Prisma BOOLEAN is converted to 0/1)
//   - JSON-ish cols: raw strings (pickup/destination/location/path/skills are
//     still JSON.parse'd in server/index.js, exactly as before)

export const prisma = new PrismaClient();

const BIG = (v) => (v == null ? null : BigInt(v));
const NUM = (v) => (v == null ? null : Number(v));
const toBool = (v) => !!v;
const to01 = (v) => (v ? 1 : 0);

function userOut(u) {
  if (!u) return u;
  return { ...u, created_at: NUM(u.created_at), locked_until: NUM(u.locked_until) };
}

function sessionOut(s) {
  if (!s) return s;
  return { ...s, created_at: NUM(s.created_at), expires_at: NUM(s.expires_at) };
}

function bookingOut(b) {
  if (!b) return b;
  return { ...b, created_at: NUM(b.created_at), person_online: to01(b.person_online) };
}

function profileOut(p) {
  if (!p) return p;
  return {
    ...p,
    created_at: NUM(p.created_at),
    updated_at: NUM(p.updated_at),
    code_expires_at: NUM(p.code_expires_at),
    listed: to01(p.listed),
    is_active: to01(p.is_active),
  };
}

const stmts = {
  // ---- health ----
  ping: () => prisma.$queryRaw`SELECT 1`,

  // ---- users ----
  insertUser: (name, email, passwordHash, createdAt) =>
    prisma.user
      .create({
        data: { name, email, password_hash: passwordHash, created_at: BIG(createdAt) },
      })
      .then(userOut),
  findUserByEmail: (email) => prisma.user.findUnique({ where: { email } }).then(userOut),
  findUserById: (id) => prisma.user.findUnique({ where: { id } }).then(userOut),
  updateUserAttempts: (failedAttempts, lockedUntil, id) =>
    prisma.user.update({
      where: { id },
      data: { failed_attempts: failedAttempts, locked_until: BIG(lockedUntil) },
    }),
  updateUserPassword: (passwordHash, id) =>
    prisma.user.update({ where: { id }, data: { password_hash: passwordHash } }),

  // ---- sessions ----
  insertSession: ({ tokenHash, userId, csrf, createdAt, expiresAt, ip, userAgent }) =>
    prisma.session.create({
      data: {
        token_hash: tokenHash,
        user_id: userId,
        csrf,
        created_at: BIG(createdAt),
        expires_at: BIG(expiresAt),
        ip,
        user_agent: userAgent,
      },
    }),
  findSession: (tokenHash) => prisma.session.findUnique({ where: { token_hash: tokenHash } }).then(sessionOut),
  deleteSession: (tokenHash) => prisma.session.deleteMany({ where: { token_hash: tokenHash } }),
  deleteExpiredSessions: (now) =>
    prisma.session.deleteMany({ where: { expires_at: { lt: BIG(now) } } }),
  deleteAllSessions: (userId) => prisma.session.deleteMany({ where: { user_id: userId } }),

  // ---- bookings ----
  insertBooking: (id, userId, shareToken, code, personName, phone, note, pickup, destination, status, createdAt, personOnline, location, path) =>
    prisma.booking
      .create({
        data: {
          id,
          user_id: userId,
          share_token: shareToken,
          code,
          person_name: personName,
          phone,
          note,
          pickup,
          destination,
          status,
          created_at: BIG(createdAt),
          person_online: toBool(personOnline),
          location,
          path,
        },
      })
      .then(bookingOut),
  findBookingById: (id) => prisma.booking.findUnique({ where: { id } }).then(bookingOut),
  findBookingByUser: (id, userId) =>
    prisma.booking.findFirst({ where: { id, user_id: userId } }).then(bookingOut),
  listBookingsByUserPage: (userId, limit, offset) =>
    prisma.booking
      .findMany({
        where: { user_id: userId },
        orderBy: { created_at: "desc" },
        take: limit,
        skip: offset,
      })
      .then((rows) => rows.map(bookingOut)),
  updateBooking: (personName, phone, note, pickup, destination, status, personOnline, location, path, id) =>
    prisma.booking.update({
      where: { id },
      data: {
        person_name: personName,
        phone,
        note,
        pickup,
        destination,
        status,
        person_online: toBool(personOnline),
        location,
        path,
      },
    }),
  clearAllOnline: () => prisma.booking.updateMany({ data: { person_online: false } }),

  // ---- password resets ----
  insertReset: (userId, tokenHash, createdAt, expiresAt) =>
    prisma.passwordReset.create({
      data: { user_id: userId, token_hash: tokenHash, created_at: BIG(createdAt), expires_at: BIG(expiresAt) },
    }),
  findReset: (tokenHash) => prisma.passwordReset.findUnique({ where: { token_hash: tokenHash } }),
  deleteReset: (tokenHash) => prisma.passwordReset.deleteMany({ where: { token_hash: tokenHash } }),
  deleteResetsForUser: (userId) => prisma.passwordReset.deleteMany({ where: { user_id: userId } }),

  // ---- profiles ----
  insertProfile: (userId, name, bio, skills, avatar, phone, city, listed, isActive, trackCode, codeExpiresAt, createdAt, updatedAt) =>
    prisma.profile
      .create({
        data: {
          user_id: userId,
          name,
          bio,
          skills,
          avatar,
          phone,
          city,
          listed: toBool(listed),
          is_active: toBool(isActive),
          track_code: trackCode,
          code_expires_at: BIG(codeExpiresAt),
          created_at: BIG(createdAt),
          updated_at: BIG(updatedAt),
        },
      })
      .then(profileOut),
  updateProfile: (name, bio, skills, avatar, phone, city, listed, isActive, updatedAt, id) =>
    prisma.profile.update({
      where: { id },
      data: {
        name,
        bio,
        skills,
        avatar,
        phone,
        city,
        listed: toBool(listed),
        is_active: toBool(isActive),
        updated_at: BIG(updatedAt),
      },
    }),
  updateProfileCode: (trackCode, codeExpiresAt, id) =>
    prisma.profile.update({
      where: { id },
      data: { track_code: trackCode, code_expires_at: BIG(codeExpiresAt) },
    }),
  findProfileById: (id) => prisma.profile.findUnique({ where: { id } }).then(profileOut),
  findProfileByUser: (userId) => prisma.profile.findUnique({ where: { user_id: userId } }).then(profileOut),
  findProfileByCode: (trackCode) =>
    prisma.profile.findFirst({ where: { track_code: trackCode } }).then(profileOut),
  listActiveProfilesPage: (userId, limit, offset) =>
    prisma.profile
      .findMany({
        where: { is_active: true, listed: true, user_id: { not: userId } },
        orderBy: { created_at: "desc" },
        take: limit,
        skip: offset,
      })
      .then((rows) => rows.map(profileOut)),
  listExpiredCodes: (now) =>
    prisma.profile.findMany({
      where: { code_expires_at: { lt: BIG(now) } },
      select: { id: true },
    }),
};

export default stmts;
