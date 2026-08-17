// Notifications verification (server-side).
// Boots the real server, exercises: CRUD, authorization, unread
// counts, mark-read, mark-all-read, lifecycle integration, message
// notification, review notification. Cleans up test users.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./db.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 4196;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;
const TEST_EMAIL_SUFFIX = "@notifications-test.com";

let ok = true;
function check(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  [" + extra + "]" : ""}`);
  if (!cond) ok = false;
}

async function request(pathname, { method = "GET", body, cookie, csrf } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") || "" };
}

async function register(name, email, password) {
  const r = await request("/api/auth/register", {
    method: "POST",
    body: { name, email, password },
  });
  const cookie = r.setCookie.split(";")[0];
  const csrf = r.data?.csrf;
  return { cookie, csrf, email };
}

const DEST = { lat: 6.55, lng: 3.45 };
const PICKUP = { lat: 6.5, lng: 3.4 };

async function main() {
  const stamp = Date.now();
  const password = "Correct-Horse-Battery-Staple!";

  // --- actors ---
  const cust = await register("Notif Cust", `cust-${stamp}${TEST_EMAIL_SUFFIX}`, password);
  const prov = await register("Notif Provider", `prov-${stamp}${TEST_EMAIL_SUFFIX}`, password);
  const stranger = await register("Notif Stranger", `stranger-${stamp}${TEST_EMAIL_SUFFIX}`, password);

  // Provider creates profile + service
  let r = await request("/api/profile", {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { name: "Notif Provider", listed: true },
  });
  check("provider creates profile", r.status === 201, `status=${r.status}`);
  const profileId = r.data?.id;
  await prisma.user.update({ where: { email: prov.email }, data: { role: "provider" } });

  r = await request("/api/services", {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { title: "Delivery", category: "logistics", priceAmount: 5000, priceCurrency: "GHS", priceUnit: "flat" },
  });
  check("provider creates service", r.status === 201, `status=${r.status}`);
  const serviceId = r.data?.id;

  // ====== 1. INITIAL STATE ======
  r = await request("/api/notifications", { cookie: cust.cookie });
  check("customer notifications empty initially", r.status === 200 && r.data.notifications.length === 0, `count=${r.data?.notifications?.length}`);

  r = await request("/api/notifications/unread", { cookie: cust.cookie });
  check("customer unread count is 0", r.status === 200 && r.data.count === 0, `count=${r.data?.count}`);

  // ====== 2. STRANGER CANNOT ACCESS ======
  r = await request("/api/notifications", { cookie: stranger.cookie });
  check("stranger has no notifications", r.status === 200 && r.data.notifications.length === 0);

  // ====== 3. BOOKING CREATION → PROVIDER NOTIFICATION ======
  r = await request("/api/bookings", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { personName: "Customer", pickup: PICKUP, destination: DEST, profileId, serviceId },
  });
  check("customer creates booking", r.status === 201, `status=${r.status}`);
  const bookingId = r.data?.id;

  // Provider should now have a BOOKING_REQUEST_RECEIVED notification
  r = await request("/api/notifications", { cookie: prov.cookie });
  check("provider has notification after booking request", r.status === 200 && r.data.notifications.length > 0, `count=${r.data?.notifications?.length}`);
  const provNotif = r.data.notifications[0];
  check("provider notification type is BOOKING_REQUEST_RECEIVED", provNotif.type === "BOOKING_REQUEST_RECEIVED", `type=${provNotif.type}`);
  check("provider notification has link", provNotif.link && provNotif.link.startsWith("/provider/requests/"), `link=${provNotif.link}`);
  check("provider notification has refType", provNotif.refType === "booking", `refType=${provNotif.refType}`);
  check("provider notification unread", provNotif.readAt === null);

  r = await request("/api/notifications/unread", { cookie: prov.cookie });
  check("provider unread count is 1", r.status === 200 && r.data.count === 1, `count=${r.data?.count}`);

  // ====== 4. MARK SINGLE AS READ ======
  r = await request(`/api/notifications/${provNotif.id}/read`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  check("mark single as read succeeds", r.status === 200 && r.data.readAt !== null, `readAt=${r.data?.readAt}`);

  r = await request("/api/notifications/unread", { cookie: prov.cookie });
  check("provider unread count is 0 after mark read", r.status === 200 && r.data.count === 0, `count=${r.data?.count}`);

  // ====== 5. PROVIDER ACCEPTS → CUSTOMER NOTIFICATION ======
  r = await request(`/api/bookings/${bookingId}/accept`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  check("provider accepts booking", r.status === 200, `status=${r.status}`);

  r = await request("/api/notifications", { cookie: cust.cookie });
  check("customer has notification after accept", r.status === 200 && r.data.notifications.length > 0, `count=${r.data?.notifications?.length}`);
  check("customer notification is BOOKING_ACCEPTED", r.data.notifications[0].type === "BOOKING_ACCEPTED", `type=${r.data.notifications[0].type}`);

  // ====== 6. MARK ALL AS READ ======
  r = await request("/api/notifications/read-all", { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("mark all read succeeds", r.status === 200 && r.data.ok === true, `marked=${r.data?.marked}`);

  r = await request("/api/notifications/unread", { cookie: cust.cookie });
  check("customer unread count is 0 after mark-all", r.status === 200 && r.data.count === 0, `count=${r.data?.count}`);

  // ====== 7. MESSAGING → NOTIFICATION ======
  // Provider starts the booking so messaging is allowed
  r = await request(`/api/bookings/${bookingId}/start`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  check("provider starts booking", r.status === 200, `status=${r.status}`);

  // Provider sends a message
  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { body: "Hello from provider!" },
  });
  check("provider sends message", r.status === 201, `status=${r.status}`);

  r = await request("/api/notifications", { cookie: cust.cookie });
  // Customer should have a MESSAGE_NEW notification (possibly along with the
  // BOOKING_ACCEPTED and BOOKING_EN_ROUTE we just created)
  const msgNotifs = r.data.notifications.filter((n) => n.type === "MESSAGE_NEW");
  check("customer has MESSAGE_NEW notification", msgNotifs.length > 0, `count=${msgNotifs.length}`);

  // ====== 8. CANCEL → NOTIFICATION ======
  // Provider arrives + begins so customer can cancel
  r = await request(`/api/bookings/${bookingId}/arrive`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  r = await request(`/api/bookings/${bookingId}/begin`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  r = await request(`/api/bookings/${bookingId}/complete`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  check("booking completed", r.status === 200, `status=${r.status}`);

  r = await request("/api/notifications", { cookie: cust.cookie });
  const completedNotifs = r.data.notifications.filter((n) => n.type === "BOOKING_COMPLETED");
  check("customer has BOOKING_COMPLETED notification", completedNotifs.length > 0);

  // ====== 9. REVIEW → NOTIFICATION ======
  r = await request(`/api/bookings/${bookingId}/review`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { rating: 5, comment: "Great service!" },
  });
  check("customer submits review", r.status === 201, `status=${r.status} err=${JSON.stringify(r.data)}`);

  r = await request("/api/notifications", { cookie: prov.cookie });
  const reviewNotifs = r.data.notifications.filter((n) => n.type === "REVIEW_RECEIVED");
  check("provider has REVIEW_RECEIVED notification", reviewNotifs.length > 0, `count=${reviewNotifs.length}`);
  check("review notification has correct refType", reviewNotifs[0].refType === "review", `refType=${reviewNotifs[0].refType}`);

  // ====== 10. PAGINATION ======
  r = await request("/api/notifications?limit=2&offset=0", { cookie: cust.cookie });
  check("pagination returns max 2", r.status === 200 && r.data.notifications.length <= 2, `count=${r.data?.notifications?.length}`);
  check("pagination includes unreadCount", typeof r.data.unreadCount === "number", `unreadCount=${r.data?.unreadCount}`);

  // ====== 11. INVALID MARK-READ ======
  r = await request("/api/notifications/999999/read", { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("mark non-existent notification → 404", r.status === 404, `status=${r.status}`);

  r = await request(`/api/notifications/${provNotif.id}/read`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("cannot mark another user's notification", r.status === 404, `status=${r.status}`);

  // ====== 12. STRANGER CANNOT MARK-READ ======
  r = await request("/api/notifications/read-all", { method: "POST", cookie: stranger.cookie, csrf: stranger.csrf });
  check("stranger mark-all returns 0 marked", r.status === 200 && r.data.marked === 0, `marked=${r.data?.marked}`);

  console.log(ok ? "\nALL NOTIFICATION CHECKS PASSED" : "\nSOME NOTIFICATION CHECKS FAILED");
  process.exitCode = ok ? 0 : 1;
}

let server = null;
if (!process.env.TEST_BASE) {
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  server = spawn(process.execPath, ["index.js"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ALLOWED_ORIGINS: BASE,
    },
    stdio: "ignore",
  });
  let up = false;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      await fetch(BASE + "/health");
      up = true;
      break;
    } catch {}
  }
  if (!up) {
    console.error(`Test server did not come up on ${BASE}`);
    process.exit(1);
  }
} else {
  console.log(`Attaching to external server at ${BASE}`);
  try {
    await fetch(BASE + "/health");
  } catch {
    console.error(`No server reachable at ${BASE}`);
    process.exit(1);
  }
}

try {
  await main();
} finally {
  if (server) {
    server.kill();
    server = null;
    await new Promise((r) => setTimeout(r, 300));
  }
  try {
    await prisma.user.deleteMany({ where: { email: { endsWith: TEST_EMAIL_SUFFIX } } });
  } catch { /* best effort */ }
  await prisma.$disconnect();
}
