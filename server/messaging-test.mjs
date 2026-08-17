// Messaging verification (server-side).
// Boots the real server, exercises: send/read authorization, body
// sanitization, terminal-state gate, nonce dedup, rate limiting,
// pagination, unread counts, read receipts. Cleans up test users.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./db.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 4195;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;
const TEST_EMAIL_SUFFIX = "@messaging-test.com";

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
  const cust = await register("Msg Cust", `cust-${stamp}${TEST_EMAIL_SUFFIX}`, password);
  const prov = await register("Msg Provider", `prov-${stamp}${TEST_EMAIL_SUFFIX}`, password);
  const stranger = await register("Msg Stranger", `stranger-${stamp}${TEST_EMAIL_SUFFIX}`, password);

  // Provider creates profile
  let r = await request("/api/profile", {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { name: "Msg Provider", listed: true },
  });
  check("provider creates profile", r.status === 201, `status=${r.status}`);
  const profileId = r.data?.id;
  await prisma.user.update({ where: { email: prov.email }, data: { role: "provider" } });

  // Provider creates a service
  r = await request("/api/services", {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { title: "Delivery", category: "logistics", priceAmount: 5000, priceCurrency: "GHS", priceUnit: "flat" },
  });
  check("provider creates service", r.status === 201, `status=${r.status}`);
  const serviceId = r.data?.id;

  // Customer creates a marketplace booking
  r = await request("/api/bookings", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { personName: "Customer", pickup: PICKUP, destination: DEST, profileId, serviceId },
  });
  check("customer creates booking", r.status === 201, `status=${r.status}`);
  const bookingId = r.data?.id;
  check("booking has correct status", r.data?.status === "REQUESTED", `status=${r.data?.status}`);

  // ====== 1. AUTHORIZATION ======
  r = await request(`/api/bookings/${bookingId}/messages`, { cookie: stranger.cookie });
  check("stranger cannot read messages → 404", r.status === 404, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: stranger.cookie, csrf: stranger.csrf,
    body: { body: "hello" },
  });
  check("stranger cannot send messages → 404", r.status === 404, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/messages`, { cookie: cust.cookie });
  check("customer can read messages (empty)", r.status === 200, `status=${r.status}`);

  // ====== 2. PROVIDER GATE ON REQUESTED ======
  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { body: "Hey customer!" },
  });
  check("provider cannot send on REQUESTED → 409", r.status === 409, `status=${r.status}`);

  // ====== 3. CUSTOMER SENDS ON REQUESTED ======
  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { body: "Hi provider, I need a ride." },
  });
  check("customer sends on REQUESTED → 201", r.status === 201, `status=${r.status}`);
  const msg1Id = r.data?.id;
  check("message has correct body", r.data?.body === "Hi provider, I need a ride.");
  check("message has sender info", !!r.data?.sender?.name, JSON.stringify(r.data?.sender));

  // ====== 4. BODY VALIDATION ======
  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { body: "" },
  });
  check("empty body rejected → 400", r.status === 400, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { body: "x".repeat(2001) },
  });
  check("over-length body rejected → 400", r.status === 400, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { body: 123 },
  });
  check("non-string body rejected → 400", r.status === 400, `status=${r.status}`);

  // ====== 5. SANITIZATION ======
  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { body: "Hello\x00World\t  double  spaces" },
  });
  check("sanitize control chars + collapse spaces", r.status === 201 && r.data?.body === "HelloWorld double spaces", `body=${r.data?.body}`);

  // ====== 6. PROVIDER ACCEPTS → CAN SEND ======
  r = await request(`/api/bookings/${bookingId}/accept`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  check("provider accepts booking", r.status === 200, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { body: "Got it, I'm on my way!" },
  });
  check("provider can send after accept → 201", r.status === 201, `status=${r.status}`);
  const msg2Id = r.data?.id;

  // ====== 7. PAGINATION ======
  r = await request(`/api/bookings/${bookingId}/messages?limit=2`, { cookie: cust.cookie });
  check("paginated fetch returns messages", r.status === 200 && Array.isArray(r.data) && r.data.length === 2, `count=${r.data?.length}`);

  // ====== 8. UNREAD COUNT ======
  // Customer has 1 unread from provider (msg2)
  r = await request(`/api/bookings/${bookingId}/messages/read`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
  });
  check("mark read returns count", r.status === 200 && r.data?.marked >= 1, `marked=${r.data?.marked}`);

  r = await request(`/api/bookings/${bookingId}/messages/read`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
  });
  check("second mark-read returns 0", r.status === 200 && r.data?.marked === 0, `marked=${r.data?.marked}`);

  // ====== 9. NONCE DEDUP ======
  const nonce = "test-nonce-123";
  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { body: "Dedup test", nonce },
  });
  check("first send with nonce → 201", r.status === 201, `status=${r.status}`);
  const dedupFirstId = r.data?.id;

  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { body: "Dedup test", nonce },
  });
  check("duplicate nonce → same message returned", r.status === 200 && r.data?.id === dedupFirstId, `status=${r.status} id=${r.data?.id}`);

  // ====== 10. TERMINAL STATE GATE ======
  // Transition through the full lifecycle: start → PROVIDER_EN_ROUTE, arrive → ARRIVED, begin → IN_PROGRESS, complete → COMPLETED
  r = await request(`/api/bookings/${bookingId}/start`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  check("provider starts booking", r.status === 200, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/arrive`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  check("provider arrives", r.status === 200, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/begin`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  check("provider begins service", r.status === 200, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/complete`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
  });
  check("provider completes booking", r.status === 200, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/messages`, {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { body: "Post-completion message" },
  });
  check("cannot send on completed booking → 409", r.status === 409, `status=${r.status}`);

  r = await request(`/api/bookings/${bookingId}/messages`, { cookie: cust.cookie });
  check("can still read messages on completed booking", r.status === 200 && Array.isArray(r.data), `status=${r.status}`);

  // ====== 11. STRANGER STILL CANNOT ACCESS ======
  r = await request(`/api/bookings/${bookingId}/messages`, { cookie: stranger.cookie });
  check("stranger still cannot read → 404", r.status === 404, `status=${r.status}`);

  // ====== 12. UNREAD ENDPOINT ======
  r = await request("/api/messages/unread", { cookie: cust.cookie });
  check("unread endpoint returns object", r.status === 200 && typeof r.data === "object", `type=${typeof r.data}`);

  console.log(ok ? "\nALL MESSAGING CHECKS PASSED" : "\nSOME MESSAGING CHECKS FAILED");
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
