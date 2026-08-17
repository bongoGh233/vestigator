// Provider weekly availability verification (server-side).
// Boots the real server against the configured PostgreSQL database, then
// exercises: ownership/role gates, replace-all CRUD, server-side validation
// (timezone, day/time bounds, overlap), the customer-facing availability
// payload, the booking creation/accept gates, timezone interpretation, and
// legacy preservation for providers with no availability configured.
// Cleans up every test user it creates.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./db.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 4194;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;
const SWEEP_MS = Number(process.env.TEST_SWEEP_MS) || 800;
const TEST_EMAIL_SUFFIX = "@availability-test.com";

// A timezone as far west as possible: "today" here is the last to end on
// Earth, so a full-day window on "tomorrow" (Pago Pago) is guaranteed to be
// unavailable whenever the suite runs.
const TZ = "Pacific/Pago_Pago";

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

// Local day-of-week (0=Sun..6=Sat) in a given IANA timezone.
function dowInTz(tz, now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).formatToParts(new Date(now));
  const label = parts.find((p) => p.type === "weekday")?.value;
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[label];
}

const DEST = { lat: 6.55, lng: 3.45 };
const PICKUP = { lat: 6.5, lng: 3.4 };
const mkBookingBody = (profileId) => ({
  personName: "Ada Lovelace",
  pickup: PICKUP,
  destination: DEST,
  profileId,
});

