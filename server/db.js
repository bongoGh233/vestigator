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
  return {
    ...b,
    created_at: NUM(b.created_at),
    accepted_at: NUM(b.accepted_at),
    started_at: NUM(b.started_at),
    completed_at: NUM(b.completed_at),
    expires_at: NUM(b.expires_at),
    paid_at: NUM(b.paid_at),
    person_online: to01(b.person_online),
  };
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

function serviceOut(s) {
  if (!s) return s;
  return {
    ...s,
    created_at: NUM(s.created_at),
    updated_at: NUM(s.updated_at),
    active: to01(s.active),
  };
}

function availabilityOut(a) {
  if (!a) return a;
  return { ...a, active: to01(a.active) };
}

function messageOut(m) {
  if (!m) return m;
  return { ...m, created_at: NUM(m.created_at), read_at: NUM(m.read_at) };
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
  updateUserRole: (role, id) =>
    prisma.user.update({ where: { id }, data: { role } }).then(userOut),

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
  insertBooking: (id, userId, shareToken, code, personName, phone, note, pickup, destination, status, createdAt, personOnline, location, path, extra = {}) =>
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
          profile_id: extra.profileId ?? null,
          service_id: extra.serviceId ?? null,
          price_amount: extra.priceAmount ?? null,
          price_currency: extra.priceCurrency || "GHS",
          expires_at: extra.expiresAt != null ? BIG(extra.expiresAt) : null,
        },
      })
      .then(bookingOut),
  findBookingById: (id) =>
    prisma.booking
      .findUnique({
        where: { id },
        include: {
          service: { select: { id: true, title: true, category: true, description: true, price_unit: true } },
          profile: { select: { id: true, name: true } },
        },
      })
      .then(bookingOut),
  findBookingByUser: (id, userId) =>
    prisma.booking
      .findFirst({
        where: { id, user_id: userId },
        include: {
          service: { select: { id: true, title: true, category: true, description: true, price_unit: true } },
          profile: { select: { id: true, name: true } },
        },
      })
      .then(bookingOut),
  listBookingsByUserPage: (userId, limit, offset) =>
    prisma.booking
      .findMany({
        where: { user_id: userId },
        orderBy: { created_at: "desc" },
        take: limit,
        skip: offset,
        include: {
          service: { select: { id: true, title: true, category: true, description: true, price_unit: true } },
          profile: { select: { id: true, name: true } },
        },
      })
      .then((rows) => rows.map(bookingOut)),
  listBookingsByProfile: (profileId, limit, offset) =>
    prisma.booking
      .findMany({
        where: { profile_id: profileId },
        orderBy: { created_at: "desc" },
        take: limit,
        skip: offset,
        include: {
          user: { select: { id: true, name: true } },
          service: { select: { id: true, title: true, category: true, description: true, price_unit: true } },
          profile: { select: { id: true, name: true } },
        },
      })
      .then((rows) => rows.map((r) => ({ ...bookingOut(r), user: r.user, service: r.service, profile: r.profile }))),
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
  // Database-authoritative lifecycle transition. Only rows matching the current
  // status (and the requested guard conditions) are updated; callers check the
  // affected row count to detect races instead of trusting a pre-read state.
  transitionBooking: ({ id, fromStatuses, toStatus, data = {}, requireProfileId, requireUserId, requireNotExpired, now }) =>
    prisma.booking
      .updateMany({
        where: {
          id,
          status: { in: fromStatuses },
          ...(requireProfileId != null ? { profile_id: requireProfileId } : {}),
          ...(requireUserId != null ? { user_id: requireUserId } : {}),
          ...(requireNotExpired
            ? { OR: [{ expires_at: null }, { expires_at: { gt: BIG(now) } }] }
            : {}),
        },
        data: {
          status: toStatus,
          ...(data.accepted_at != null ? { accepted_at: BIG(data.accepted_at) } : {}),
          ...(data.started_at != null ? { started_at: BIG(data.started_at) } : {}),
          ...(data.completed_at != null ? { completed_at: BIG(data.completed_at) } : {}),
        },
      })
      .then((r) => r.count),
  setBookingStatus: (id, status) =>
    prisma.booking.update({ where: { id }, data: { status } }),
  setBookingOnline: (id, online) =>
    prisma.booking.update({ where: { id }, data: { person_online: toBool(online) } }),
  setBookingPersonName: (id, name) =>
    prisma.booking.update({ where: { id }, data: { person_name: name } }),
  updateBookingTracking: (id, personOnline, location, path) =>
    prisma.booking.update({
      where: { id },
      data: { person_online: toBool(personOnline), location, path },
    }),
  listExpiredRequests: (now) =>
    prisma.booking.findMany({
      where: { status: "REQUESTED", expires_at: { lt: BIG(now) } },
      select: { id: true },
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

  // ---- services ----
  findServiceById: (id) => prisma.service.findUnique({ where: { id } }).then(serviceOut),
  insertService: (profileId, title, description, category, priceAmount, priceCurrency, priceUnit, durationMin, createdAt) =>
    prisma.service
      .create({
        data: {
          profile_id: profileId,
          title,
          description,
          category,
          price_amount: priceAmount,
          price_currency: priceCurrency,
          price_unit: priceUnit,
          duration_min: durationMin,
          active: true,
          created_at: BIG(createdAt),
          updated_at: BIG(createdAt),
        },
      })
      .then(serviceOut),
  updateService: (id, fields, updatedAt) =>
    prisma.service
      .update({ where: { id }, data: { ...fields, updated_at: BIG(updatedAt) } })
      .then(serviceOut),
  deleteService: (id) => prisma.service.delete({ where: { id } }),
  countBookingsForService: (serviceId) => prisma.booking.count({ where: { service_id: serviceId } }),
  listServicesByProfile: (profileId, limit, offset) =>
    prisma.service
      .findMany({
        where: { profile_id: profileId },
        orderBy: { created_at: "desc" },
        take: limit,
        skip: offset,
      })
      .then((rows) => rows.map(serviceOut)),
  listActiveServicesByProfile: (profileId, limit, offset) =>
    prisma.service
      .findMany({
        where: { profile_id: profileId, active: true },
        orderBy: { created_at: "desc" },
        take: limit,
        skip: offset,
      })
      .then((rows) => rows.map(serviceOut)),
  // Public search across active services of listed, active providers. Plain
  // parameterized SQL so we can join the provider row and use ILIKE for the
  // category/area/text filters (accelerated by trigram GIN indexes). The
  // provider's service_area is TEXT holding JSON like {"city":"Accra","radiusKm":20};
  // area matches both profiles.city and the service_area city.
  listActiveServicesPage: ({ category, q, area, limit, offset }) => {
    const where = ["s.active = TRUE", "p.is_active = TRUE", "p.listed = TRUE"];
    const params = [];
    const bind = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (category) where.push(`s.category = ${bind(category)}`);
    if (q) {
      const like = bind(`%${q}%`);
      where.push(`(s.title ILIKE ${like} OR s.description ILIKE ${like})`);
    }
    if (area) {
      const like = bind(`%${area}%`);
      where.push(
        `(p.city ILIKE ${like} OR (p.service_area IS NOT NULL AND p.service_area ~ '^\\{' AND (p.service_area::jsonb->>'city') ILIKE ${like}))`
      );
    }
    const sql = `SELECT s.id, s.profile_id, s.title, s.description, s.category,
      s.price_amount, s.price_currency, s.price_unit, s.duration_min, s.active,
      s.created_at, s.updated_at, p.name AS profile_name, p.rating_avg, p.rating_count
      FROM services s JOIN profiles p ON p.id = s.profile_id
      WHERE ${where.join(" AND ")}
      ORDER BY s.created_at DESC
      LIMIT ${bind(limit)} OFFSET ${bind(offset)}`;
    return prisma.$queryRawUnsafe(sql, ...params).then((rows) =>
      rows.map((r) => ({
        ...serviceOut(r),
        profile_name: r.profile_name,
        rating_avg: r.rating_avg,
        rating_count: r.rating_count,
      }))
    );
  },

  // ---- availability ----
  // Weekly windows for a provider profile. The caller owns validation (day,
  // bounds, overlap); the DB CHECKs remain the final gate for any bad row.
  listAvailability: (profileId) =>
    prisma.availability
      .findMany({
        where: { profile_id: profileId },
        orderBy: [{ dow: "asc" }, { start_min: "asc" }],
      })
      .then((rows) => rows.map(availabilityOut)),
  listActiveAvailability: (profileId) =>
    prisma.availability
      .findMany({
        where: { profile_id: profileId, active: true },
        orderBy: [{ dow: "asc" }, { start_min: "asc" }],
      })
      .then((rows) => rows.map(availabilityOut)),
  // Replace-all semantics inside one transaction so a concurrent update can
  // never leave a partially-written weekly schedule.
  replaceAvailability: (profileId, timezone, rows, updatedAt) =>
    prisma.$transaction([
      prisma.profile.update({
        where: { id: profileId },
        data: { timezone, updated_at: BIG(updatedAt) },
      }),
      prisma.availability.deleteMany({ where: { profile_id: profileId } }),
      ...(rows.length > 0
        ? [
            prisma.availability.createMany({
              data: rows.map((r) => ({
                profile_id: profileId,
                dow: r.dow,
                start_min: r.start_min,
                end_min: r.end_min,
                active: r.active,
              })),
            }),
          ]
        : []),
    ]),

  // ---- messages ----
  insertMessage: (bookingId, senderId, body, createdAt) =>
    prisma.message
      .create({
        data: {
          booking_id: bookingId,
          sender_id: senderId,
          body,
          created_at: BIG(createdAt),
        },
      })
      .then(messageOut),
  findMessageById: (id) => prisma.message.findUnique({ where: { id } }).then(messageOut),
  listMessagesPage: (bookingId, before, limit) =>
    prisma.message
      .findMany({
        where: {
          booking_id: bookingId,
          ...(before != null ? { id: { lt: before } } : {}),
        },
        orderBy: { id: "desc" },
        take: limit,
        include: { sender: { select: { id: true, name: true } } },
      })
      .then((rows) => rows.map((r) => ({ ...messageOut(r), sender: r.sender }))),
  markMessagesRead: (bookingId, readerId, now) =>
    prisma.message.updateMany({
      where: {
        booking_id: bookingId,
        sender_id: { not: readerId },
        read_at: null,
      },
      data: { read_at: BIG(now) },
    }),
  countUnreadByBooking: (bookingId, readerId) =>
    prisma.message.count({
      where: {
        booking_id: bookingId,
        sender_id: { not: readerId },
        read_at: null,
      },
    }),

  // ---- payments (manual) ----
  confirmBookingPayment: (bookingId, paymentMethod, paidAt, platformFee) =>
    prisma.booking.update({
      where: { id: bookingId },
      data: {
        payment_status: "PAID",
        payment_method: paymentMethod,
        paid_at: BIG(paidAt),
        platform_fee: platformFee,
      },
    }).then(bookingOut),
  countProviderEarningsPage: (profileId) =>
    prisma.booking.count({
      where: { profile_id: profileId, payment_status: "PAID" },
    }),
  sumProviderEarningsPage: (profileId) =>
    prisma.booking.aggregate({
      where: { profile_id: profileId, payment_status: "PAID" },
      _sum: { price_amount: true, platform_fee: true },
    }),
};

export default stmts;
