// Admin & Moderation DB layer.
// Read helpers, write helpers, and audit-logging for the admin panel.
import { prisma } from "./db.js";

const BIG = (v) => (v == null ? null : BigInt(v));
const NUM = (v) => (v == null ? null : Number(v));

// Recursively convert BigInt → Number and Prisma Decimal → Number so
// res.json() never hits "BigInt can't be serialized".
function sanitize(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  if (typeof obj === "bigint") return Number(obj);
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "bigint" ? Number(v) : (v != null && typeof v === "object" ? sanitize(v) : v);
  }
  return out;
}

function userOut(u) {
  if (!u) return u;
  return { ...u, created_at: NUM(u.created_at), locked_until: NUM(u.locked_until) };
}

function profileOut(p) {
  if (!p) return p;
  return {
    ...p,
    created_at: NUM(p.created_at),
    updated_at: NUM(p.updated_at),
    code_expires_at: NUM(p.code_expires_at),
    listed: !!p.listed,
    is_active: !!p.is_active,
    verified: !!p.verified,
  };
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
    person_online: !!b.person_online,
  };
}

function serviceOut(s) {
  if (!s) return s;
  return {
    ...s,
    created_at: NUM(s.created_at),
    updated_at: NUM(s.updated_at),
    active: !!s.active,
  };
}

function reportOut(r) {
  if (!r) return r;
  return {
    ...r,
    created_at: NUM(r.created_at),
    reviewed_at: NUM(r.reviewed_at),
  };
}

function auditOut(a) {
  if (!a) return a;
  return { ...a, created_at: NUM(a.created_at) };
}

// ---------------- Dashboard ----------------

export async function getDashboardStats() {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const [
    totalUsers,
    totalProviders,
    totalBookings,
    bookingsLast30d,
    openReports,
    recentAuditCount,
    revenueAgg,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: { in: ["provider", "both"] } } }),
    prisma.booking.count(),
    prisma.booking.count({ where: { created_at: { gte: BIG(thirtyDaysAgo) } } }),
    prisma.report.count({ where: { status: "OPEN" } }),
    prisma.auditLog.count({ where: { created_at: { gte: BIG(thirtyDaysAgo) } } }),
    prisma.booking.aggregate({
      where: { payment_status: "PAID" },
      _sum: { price_amount: true, platform_fee: true },
    }),
  ]);

  return {
    totalUsers,
    totalProviders,
    totalBookings,
    bookingsLast30d,
    openReports,
    recentAuditCount,
    totalRevenue: Number(revenueAgg._sum.price_amount || 0),
    totalPlatformFees: Number(revenueAgg._sum.platform_fee || 0),
  };
}

// ---------------- Users ----------------

export async function listUsersPage({ search, role, status, limit, offset }) {
  const where = {};
  if (search) {
    const like = `%${search}%`;
    where.OR = [{ name: { contains: like, mode: "insensitive" } }, { email: { contains: like, mode: "insensitive" } }];
  }
  if (role) where.role = role;
  if (status) where.status = status;

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
      include: { profiles: { select: { id: true, name: true, is_active: true, verified: true } } },
    }),
    prisma.user.count({ where }),
  ]);
  return { users: rows.map(userOut).map((u) => ({ ...u, profiles: u.profiles })), total };
}

export async function getUserDetail(id) {
  const u = await prisma.user.findUnique({
    where: { id },
    include: {
      profiles: true,
      bookings: {
        orderBy: { created_at: "desc" },
        take: 20,
      },
      reviews: {
        orderBy: { created_at: "desc" },
        take: 20,
      },
    },
  });
  return u ? sanitize(u) : null;
}

export async function setUserStatus(userId, status) {
  return prisma.user.update({ where: { id: userId }, data: { status } }).then(userOut);
}

export async function setUserRole(userId, role) {
  return prisma.user.update({ where: { id: userId }, data: { role } }).then(userOut);
}

// ---------------- Providers ----------------

export async function listProvidersPage({ search, verified, listed, limit, offset }) {
  const where = { role: { in: ["provider", "both"] } };
  if (search) {
    const like = `%${search}%`;
    where.OR = [
      { name: { contains: like, mode: "insensitive" } },
      { email: { contains: like, mode: "insensitive" } },
      { profiles: { some: { name: { contains: like, mode: "insensitive" } } } },
    ];
  }
  const profileFilter = {};
  if (verified === "true") profileFilter.verified = true;
  else if (verified === "false") profileFilter.verified = false;
  if (listed === "true") profileFilter.listed = true;
  else if (listed === "false") profileFilter.listed = false;
  if (Object.keys(profileFilter).length > 0) where.profiles = { some: profileFilter };

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
      include: {
        profiles: {
          select: { id: true, name: true, city: true, is_active: true, listed: true, verified: true, rating_avg: true, rating_count: true },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);
  return { providers: rows.map(userOut), total };
}

export async function getProviderDetail(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      profiles: {
        include: {
          services: { orderBy: { created_at: "desc" } },
          reviews: { orderBy: { created_at: "desc" }, take: 50 },
          availability: { orderBy: { dow: "asc" } },
        },
      },
      bookings: { orderBy: { created_at: "desc" }, take: 30 },
    },
  });
  if (!user) return null;
  return sanitize({
    ...userOut(user),
    profiles: user.profiles.map(profileOut).map((p) => ({
      ...p,
      services: (p.services || []).map(serviceOut),
      reviews: p.reviews || [],
      availability: p.availability || [],
    })),
  });
}

