// Phase 3, Step 4: provider request/inbox workflow verification.
// Customer selects a provider service → REQUESTED booking; the provider sees it
// in their inbox and accepts/rejects. Covers inbox isolation, authorization,
// guarded transitions, expiration races, duplicate requests, authoritative
// service/price attachment, and the live-tracking hand-off after acceptance.
// Cleans up every test user it creates.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";
import { prisma } from "./db.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 4196;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;
const SWEEP_MS = Number(process.env.TEST_SWEEP_MS) || 800;
const TEST_EMAIL_SUFFIX = "@workflow-test.com";

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

async function poll(fn, { timeout = 8000, interval = 150 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((res) => setTimeout(res, interval));
  }
  return last;
}

async function register(name, email, password, role = "customer") {
  const r = await request("/api/auth/register", {
    method: "POST",
    body: { name, email, password },
  });
  const cookie = r.setCookie.split(";")[0];
  const csrf = r.data?.csrf;
  if (role !== "customer") {
    await prisma.user.update({ where: { email }, data: { role } });
  }
  return { cookie, csrf, email };
}

const DEST = { lat: 6.55, lng: 3.45 };
const PICKUP = { lat: 6.5, lng: 3.4 };

async function main() {
  const stamp = Date.now();
  const password = "Correct-Horse-Battery-Staple!";

  // --- actors -----------------------------------------------------------
  const cust = await register("Workflow Cust", `wcust-${stamp}@workflow-test.com`, password);
  const provA = await register("Provider A", `wprova-${stamp}@workflow-test.com`, password, "provider");
  const provB = await register("Provider B", `wprovb-${stamp}@workflow-test.com`, password, "provider");

  let r = await request("/api/profile", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: { name: "Provider A", skills: ["errands"], listed: true } });
  const provAId = r.data?.id;
  check("provider A creates a profile", r.status === 201 && !!provAId, `status=${r.status}`);
  r = await request("/api/profile", { method: "POST", cookie: provB.cookie, csrf: provB.csrf, body: { name: "Provider B", skills: ["delivery"], listed: true } });
  const provBId = r.data?.id;
  check("provider B creates a profile", r.status === 201 && !!provBId, `status=${r.status}`);

  const mkService = (title, priceAmount) => ({ title, category: "other", priceAmount, priceCurrency: "GHS", priceUnit: "flat" });
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: mkService("Errand Run", 5000) });
  const S1 = r.data;
  check("provider A creates a service", r.status === 201 && !!S1?.id, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provB.cookie, csrf: provB.csrf, body: mkService("Courier", 8000) });
  const S2 = r.data;
  check("provider B creates a service", r.status === 201 && !!S2?.id, `status=${r.status}`);

  const inbox = (cookie) => request("/api/provider/bookings", { cookie });
  const getBooking = (id, cookie) => request(`/api/bookings/${id}`, { cookie });

  // ================= customer creates service requests =================
  const bookingBody = (extra = {}) => ({ personName: "Ada Lovelace", pickup: PICKUP, destination: DEST, note: "Please bring a bag", ...extra });

  // A1 → provA. The client also tries to force a price; the server must ignore it.
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provAId, serviceId: S1.id, priceAmount: 1 }) });
  const A1 = r.data;
  check("customer creates a service request → REQUESTED", r.status === 201 && A1.status === "REQUESTED" && !A1.acceptedAt, `status=${r.status} ${r.data?.error || ""}`);

  // ================= 18/19. service + authoritative price attached ======
  check("request carries the selected service", A1.serviceId === S1.id && A1.service?.id === S1.id && A1.service?.title === "Errand Run" && A1.service?.category === "other");
  check("authoritative price is preserved (client price ignored)", A1.priceAmount === 5000 && A1.priceCurrency === "GHS", `price=${A1.priceAmount}`);
  const dbA1 = await prisma.booking.findUnique({ where: { id: A1.id } });
  check("database row stores service id and price", dbA1?.service_id === S1.id && Number(dbA1?.price_amount) === 5000);

  // A2 → provB (isolation check needs a second provider).
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provBId, serviceId: S2.id }) });
  const A2 = r.data;
  check("customer creates a request for provider B", r.status === 201 && A2.status === "REQUESTED", `status=${r.status}`);

  // ================= 2/3/4. provider inbox isolation ===================
  r = await inbox(provA.cookie);
  check("provider A sees their request", r.status === 200 && r.data.some((b) => b.id === A1.id), `status=${r.status}`);
  check("provider A does NOT see provider B's request", r.data.length === 1 && !r.data.some((b) => b.id === A2.id), `count=${r.data.length}`);
  r = await inbox(provB.cookie);
  check("provider B sees their own request only", r.status === 200 && r.data.length === 1 && r.data.some((b) => b.id === A2.id) && !r.data.some((b) => b.id === A1.id), `count=${r.data.length}`);

  // ================= inbox payload completeness =========================
  const inboxItem = (await inbox(provA.cookie)).data.find((b) => b.id === A1.id);
  check("inbox carries decision-making info",
    !!inboxItem &&
    inboxItem.customer?.id &&
    inboxItem.customer?.name === "Workflow Cust" &&
    inboxItem.service?.id === S1.id &&
    inboxItem.priceAmount === 5000 &&
    inboxItem.priceCurrency === "GHS" &&
    inboxItem.pickup && inboxItem.destination &&
    inboxItem.note === "Please bring a bag" &&
    inboxItem.status === "REQUESTED" &&
    !!inboxItem.createdAt && !!inboxItem.expiresAt);
  check("inbox never leaks private auth data",
    !!inboxItem.profileId &&
    !inboxItem.customer?.email &&
    !inboxItem.password &&
    !inboxItem.session &&
    !inboxItem.csrf &&
    !inboxItem.resetToken &&
    !inboxItem.user?.email);

  // ================= authorization =====================================
  r = await inbox(cust.cookie);
  check("customer cannot access the provider inbox → 403", r.status === 403, `status=${r.status}`);
  r = await request(`/api/bookings/${A1.id}/accept`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("customer cannot accept (provider-only action) → 403", r.status === 403, `status=${r.status}`);
  r = await request(`/api/bookings/${A1.id}/reject`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("customer cannot reject (provider-only action) → 403", r.status === 403, `status=${r.status}`);
  r = await request(`/api/bookings/${A1.id}/start`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("customer cannot start (provider-only action) → 403", r.status === 403, `status=${r.status}`);
  r = await request(`/api/bookings/${A1.id}/accept`, { method: "POST", cookie: provB.cookie, csrf: provB.csrf });
  check("wrong provider cannot accept another provider's request → 403", r.status === 403, `status=${r.status} ${r.data?.error || ""}`);

  // ================= 5. accept → ACCEPTED ==============================
  r = await request(`/api/bookings/${A1.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider accepts the request → ACCEPTED", r.status === 200 && r.data.status === "ACCEPTED" && !!r.data.acceptedAt, `status=${r.status}`);
  r = await getBooking(A1.id, cust.cookie);
  check("customer sees the accepted status", r.status === 200 && r.data.status === "ACCEPTED" && r.data.acceptedAt, `status=${r.data?.status}`);

  // ================= 15. double accept → conflict ======================
  r = await request(`/api/bookings/${A1.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("double accept → 409 conflict", r.status === 409, `status=${r.status}`);

  // ================= 20. tracking only starts explicitly ===============
  const ws = io(BASE, { transports: ["websocket"] });
  await new Promise((res) => ws.on("connect", res));
  ws.emit("person:join", { bookingId: A1.id, token: A1.shareToken, personName: "Provider A" });
  await new Promise((res) => setTimeout(res, 300));
  ws.emit("location:update", { bookingId: A1.id, token: A1.shareToken, lat: PICKUP.lat + 0.001, lng: PICKUP.lng + 0.001, accuracy: 5, speed: 4 });
  await new Promise((res) => setTimeout(res, 400));
  r = await getBooking(A1.id, cust.cookie);
  check("location updates do not auto-start tracking after accept", r.data.status === "ACCEPTED", `status=${r.data?.status}`);

  r = await request(`/api/bookings/${A1.id}/start`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider explicitly starts → PROVIDER_EN_ROUTE", r.status === 200 && r.data.status === "PROVIDER_EN_ROUTE", `status=${r.status}`);

  ws.emit("location:update", { bookingId: A1.id, token: A1.shareToken, lat: DEST.lat + 0.0004, lng: DEST.lng + 0.0004, accuracy: 8, speed: 5 });
  const autoArrived = await poll(async () => {
    const b = await getBooking(A1.id, cust.cookie);
    return b.data?.status === "ARRIVED" ? "ARRIVED" : null;
  });
  check("auto-arrival still works after acceptance", autoArrived === "ARRIVED", `status=${autoArrived}`);
  ws.close();

  // ================= 14. completed cannot be accepted/rejected =========
  await request(`/api/bookings/${A1.id}/begin`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  await request(`/api/bookings/${A1.id}/complete`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  r = await request(`/api/bookings/${A1.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("completed booking cannot be accepted → 409", r.status === 409, `status=${r.status}`);
  r = await request(`/api/bookings/${A1.id}/reject`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("completed booking cannot be rejected → 409", r.status === 409, `status=${r.status}`);

  // ================= 6/8. reject → REJECTED ============================
  r = await request(`/api/bookings/${A2.id}/reject`, { method: "POST", cookie: provB.cookie, csrf: provB.csrf });
  check("provider rejects the request → REJECTED", r.status === 200 && r.data.status === "REJECTED", `status=${r.status}`);
  r = await getBooking(A2.id, cust.cookie);
  check("customer sees the rejected status", r.status === 200 && r.data.status === "REJECTED", `status=${r.data?.status}`);
  r = await request(`/api/bookings/${A2.id}/accept`, { method: "POST", cookie: provB.cookie, csrf: provB.csrf });
  check("rejected request cannot be accepted → 409", r.status === 409, `status=${r.status}`);

  // ================= 9. expired request cannot be accepted =============
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provAId, serviceId: S1.id }) });
  const A3 = r.data;
  await prisma.booking.update({ where: { id: A3.id }, data: { expires_at: BigInt(Date.now() - 1000) } });
  await new Promise((res) => setTimeout(res, 1200)); // let the sweeper expire it
  r = await request(`/api/bookings/${A3.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("expired request cannot be accepted → 409", r.status === 409 && /expired/i.test(r.data?.error || ""), `status=${r.status} ${r.data?.error || ""}`);

  // ================= 16. accept vs expire race =========================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provAId, serviceId: S1.id }) });
  const A4 = r.data;
  await prisma.booking.update({ where: { id: A4.id }, data: { expires_at: BigInt(Date.now() + 400) } });
  const acceptA4 = request(`/api/bookings/${A4.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  await new Promise((res) => setTimeout(res, 1600)); // at least two sweeps
  const accA4 = await acceptA4;
  r = await getBooking(A4.id, cust.cookie);
  check("accept vs expire: exactly one outcome wins",
    (r.data.status === "ACCEPTED" && accA4.status === 200) || (r.data.status === "EXPIRED" && accA4.status === 409),
    `status=${r.data?.status} accept=${accA4.status}`);
  if (r.data.status === "ACCEPTED") {
    await request(`/api/bookings/${A4.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  }

  // ================= 10. customer cancellation =========================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provAId, serviceId: S1.id }) });
  const A5 = r.data;
  r = await request(`/api/bookings/${A5.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("customer cancels their request → CANCELLED", r.status === 200 && r.data.status === "CANCELLED", `status=${r.status}`);

  // ================= 11. provider cancellation =========================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provAId, serviceId: S1.id }) });
  const A6 = r.data;
  await request(`/api/bookings/${A6.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  r = await request(`/api/bookings/${A6.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider cancels an accepted request → CANCELLED", r.status === 200 && r.data.status === "CANCELLED", `status=${r.status}`);

  // ================= 17. duplicate active request ======================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provBId, serviceId: S2.id }) });
  const A7 = r.data;
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provBId, serviceId: S2.id }) });
  check("duplicate active request is rejected → 409", r.status === 409, `status=${r.status} ${r.data?.error || ""}`);
  await request(`/api/bookings/${A7.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });

  // ================= inbox reflects lifecycle ==========================
  r = await inbox(provA.cookie);
  check("provider inbox reflects resolved lifecycle states",
    r.data.some((b) => b.id === A1.id && b.status === "COMPLETED") &&
    r.data.some((b) => b.id === A5.id && b.status === "CANCELLED"),
    `statuses=${r.data.map((b) => b.status).join(",")}`);

  console.log(ok ? "\nALL WORKFLOW CHECKS PASSED" : "\nSOME WORKFLOW CHECKS FAILED");
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
      REQUEST_SWEEP_MS: String(SWEEP_MS),
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
  } catch {
    /* best effort */
  }
  await prisma.$disconnect();
}