async function main() {
  const stamp = Date.now();
  const password = "Correct-Horse-Battery-Staple!";
  const today = dowInTz(TZ);
  const tomorrow = (today + 1) % 7;
  const FULL_DAY = { startMin: 0, endMin: 1440 };

  // --- actors (4 registrations, under the 5/hour per-process limit) ------
  const cust = await register("Avail Cust", `cust-${stamp}@availability-test.com`, password);
  const provA = await register("Avail A", `prova-${stamp}@availability-test.com`, password, "provider");
  const provB = await register("Avail B", `provb-${stamp}@availability-test.com`, password, "provider");
  const stranger = await register("Avail Stranger", `stranger-${stamp}@availability-test.com`, password);

  // ================= 1. ownership / role gates ===========================
  let r = await request("/api/profile/availability");
  check("unauthenticated GET availability → 401", r.status === 401, `status=${r.status}`);
  r = await request("/api/profile/availability", { cookie: cust.cookie });
  check("customer role cannot read availability → 403", r.status === 403, `status=${r.status}`);
  r = await request("/api/profile/availability", {
    method: "PUT", cookie: cust.cookie, csrf: cust.csrf,
    body: { timezone: TZ, availability: [{ dow: today, ...FULL_DAY }] },
  });
  check("customer role cannot write availability → 403", r.status === 403, `status=${r.status}`);
  r = await request("/api/profile/availability", { cookie: provA.cookie });
  check("provider without a profile cannot read availability → 403", r.status === 403, `status=${r.status}`);

  // ================= 2. providers create profiles ========================
  r = await request("/api/profile", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: { name: "Avail A", listed: true } });
  const provAId = r.data?.id;
  check("provider A creates a profile", r.status === 201 && !!provAId, `status=${r.status}`);
  r = await request("/api/profile", { method: "POST", cookie: provB.cookie, csrf: provB.csrf, body: { name: "Avail B", listed: true } });
  const provBId = r.data?.id;
  check("provider B creates a profile", r.status === 201 && !!provBId, `status=${r.status}`);

  // ================= 3. empty schedule is legacy (unconfigured) ==========
  r = await request("/api/profile/availability", { cookie: provA.cookie });
  check("new provider starts with no availability + no timezone", r.status === 200 && r.data.timezone === null && r.data.availability.length === 0);
  r = await request(`/api/profiles/${provAId}`, { cookie: cust.cookie });
  const avNone = r.data?.availability;
  check("public profile: not configured → configured=false, availableNow=null", r.status === 200 && avNone?.configured === false && avNone?.availableNow === null, JSON.stringify(avNone));

  // ================= 4. PUT replaces the whole schedule ==================
  r = await request("/api/profile/availability", {
    method: "PUT", cookie: provA.cookie, csrf: provA.csrf,
    body: {
      timezone: TZ,
      availability: [
        { dow: today, ...FULL_DAY },
        { dow: tomorrow, startMin: 540, endMin: 1080, active: false },
      ],
    },
  });
  check("PUT saves timezone + windows", r.status === 200 && r.data.timezone === TZ && r.data.availability.length === 2, `status=${r.status}`);
  check("inactive flag round-trips", r.data.availability.find((a) => a.dow === tomorrow)?.active === false);

  r = await request("/api/profile/availability", { cookie: provA.cookie });
  check("GET returns the persisted schedule", r.status === 200 && r.data.timezone === TZ && r.data.availability.length === 2);

  r = await request(`/api/profiles/${provAId}`, { cookie: cust.cookie });
  const av = r.data?.availability;
  check("public schedule only exposes active windows", r.status === 200 && av?.schedule?.length === 1 && av.schedule[0].dow === today, JSON.stringify(av?.schedule));
  check("public availableNow=true inside a full-day active window", av?.availableNow === true);
  check("public availability carries the provider timezone", av?.timezone === TZ);

  // ================= 5. server-side validation ===========================
  const put = (body) => request("/api/profile/availability", { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body });
  r = await put({ timezone: "Not/AZone", availability: [{ dow: today, ...FULL_DAY }] });
  check("invalid IANA timezone → 400", r.status === 400, `status=${r.status} ${r.data?.error || ""}`);
  r = await put({ timezone: TZ, availability: [{ dow: 7, startMin: 0, endMin: 60 }] });
  check("dow out of range (7) → 400", r.status === 400, `status=${r.status}`);
  r = await put({ timezone: TZ, availability: [{ dow: today, startMin: 120, endMin: 60 }] });
  check("end <= start → 400", r.status === 400, `status=${r.status}`);
  r = await put({ timezone: TZ, availability: [{ dow: today, startMin: -1, endMin: 60 }] });
  check("negative start → 400", r.status === 400, `status=${r.status}`);
  r = await put({ timezone: TZ, availability: [{ dow: today, startMin: 60, endMin: 1441 }] });
  check("end past midnight (1441) → 400", r.status === 400, `status=${r.status}`);
  r = await put({
    timezone: TZ,
    availability: [
      { dow: today, startMin: 540, endMin: 660 },
      { dow: today, startMin: 600, endMin: 720 },
    ],
  });
  check("overlapping active windows on one day → 400", r.status === 400, `status=${r.status} ${r.data?.error || ""}`);
  r = await put({
    timezone: TZ,
    availability: [
      { dow: today, startMin: 540, endMin: 660 },
      { dow: today, startMin: 600, endMin: 720, active: false },
    ],
  });
  check("overlap with an inactive window is allowed", r.status === 200, `status=${r.status} ${r.data?.error || ""}`);
  r = await put({
    timezone: TZ,
    availability: [
      { dow: today, startMin: 540, endMin: 660 },
      { dow: today, startMin: 660, endMin: 780 },
    ],
  });
  check("adjacent (non-overlapping) windows allowed", r.status === 200, `status=${r.status} ${r.data?.error || ""}`);
  r = await put({
    timezone: TZ,
    availability: Array.from({ length: 29 }, (_, i) => ({ dow: i % 7, startMin: 60, endMin: 120 })),
  });
  check("more than 28 windows → 400", r.status === 400, `status=${r.status}`);

  // ================= 6. cross-profile isolation ==========================
  r = await request("/api/profile/availability", {
    method: "PUT", cookie: provB.cookie, csrf: provB.csrf,
    body: { timezone: TZ, availability: [{ dow: today, ...FULL_DAY }] },
  });
  check("provider B can save its own schedule", r.status === 200, `status=${r.status}`);
  r = await request("/api/profile/availability", { cookie: provA.cookie });
  check("provider A schedule untouched by B's write", r.status === 200 && r.data.availability.length === 2, `len=${r.data.availability.length}`);
  r = await request("/api/profile/availability", {
    method: "PUT", cookie: stranger.cookie, csrf: stranger.csrf,
    body: { timezone: TZ, availability: [{ dow: today, ...FULL_DAY }] },
  });
  check("stranger without a profile cannot write → 403", r.status === 403, `status=${r.status}`);

  // ================= 7. booking gate: creation ===========================
  // provA is currently "unavailable": reset to a full-day window on tomorrow.
  r = await request("/api/profile/availability", {
    method: "PUT", cookie: provA.cookie, csrf: provA.csrf,
    body: { timezone: TZ, availability: [{ dow: tomorrow, ...FULL_DAY }] },
  });
  check("provider A reset to unavailable-tomorrow schedule", r.status === 200, `status=${r.status}`);
  r = await request(`/api/profiles/${provAId}`, { cookie: cust.cookie });
  check("public availableNow=false outside active window", r.data?.availability?.availableNow === false);

  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAId) });
  check("request outside availability hours → 409", r.status === 409 && /not available/.test(r.data?.error || ""), `status=${r.status} ${r.data?.error || ""}`);

  // ================= 8. booking gate: acceptance =========================
  r = await request("/api/profile/availability", {
    method: "PUT", cookie: provA.cookie, csrf: provA.csrf,
    body: { timezone: TZ, availability: [{ dow: today, ...FULL_DAY }] },
  });
  check("provider A becomes available again", r.status === 200, `status=${r.status}`);
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAId) });
  const G1 = r.data;
  check("request while available → 201 REQUESTED", r.status === 201 && G1.status === "REQUESTED", `status=${r.status}`);
  r = await request(`/api/bookings/${G1.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("accept while available → ACCEPTED", r.status === 200 && r.data.status === "ACCEPTED", `status=${r.status}`);
  await request(`/api/bookings/${G1.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });

  // window ends before the provider accepts → gate blocks the accept
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAId) });
  const G2 = r.data;
  check("second request created while available", r.status === 201 && G2.status === "REQUESTED", `status=${r.status}`);
  r = await request("/api/profile/availability", {
    method: "PUT", cookie: provA.cookie, csrf: provA.csrf,
    body: { timezone: TZ, availability: [{ dow: tomorrow, ...FULL_DAY }] },
  });
  check("availability window closes before accept", r.status === 200, `status=${r.status}`);
  r = await request(`/api/bookings/${G2.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("accept outside availability hours → 409", r.status === 409 && /availability/.test(r.data?.error || ""), `status=${r.status} ${r.data?.error || ""}`);
  r = await request(`/api/bookings/${G2.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("customer can still cancel a gated request", r.status === 200 && r.data.status === "CANCELLED", `status=${r.status}`);

  // ================= 9. legacy providers are preserved ===================
  // provB keeps its full-day window; now clear provA completely.
  r = await request("/api/profile/availability", {
    method: "PUT", cookie: provA.cookie, csrf: provA.csrf,
    body: { timezone: TZ, availability: [] },
  });
  check("clearing the schedule works", r.status === 200 && r.data.availability.length === 0);
  r = await request(`/api/profiles/${provAId}`, { cookie: cust.cookie });
  check("cleared schedule → configured=false, availableNow=null", r.data?.availability?.configured === false && r.data?.availability?.availableNow === null);
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provAId) });
  const G3 = r.data;
  check("request to unconfigured provider still allowed → 201", r.status === 201 && G3.status === "REQUESTED", `status=${r.status} ${r.data?.error || ""}`);
  r = await request(`/api/bookings/${G3.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("accept by unconfigured provider still allowed → ACCEPTED", r.status === 200 && r.data.status === "ACCEPTED", `status=${r.status} ${r.data?.error || ""}`);

  // provB (never gated) end-to-end sanity
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provBId) });
  const GB = r.data;
  check("request to configured-but-not-set-up provider B works", r.status === 201, `status=${r.status}`);

  console.log(ok ? "\nALL AVAILABILITY CHECKS PASSED" : "\nSOME AVAILABILITY CHECKS FAILED");
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