export async function setProviderVerified(profileId, verified) {
  return prisma.profile.update({ where: { id: profileId }, data: { verified } }).then(profileOut);
}

export async function setProviderListed(profileId, listed) {
  return prisma.profile.update({ where: { id: profileId }, data: { listed } }).then(profileOut);
}

export async function setProviderActive(profileId, isActive) {
  return prisma.profile.update({ where: { id: profileId }, data: { is_active: isActive } }).then(profileOut);
}

// ---------------- Bookings ----------------

export async function listBookingsPage({ status, profileId, userId, limit, offset }) {
  const where = {};
  if (status) where.status = status;
  if (profileId) where.profile_id = profileId;
  if (userId) where.user_id = userId;

  const [rows, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
      include: {
        user: { select: { id: true, name: true, email: true } },
        profile: { select: { id: true, name: true } },
        service: { select: { id: true, title: true, category: true } },
      },
    }),
    prisma.booking.count({ where }),
  ]);
  return { bookings: rows.map(bookingOut), total };
}

export async function getBookingDetail(id) {
  const b = await prisma.booking.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true } },
      profile: { select: { id: true, name: true, user_id: true } },
      service: { select: { id: true, title: true, category: true, description: true, price_unit: true } },
      reviews: true,
      messages: { orderBy: { created_at: "desc" }, take: 50 },
    },
  });
  return b ? sanitize(b) : null;
}

// ---------------- Payments ----------------

export async function listPaymentsPage({ paymentStatus, limit, offset }) {
  const where = {};
  if (paymentStatus) where.payment_status = paymentStatus;
  else where.payment_status = { not: "UNPAID" };

  const [rows, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
      include: {
        user: { select: { id: true, name: true, email: true } },
        profile: { select: { id: true, name: true } },
        service: { select: { id: true, title: true, category: true } },
      },
    }),
    prisma.booking.count({ where }),
  ]);
  return { payments: rows.map(bookingOut), total };
}

// ---------------- Reviews ----------------

export async function listReviewsPage({ hidden, profileId, limit, offset }) {
  const where = {};
  if (hidden === "true") where.hidden = true;
  else if (hidden === "false") where.hidden = false;
  if (profileId) where.profile_id = profileId;

  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
      include: {
        user: { select: { id: true, name: true, email: true } },
        profile: { select: { id: true, name: true } },
        booking: { select: { id: true, code: true } },
      },
    }),
    prisma.review.count({ where }),
  ]);
  return { reviews: sanitize(rows), total };
}

export async function setReviewHidden(reviewId, hidden, hiddenReason) {
  const r = await prisma.review.update({
    where: { id: reviewId },
    data: { hidden, hidden_reason: hidden ? hiddenReason || null : null },
  });
  return sanitize(r);
}

// ---------------- Reports ----------------

export async function createReport({ reporterId, targetType, targetId, reason }) {
  return prisma.report.create({
    data: {
      reporter_id: reporterId,
      target_type: targetType,
      target_id: String(targetId),
      reason,
      created_at: BigInt(Date.now()),
    },
  }).then(reportOut);
}

export async function listReportsPage({ status, targetType, limit, offset }) {
  const where = {};
  if (status) where.status = status;
  if (targetType) where.target_type = targetType;

  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        reviewer: { select: { id: true, name: true } },
      },
    }),
    prisma.report.count({ where }),
  ]);
  return { reports: rows.map(reportOut), total };
}

export async function updateReportStatus(reportId, status, reviewedBy) {
  return prisma.report.update({
    where: { id: reportId },
    data: {
      status,
      reviewed_by: reviewedBy,
      reviewed_at: BigInt(Date.now()),
    },
  }).then(reportOut);
}

// ---------------- Audit Log ----------------

export async function createAuditLog({ adminId, action, targetType, targetId, meta }) {
  return prisma.auditLog.create({
    data: {
      admin_id: adminId,
      action,
      target_type: targetType,
      target_id: String(targetId),
      meta: meta ? JSON.stringify(meta) : null,
      created_at: BigInt(Date.now()),
    },
  }).then(auditOut);
}

export async function listAuditLogsPage({ adminId, action, limit, offset }) {
  const where = {};
  if (adminId) where.admin_id = adminId;
  if (action) where.action = action;

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
      skip: offset,
      include: { admin: { select: { id: true, name: true, email: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { logs: rows.map(auditOut), total };
}
