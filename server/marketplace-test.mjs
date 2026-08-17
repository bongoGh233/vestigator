// Marketplace booking state-machine verification (server-side).
// Boots the real server against the configured PostgreSQL database, then
// exercises the authoritative lifecycle: creation → accept/reject → en-route →
// arrive → in-progress → complete, cancellation, expiration (sweeper), review,
// authorization, duplicate/concurrent conflicts, and Socket.IO vs HTTP races.
// Cleans up every test user it creates.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";
import { prisma } from "./db.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 4198;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;
const SWEEP_MS = Number(process.env.TEST_SWEEP_MS) || 800;
const TEST_EMAIL_SUFFIX = "@marketplace-test.com";

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
const mkBookingBody = (profileId, extra = {}) => ({
  personName: "Ada Lovelace",
  pickup: PICKUP,
  destination: DEST,
  profileId,
  ...extra,
});

async function main() {
  const stamp = Date.now();
  const password = "Correct-Horse-Battery-Staple!";

  // --- actors -----------------------------------------------------------
  const cust = await register("Market Cust", `cust-${stamp}@marketplace-test.com`, password);
  const provA = await register("Provider A", `prova-${stamp}@marketplace-test.com`, password, "provider");
  const provB = await register("Provider B", `provb-${stamp}@marketplace-test.com`, password, "provider");
  const stranger = await register("Stranger", `stranger-${stamp}@marketplace-test.com`, password);

  let r = await request("/api/profile", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: { name: "Provider A", skills: ["errands"], listed: true } });
  const provAProfileId = r.data?.id;
  check("provider A creates a profile", r.status === 201 && !!provAProfileId);
  r = await request("/api/profile", { method: "POST", cookie: provB.cookie, csrf: provB.csrf, body: { name: "Provider B", skills: ["delivery"], listed: true } });
  const provBProfileId = r.data?.id;
  check("provider B creates a profile", r.status === 201 && !!provBProfileId);

  const getBooking = (id, cookie) => request(`/api/bookings/${id}`, { cookie });
  const providerList = () => request("/api/provider/bookings", { cookie: provA.cookie });
  const findStatus = async (id, list = providerList) => {
    const l = await list();
    const b = l.data?.find?.((x) => x.id === id);
    return b ? b.status : null;
  };

  // ================= 1. customer creates REQUESTED booking ==============
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R1 = r.data;
  check("customer creates REQUESTED booking", r.status === 201 && R1.status === "REQUESTED", `status=${r.status}`);
  check("request carries provider profile + deadline", !!R1.profileId && !!R1.expiresAt && R1.profileId === provAProfileId);
  check("provider is NOT auto-accepted", R1.status === "REQUESTED" && !R1.acceptedAt);

  // ================= 2. provider sees the incoming request ==============
  r = await providerList();
  check("provider sees incoming request", r.status === 200 && r.data.some((b) => b.id === R1.id && b.status === "REQUESTED"));
  check("provider sees customer info", r.status === 200 && r.data.some((b) => b.id === R1.id && b.customer?.id));

  // ================= 13/14. authorization ===============================
  r = await request(`/api/bookings/${R1.id}/accept`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("customer cannot accept (role gate) → 403", r.status === 403, `status=${r.status}`);
  r = await request(`/api/bookings/${R1.id}/accept`, { method: "POST", cookie: provB.cookie, csrf: provB.csrf });
  check("unassigned provider cannot accept → 403", r.status === 403, `status=${r.status}`);
  r = await request(`/api/bookings/${R1.id}`, { cookie: stranger.cookie });
  check("stranger cannot read the booking → 404", r.status === 404, `status=${r.status}`);

  // ================= 7/8. expiration ====================================
  await prisma.booking.update({ where: { id: R1.id }, data: { expires_at: BigInt(Date.now() - 1000) } });
  r = await request(`/api/bookings/${R1.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("accepting an expired request → 409", r.status === 409, `status=${r.status} ${r.data?.error || ""}`);
  const swept = await poll(() => findStatus(R1.id));
  check("sweeper expires the REQUESTED booking → EXPIRED", swept === "EXPIRED", `status=${swept}`);

  // ================= 9. customer cancellation (REQUESTED) ===============
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R2 = r.data;
  r = await request(`/api/bookings/${R2.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("customer cancels a REQUESTED booking", r.status === 200 && r.data.status === "CANCELLED", `status=${r.status}`);

  // ================= 20. duplicate request ==============================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R3 = r.data;
  check("customer creates a new request", r.status === 201, `status=${r.status}`);
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  check("duplicate request to same provider → 409", r.status === 409, `status=${r.status} ${r.data?.error || ""}`);

  // ================= 4. provider rejection ==============================
  r = await request(`/api/bookings/${R3.id}/reject`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider rejects the request → REJECTED", r.status === 200 && r.data.status === "REJECTED", `status=${r.status}`);
  r = await request(`/api/bookings/${R3.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("accepting a rejected request → 409", r.status === 409, `status=${r.status}`);

  // ================= 27. different provider =============================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provBProfileId) });
  const R4 = r.data;
  check("request to a different provider succeeds", r.status === 201 && r.data.profileId === provBProfileId, `status=${r.status}`);
  await request(`/api/bookings/${R4.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });

  // ================= 10. customer cancellation (ACCEPTED) ===============
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R5 = r.data;
  r = await request(`/api/bookings/${R5.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider accepts → ACCEPTED", r.status === 200 && r.data.status === "ACCEPTED" && !!r.data.acceptedAt, `status=${r.status}`);
  r = await request(`/api/bookings/${R5.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("double accept → 409", r.status === 409, `status=${r.status}`);
  r = await request(`/api/bookings/${R5.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("customer cancels an ACCEPTED booking", r.status === 200 && r.data.status === "CANCELLED", `status=${r.status}`);

  // ================= 11. provider cancellation (ACCEPTED) ===============
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R6 = r.data;
  await request(`/api/bookings/${R6.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  r = await request(`/api/bookings/${R6.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider cancels an ACCEPTED booking", r.status === 200 && r.data.status === "CANCELLED", `status=${r.status}`);

  // ================= 15. invalid transition (start before accept) =======
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R7 = r.data;
  r = await request(`/api/bookings/${R7.id}/start`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("start before accept → 409", r.status === 409, `status=${r.status}`);
  await request(`/api/bookings/${R7.id}/reject`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });

  // ================= 5/14. accept → PROVIDER_EN_ROUTE ===================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R8 = r.data;
  await request(`/api/bookings/${R8.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  r = await request(`/api/bookings/${R8.id}/start`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider starts → PROVIDER_EN_ROUTE", r.status === 200 && r.data.status === "PROVIDER_EN_ROUTE", `status=${r.status}`);

  // ================= 6. auto-arrival via live tracking ==================
  const provShareToken = R8.shareToken;
  const provWs = io(BASE, { transports: ["websocket"] });
  await new Promise((res) => provWs.on("connect", res));
  provWs.emit("person:join", { bookingId: R8.id, token: provShareToken, personName: "Provider A" });
  await new Promise((res) => setTimeout(res, 300));
  provWs.emit("location:update", { bookingId: R8.id, token: provShareToken, lat: DEST.lat + 0.0004, lng: DEST.lng + 0.0004, accuracy: 8, speed: 5 });
  const autoArrived = await poll(async () => {
    const s = await findStatus(R8.id);
    return s === "ARRIVED" ? s : null;
  });
  check("auto-arrival transitions PROVIDER_EN_ROUTE → ARRIVED", autoArrived === "ARRIVED", `status=${autoArrived}`);

  // location updates after ARRIVED must not clobber the lifecycle state
  provWs.emit("location:update", { bookingId: R8.id, token: provShareToken, lat: DEST.lat + 0.0006, lng: DEST.lng + 0.0006, accuracy: 8, speed: 1 });
  await new Promise((res) => setTimeout(res, 300));
  r = await getBooking(R8.id, cust.cookie);
  check("location updates do not overwrite ARRIVED", r.status === 200 && r.data.status === "ARRIVED" && !!r.data.location, `status=${r.data?.status}`);
  provWs.close();

  // ================= 17. complete before IN_PROGRESS → 409 ==============
  r = await request(`/api/bookings/${R8.id}/complete`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("complete before IN_PROGRESS → 409", r.status === 409, `status=${r.status}`);

  // ================= 7. begin → IN_PROGRESS =============================
  r = await request(`/api/bookings/${R8.id}/begin`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider begins service → IN_PROGRESS", r.status === 200 && r.data.status === "IN_PROGRESS" && !!r.data.startedAt, `status=${r.status}`);

  // ================= 8. complete → COMPLETED ============================
  r = await request(`/api/bookings/${R8.id}/complete`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider completes → COMPLETED", r.status === 200 && r.data.status === "COMPLETED" && !!r.data.completedAt, `status=${r.status}`);
  r = await request(`/api/bookings/${R8.id}/complete`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("double complete → 409", r.status === 409, `status=${r.status}`);

  // ================= 9. review only after completion ====================
  r = await request(`/api/bookings/${R8.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5, comment: "Excellent!" } });
  check("customer reviews completed booking → 201", r.status === 201, `status=${r.status} ${r.data?.error || ""}`);
  r = await request(`/api/bookings/${R8.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 4 } });
  check("duplicate review → 409", r.status === 409, `status=${r.status}`);

  // ================= provider arrive endpoint + 32. cancel rules ========
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R9 = r.data;
  await request(`/api/bookings/${R9.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  await request(`/api/bookings/${R9.id}/start`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  r = await request(`/api/bookings/${R9.id}/arrive`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider arrive endpoint → ARRIVED", r.status === 200 && r.data.status === "ARRIVED", `status=${r.status}`);
  r = await request(`/api/bookings/${R9.id}/complete`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("complete while ARRIVED → 409", r.status === 409, `status=${r.status}`);
  r = await request(`/api/bookings/${R9.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider cannot cancel while ARRIVED → 409", r.status === 409, `status=${r.status} ${r.data?.error || ""}`);
  r = await request(`/api/bookings/${R9.id}/begin`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider begins service", r.status === 200 && r.data.status === "IN_PROGRESS", `status=${r.status}`);
  r = await request(`/api/bookings/${R9.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("in-progress service cannot be cancelled → 409", r.status === 409, `status=${r.status}`);
  r = await request(`/api/bookings/${R9.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 3 } });
  check("review rejected before completion → 409", r.status === 409, `status=${r.status}`);
  await request(`/api/bookings/${R9.id}/complete`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });

  // rating bounds validated on a fresh, completed, unreviewed booking
  r = await request(`/api/bookings/${R9.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 6 } });
  check("rating above 5 → 400", r.status === 400, `status=${r.status} ${r.data?.error || ""}`);
  r = await request(`/api/bookings/${R9.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 0 } });
  check("rating below 1 → 400", r.status === 400, `status=${r.status}`);
  r = await request(`/api/bookings/${R9.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 3, comment: "Okay" } });
  check("customer reviews second completed booking → 201", r.status === 201, `status=${r.status}`);

  // ================= 22. Socket.IO cannot overwrite newer state ==========
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R10 = r.data;
  await request(`/api/bookings/${R10.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  r = await request(`/api/bookings/${R10.id}/start`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("booking starts for socket/HTTP race test", r.status === 200 && r.data.status === "PROVIDER_EN_ROUTE");

  r = await request(`/api/bookings/${R10.id}/cancel`, { method: "POST", cookie: stranger.cookie, csrf: stranger.csrf });
  check("stranger cannot cancel → 404", r.status === 404, `status=${r.status}`);

  const pws = io(BASE, { transports: ["websocket"] });
  await new Promise((res) => pws.on("connect", res));
  pws.emit("person:join", { bookingId: R10.id, token: R10.shareToken, personName: "Provider A" });
  await new Promise((res) => setTimeout(res, 300));
  pws.emit("location:update", { bookingId: R10.id, token: R10.shareToken, lat: PICKUP.lat + 0.001, lng: PICKUP.lng + 0.001, accuracy: 5, speed: 4 });
  await new Promise((res) => setTimeout(res, 400));
  r = await getBooking(R10.id, cust.cookie);
  check("location update records position but keeps PROVIDER_EN_ROUTE", r.status === 200 && r.data.status === "PROVIDER_EN_ROUTE" && !!r.data.location, `status=${r.data?.status}`);
  pws.emit("location:update", { bookingId: R10.id, token: R10.shareToken, lat: PICKUP.lat + 0.002, lng: PICKUP.lng + 0.002, accuracy: 5, speed: 4 });
  await new Promise((res) => setTimeout(res, 400));
  r = await getBooking(R10.id, cust.cookie);
  check("further location updates still keep PROVIDER_EN_ROUTE", r.status === 200 && r.data.status === "PROVIDER_EN_ROUTE", `status=${r.data?.status}`);

  // resolve R10 so provider A's active slot frees up before R11 is created
  await request(`/api/bookings/${R10.id}/arrive`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  await request(`/api/bookings/${R10.id}/begin`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  await request(`/api/bookings/${R10.id}/complete`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });

  // customer cancel vs a simultaneous socket location update
  const R11 = (await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) })).data;
  const cancelR11 = request(`/api/bookings/${R11.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  pws.emit("location:update", { bookingId: R11.id, token: R11.shareToken, lat: PICKUP.lat + 0.001, lng: PICKUP.lng + 0.001, accuracy: 5, speed: 2 });
  r = await cancelR11;
  check("customer cancels while location streams → CANCELLED", r.status === 200 && r.data.status === "CANCELLED", `status=${r.status}`);
  await new Promise((res) => setTimeout(res, 400));
  r = await getBooking(R11.id, cust.cookie);
  check("socket location update did not undo cancellation", r.status === 200 && r.data.status === "CANCELLED", `status=${r.data?.status}`);
  pws.close();

  // ================= 18. accept vs cancel race ==========================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R12 = r.data;
  const [accRes, canRes] = await Promise.all([
    request(`/api/bookings/${R12.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf }),
    request(`/api/bookings/${R12.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf }),
  ]);
  check("accept vs cancel: exactly one wins", (accRes.status === 200 && canRes.status === 409) || (canRes.status === 200 && accRes.status === 409), `accept=${accRes.status} cancel=${canRes.status}`);
  r = await getBooking(R12.id, cust.cookie);
  check("accept/cancel race leaves a consistent state", r.data.status === "ACCEPTED" || r.data.status === "CANCELLED", `status=${r.data?.status}`);
  if (r.data.status === "ACCEPTED") {
    await request(`/api/bookings/${R12.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  }

  // ================= 19. accept vs expire ===============================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R13 = r.data;
  await prisma.booking.update({ where: { id: R13.id }, data: { expires_at: BigInt(Date.now() + 500) } });
  const acceptR13 = request(`/api/bookings/${R13.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  await new Promise((res) => setTimeout(res, 1600)); // let a sweep pass
  const accR13 = await acceptR13;
  r = await getBooking(R13.id, cust.cookie);
  check("accept vs expire: outcome is one of ACCEPTED/EXPIRED", r.data.status === "ACCEPTED" || r.data.status === "EXPIRED", `status=${r.data?.status} accept=${accR13.status}`);
  if (r.data.status === "ACCEPTED") {
    await request(`/api/bookings/${R13.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  }

  // sweeper must never expire an already-accepted booking
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAProfileId) });
  const R14 = r.data;
  await request(`/api/bookings/${R14.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  await prisma.booking.update({ where: { id: R14.id }, data: { expires_at: BigInt(Date.now() - 1000) } });
  await new Promise((res) => setTimeout(res, 2000));
  r = await getBooking(R14.id, cust.cookie);
  check("sweeper does not expire an ACCEPTED booking", r.data.status === "ACCEPTED", `status=${r.data?.status}`);
  await request(`/api/bookings/${R14.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });

  // ================= 21. legacy tracking still works ====================
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { personName: "Legacy Person", pickup: PICKUP, destination: DEST } });
  const legacy = r.data;
  check("legacy booking still starts as pending", r.status === 201 && legacy.status === "pending", `status=${r.data?.status}`);
  const lws = io(BASE, { transports: ["websocket"] });
  await new Promise((res) => lws.on("connect", res));
  lws.emit("person:join", { bookingId: legacy.id, token: legacy.shareToken, personName: "Legacy Person" });
  await new Promise((res) => setTimeout(res, 300));
  lws.emit("location:update", { bookingId: legacy.id, token: legacy.shareToken, lat: PICKUP.lat + 0.001, lng: PICKUP.lng + 0.001, accuracy: 5, speed: 4 });
  await new Promise((res) => setTimeout(res, 400));
  r = await getBooking(legacy.id, cust.cookie);
  check("legacy live tracking updates status to in_transit", r.status === 200 && r.data.status === "in_transit", `status=${r.data?.status}`);
  lws.close();

  console.log(ok ? "\nALL MARKETPLACE CHECKS PASSED" : "\nSOME MARKETPLACE CHECKS FAILED");
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
    /* best effort cleanup */
  }
  await prisma.$disconnect();
}
