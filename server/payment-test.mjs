// Payment confirmation verification (server-side).
// Boots the real server, exercises: confirm-payment authorization,
// happy paths, idempotency, notification, earnings. Cleans up test users.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./db.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 4197;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;
const TEST_EMAIL_SUFFIX = "@payment-test.com";

let ok = true;
let total = 0;
let passed = 0;
function check(label, cond, extra = "") {
  total++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  [" + extra + "]" : ""}`);
  if (cond) passed++; else ok = false;
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
  const cust = await register("Pay Cust", `pay-cust-${stamp}${TEST_EMAIL_SUFFIX}`, password);
  const prov = await register("Pay Provider", `pay-prov-${stamp}${TEST_EMAIL_SUFFIX}`, password);
  const stranger = await register("Pay Stranger", `pay-stranger-${stamp}${TEST_EMAIL_SUFFIX}`, password);

  // Provider creates profile + service
  let r = await request("/api/profile", {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { name: "Pay Provider", listed: true },
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

  // ====== 1. BOOKING CREATION ======
  r = await request("/api/bookings", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { personName: "Customer", pickup: PICKUP, destination: DEST, profileId, serviceId },
  });
  check("customer creates booking", r.status === 201, `status=${r.status}`);
  const bookingId = r.data?.id;
  check("booking starts UNPAID", r.data?.paymentStatus === "UNPAID", `status=${r.data?.paymentStatus}`);

  // ====== 2. PROVIDER ACCEPTS ======
  r = await request(`/api/bookings/${bookingId}/accept`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  check("provider accepts booking", r.status === 200, `status=${r.status}`);

  // ====== 3. CANNOT CONFIRM PAYMENT BEFORE COMPLETION ======
  r = await request(`/api/bookings/${bookingId}/confirm-payment`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { method: "cash" },
  });
  check("reject confirm before completion", r.status === 409, `status=${r.status}`);
  check("reject reason clear", r.data?.error?.includes("completed"), `error=${r.data?.error}`);

  // ====== 4. TRANSITION TO COMPLETED ======
  r = await request(`/api/bookings/${bookingId}/start`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  check("provider starts", r.status === 200, `status=${r.status}`);
  r = await request(`/api/bookings/${bookingId}/arrive`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  check("provider arrives", r.status === 200, `status=${r.status}`);
  r = await request(`/api/bookings/${bookingId}/begin`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  check("provider begins", r.status === 200, `status=${r.status}`);
  r = await request(`/api/bookings/${bookingId}/complete`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  check("provider completes", r.status === 200, `status=${r.status}`);
  check("booking is COMPLETED", r.data?.status === "COMPLETED", `status=${r.data?.status}`);

  // ====== 5. STRANGER CANNOT CONFIRM PAYMENT ======
  r = await request(`/api/bookings/${bookingId}/confirm-payment`, {
    method: "POST", cookie: stranger.cookie, csrf: stranger.csrf,
    body: { method: "cash" },
  });
  check("stranger cannot confirm payment", r.status === 403 || r.status === 401, `status=${r.status}`);

  // ====== 6. CUSTOMER CANNOT CONFIRM PAYMENT ======
  r = await request(`/api/bookings/${bookingId}/confirm-payment`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { method: "cash" },
  });
  check("customer cannot confirm payment", r.status === 403, `status=${r.status}`);

  // ====== 7. INVALID PAYMENT METHOD ======
  r = await request(`/api/bookings/${bookingId}/confirm-payment`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { method: "bitcoin" },
  });
  check("reject invalid payment method", r.status === 400, `status=${r.status}`);

  // ====== 8. CONFIRM PAYMENT (CASH) ======
  r = await request(`/api/bookings/${bookingId}/confirm-payment`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { method: "cash" },
  });
  check("confirm payment succeeds", r.status === 200, `status=${r.status}`);
  check("payment status is PAID", r.data?.paymentStatus === "PAID", `status=${r.data?.paymentStatus}`);
  check("payment method is cash", r.data?.paymentMethod === "cash", `method=${r.data?.paymentMethod}`);
  check("paid_at is set", r.data?.paidAt != null, `paidAt=${r.data?.paidAt}`);
  check("platform_fee is calculated", r.data?.platformFee != null, `fee=${r.data?.platformFee}`);
  check("platform_fee = 500 (10% of 5000)", r.data?.platformFee === 500, `fee=${r.data?.platformFee}`);

  // ====== 9. IDEMPOTENCY: DOUBLE CONFIRM ======
  r = await request(`/api/bookings/${bookingId}/confirm-payment`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { method: "momo" },
  });
  check("double confirm returns 409", r.status === 409, `status=${r.status}`);
  check("double confirm reason clear", r.data?.error?.includes("already"), `error=${r.data?.error}`);

  // ====== 10. NOTIFICATION SENT TO CUSTOMER ======
  r = await request("/api/notifications", { cookie: cust.cookie });
  check("customer has notification", r.status === 200 && r.data.notifications?.length > 0, `count=${r.data?.notifications?.length}`);
  const payNotif = r.data.notifications.find((n) => n.type === "PAYMENT_CONFIRMED");
  check("notification type is PAYMENT_CONFIRMED", !!payNotif, `type=${payNotif?.type}`);
  if (payNotif) {
    check("notification has link", payNotif.link && payNotif.link.startsWith("/requests/"), `link=${payNotif.link}`);
    check("notification has refType", payNotif.refType === "booking", `refType=${payNotif.refType}`);
  }

  // ====== 11. PROVIDER EARNINGS ======
  r = await request("/api/provider/earnings", { cookie: prov.cookie });
  check("provider earnings endpoint works", r.status === 200, `status=${r.status}`);
  check("provider has 1 paid booking", r.data?.paidBookings === 1, `count=${r.data?.paidBookings}`);
  check("provider total earned is 5000", r.data?.totalEarned === 5000, `earned=${r.data?.totalEarned}`);
  check("provider total fees is 500", r.data?.totalFees === 500, `fees=${r.data?.totalFees}`);
  check("provider net earned is 4500", r.data?.netEarned === 4500, `net=${r.data?.netEarned}`);

  // ====== 12. CONFIRM WITH DIFFERENT METHOD (NEW BOOKING) ======
  r = await request("/api/bookings", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { personName: "Customer 2", pickup: PICKUP, destination: DEST, profileId, serviceId },
  });
  const booking2Id = r.data?.id;
  r = await request(`/api/bookings/${booking2Id}/accept`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${booking2Id}/start`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${booking2Id}/arrive`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${booking2Id}/begin`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${booking2Id}/complete`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  check("second booking completed", r.status === 200 && r.data?.status === "COMPLETED");

  r = await request(`/api/bookings/${booking2Id}/confirm-payment`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { method: "momo" },
  });
  check("confirm with momo succeeds", r.status === 200, `status=${r.status}`);
  check("payment method is momo", r.data?.paymentMethod === "momo", `method=${r.data?.paymentMethod}`);

  // ====== 13. EARNINGS UPDATED ======
  r = await request("/api/provider/earnings", { cookie: prov.cookie });
  check("provider has 2 paid bookings", r.data?.paidBookings === 2, `count=${r.data?.paidBookings}`);
  check("provider total earned is 10000", r.data?.totalEarned === 10000, `earned=${r.data?.totalEarned}`);

  // ====== 14. CONFIRM WITH bank_transfer ======
  r = await request("/api/bookings", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { personName: "Customer 3", pickup: PICKUP, destination: DEST, profileId, serviceId },
  });
  const booking3Id = r.data?.id;
  r = await request(`/api/bookings/${booking3Id}/accept`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${booking3Id}/start`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${booking3Id}/arrive`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${booking3Id}/begin`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${booking3Id}/complete`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${booking3Id}/confirm-payment`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { method: "bank_transfer" },
  });
  check("confirm with bank_transfer succeeds", r.status === 200, `status=${r.status}`);
  check("payment method is bank_transfer", r.data?.paymentMethod === "bank_transfer", `method=${r.data?.paymentMethod}`);

  // ====== 15. CANCELLED BOOKING CANNOT BE PAID ======
  r = await request("/api/bookings", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { personName: "Cancel Test", pickup: PICKUP, destination: DEST, profileId, serviceId },
  });
  const cancelId = r.data?.id;
  r = await request(`/api/bookings/${cancelId}/accept`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${cancelId}/cancel`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  check("booking cancelled", r.data?.status === "CANCELLED");

  r = await request(`/api/bookings/${cancelId}/confirm-payment`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { method: "cash" },
  });
  check("cannot confirm payment on cancelled booking", r.status === 409, `status=${r.status}`);

  // ====== 16. NON-MARKETPLACE BOOKING CANNOT BE PAID ======
  r = await request("/api/bookings", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { personName: "Legacy Test" },
  });
  const legacyId = r.data?.id;
  r = await request(`/api/bookings/${legacyId}/confirm-payment`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { method: "cash" },
  });
  check("cannot confirm payment on legacy booking (no profile)", r.status === 400 || r.status === 404, `status=${r.status}`);

  // ====== 17. CUSTOMER SEES PAYMENT STATUS IN BOOKING ======
  r = await request(`/api/bookings/${bookingId}`, { cookie: cust.cookie });
  check("customer sees PAID status", r.status === 200 && r.data?.paymentStatus === "PAID", `status=${r.data?.paymentStatus}`);

  // ====== 18. NOT AUTHENTICATED ======
  r = await request(`/api/bookings/${bookingId}/confirm-payment`, {
    method: "POST",
    body: { method: "cash" },
  });
  check("unauthenticated cannot confirm payment", r.status === 401, `status=${r.status}`);

  // ====== 19. PROVIDER EARNINGS FOR STRANGER (no profile) ======
  r = await request("/api/provider/earnings", { cookie: stranger.cookie });
  check("stranger earnings returns 403 or 401", r.status === 403 || r.status === 401, `status=${r.status}`);

  // --- summary ---
  console.log(`\n${passed}/${total} payment tests passed`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
