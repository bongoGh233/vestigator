import { prisma } from "./db.js";

const BIG = (v) => (v == null ? null : BigInt(v));
const NUM = (v) => (v == null ? null : Number(v));

export const NOTIFICATION_PAGE_MAX = 50;

export const NOTIFICATION_TYPES = {
  BOOKING_REQUEST_RECEIVED: "BOOKING_REQUEST_RECEIVED",
  BOOKING_ACCEPTED: "BOOKING_ACCEPTED",
  BOOKING_REJECTED: "BOOKING_REJECTED",
  BOOKING_EN_ROUTE: "BOOKING_EN_ROUTE",
  BOOKING_ARRIVED: "BOOKING_ARRIVED",
  BOOKING_SERVICE_STARTED: "BOOKING_SERVICE_STARTED",
  BOOKING_COMPLETED: "BOOKING_COMPLETED",
  BOOKING_CANCELLED: "BOOKING_CANCELLED",
  BOOKING_EXPIRED: "BOOKING_EXPIRED",
  MESSAGE_NEW: "MESSAGE_NEW",
  REVIEW_RECEIVED: "REVIEW_RECEIVED",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
};

function notificationOut(n) {
  if (!n) return n;
  return {
    id: n.id,
    userId: n.user_id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    refType: n.ref_type,
    refId: n.ref_id,
    readAt: NUM(n.read_at),
    createdAt: NUM(n.created_at),
  };
}

export async function createNotification(userId, { type, title, body, link, refType, refId }) {
  const now = Date.now();
  const row = await prisma.notification.create({
    data: {
      user_id: userId,
      type,
      title,
      body,
      link: link ?? null,
      ref_type: refType ?? null,
      ref_id: refId != null ? String(refId) : null,
      created_at: BIG(now),
    },
  });
  return notificationOut(row);
}

export async function markNotificationRead(notificationId, userId) {
  const row = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!row || row.user_id !== userId) return null;
  if (row.read_at != null) return notificationOut(row);
  const now = Date.now();
  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: { read_at: BIG(now) },
  });
  return notificationOut(updated);
}

export async function markAllNotificationsRead(userId, now) {
  return prisma.notification.updateMany({
    where: { user_id: userId, read_at: null },
    data: { read_at: BIG(now) },
  });
}

export async function listNotificationsPage(userId, limit, offset) {
  const rows = await prisma.notification.findMany({
    where: { user_id: userId },
    orderBy: { created_at: "desc" },
    take: limit,
    skip: offset,
  });
  return rows.map(notificationOut);
}

export async function countUnreadNotifications(userId) {
  return prisma.notification.count({
    where: { user_id: userId, read_at: null },
  });
}

export async function deleteOldNotifications(olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  return prisma.notification.deleteMany({
    where: { created_at: { lt: BIG(cutoff) } },
  });
}
