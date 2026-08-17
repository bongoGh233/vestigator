// Phase 3, Step 3: services backend verification.
// Boots the real server and exercises provider service management (CRUD,
// ownership, deactivation/reactivation), the public service listing + search
// foundation, and the authoritative service→booking price hand-off (client
// prices are ignored; the database service price becomes the booking price).
// Cleans up every test user it creates.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./db.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 4197;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;
const SWEEP_MS = Number(process.env.TEST_SWEEP_MS) || 800;
const TEST_EMAIL_SUFFIX = "@services-test.com";

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

const LONG_TITLE = "x".repeat(81);

async function main() {
  const stamp = Date.now();
  const password = "Correct-Horse-Battery-Staple!";

  // --- actors -----------------------------------------------------------
  const cust = await register("Services Cust", `scust-${stamp}@services-test.com`, password);
  const provA = await register("Provider A", `sprova-${stamp}@services-test.com`, password, "provider");
  const provB = await register("Provider B", `sprovb-${stamp}@services-test.com`, password, "provider");

  let r = await request("/api/profile", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: { name: "Provider A", city: "Accra", skills: ["errands"], listed: true } });
  const provAId = r.data?.id;
  check("provider A creates a profile", r.status === 201 && !!provAId, `status=${r.status}`);
  r = await request("/api/profile", { method: "POST", cookie: provB.cookie, csrf: provB.csrf, body: { name: "Provider B", city: "Kumasi", skills: ["delivery"], listed: true } });
  const provBId = r.data?.id;
  check("provider B creates a profile", r.status === 201 && !!provBId, `status=${r.status}`);
  // service_area lives on the profile (no public API writes it yet) — set it
  // directly so the "area" search can exercise the JSON branch.
  await prisma.profile.update({ where: { id: provAId }, data: { service_area: JSON.stringify({ city: "Tema", radiusKm: 25 }) } });

  const svc = (title, extra = {}) => ({
    title,
    description: "A service",
    category: "other",
    priceAmount: 5000,
    priceCurrency: "GHS",
    priceUnit: "flat",
    ...extra,
  });

  // ================= 1. provider creates services ======================
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Errand Run", { category: "errands", durationMin: 60 }) });
  const S1 = r.data;
  check("provider creates a service → 201", r.status === 201 && !!S1?.id, `status=${r.status} ${r.data?.error || ""}`);
  check("service echoes title/price/unit/currency/duration", S1.title === "Errand Run" && S1.priceAmount === 5000 && S1.priceCurrency === "GHS" && S1.priceUnit === "flat" && S1.durationMin === 60 && S1.active === true);
  check("service is attached to the provider's profile", S1.profileId === provAId);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Premium Delivery", { category: "delivery", priceAmount: 15000, priceCurrency: "USD", priceUnit: "per_km" }) });
  const S2 = r.data;
  check("provider creates a second service → 201", r.status === 201 && !!S2?.id, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provB.cookie, csrf: provB.csrf, body: svc("Courier", { category: "delivery", priceAmount: 2000 }) });
  const S3 = r.data;
  check("provider B creates a service → 201", r.status === 201 && !!S3?.id, `status=${r.status}`);

  // ================= provider sees own services ========================
  r = await request("/api/provider/services", { cookie: provA.cookie });
  check("provider lists own services", r.status === 200 && r.data.length === 2 && r.data.every((s) => s.profileId === provAId), `status=${r.status}`);
  r = await request("/api/provider/services", { cookie: cust.cookie });
  check("customer cannot list provider services (role gate) → 403", r.status === 403, `status=${r.status}`);

  // ================= 2/13. non-providers cannot create/mutate ==========
  r = await request("/api/services", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: svc("Nope") });
  check("customer cannot create a service → 403", r.status === 403, `status=${r.status}`);
  r = await request(`/api/services/${S1.id}`, { method: "PUT", cookie: cust.cookie, csrf: cust.csrf, body: svc("Nope") });
  check("customer cannot update a service → 403", r.status === 403, `status=${r.status}`);
  r = await request(`/api/services/${S1.id}`, { method: "DELETE", cookie: cust.cookie, csrf: cust.csrf });
  check("customer cannot delete a service → 403", r.status === 403, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  check("service creation without body still role-gated → 403", r.status === 403);

  // ================= 3/14. service ownership enforced ==================
  r = await request(`/api/services/${S1.id}`, { method: "PUT", cookie: provB.cookie, csrf: provB.csrf, body: svc("Hijack") });
  check("provider cannot modify another provider's service → 403", r.status === 403, `status=${r.status}`);
  r = await request(`/api/services/${S1.id}`, { method: "DELETE", cookie: provB.cookie, csrf: provB.csrf });
  check("provider cannot delete another provider's service → 403", r.status === 403, `status=${r.status}`);

  // ================= 4. provider updates own service ===================
  r = await request(`/api/services/${S1.id}`, { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body: { title: "Errand Run Pro", priceAmount: 6000 } });
  check("provider updates own service → 200", r.status === 200 && r.data.title === "Errand Run Pro" && r.data.priceAmount === 6000, `status=${r.status} ${r.data?.error || ""}`);
  check("untouched fields survive a partial update", r.data.category === "errands" && r.data.durationMin === 60);
  r = await request(`/api/services/${S1.id}`, { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body: {} });
  check("empty update body → 400", r.status === 400, `status=${r.status}`);

  // ================= 9-12. validation ==================================
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Bad Price", { priceAmount: "100" }) });
  check("string price rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Bad Price", { priceAmount: 1.5 }) });
  check("fractional price rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Bad Price", { priceAmount: -1 }) });
  check("negative price rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Bad Unit", { priceUnit: "per_month" }) });
  check("invalid price unit rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Bad Currency", { priceCurrency: "XYZ" }) });
  check("unsupported currency rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Bad Duration", { durationMin: 0 }) });
  check("zero duration rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Bad Duration", { durationMin: -5 }) });
  check("negative duration rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Bad Duration", { durationMin: 2.5 }) });
  check("fractional duration rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc("Bad Duration", { durationMin: "60" }) });
  check("string duration rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: { title: "", priceAmount: 100 } });
  check("missing title rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: svc(LONG_TITLE) });
  check("overlong title rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request(`/api/services/${S1.id}`, { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body: { active: "yes" } });
  check("non-boolean active rejected → 400", r.status === 400, `status=${r.status}`);
  r = await request("/api/services", { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: { title: "No price" } });
  check("missing price rejected → 400", r.status === 400, `status=${r.status}`);

  // ================= 5/16. deactivate → hidden from public =============
  r = await request(`/api/services/${S1.id}`, { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body: { active: false } });
  check("provider deactivates service", r.status === 200 && r.data.active === false, `status=${r.status}`);
  r = await request("/api/services");
  check("public listing hides inactive service", r.status === 200 && !r.data.some((s) => s.id === S1.id), `status=${r.status}`);
  r = await request(`/api/profiles/${provAId}/services`);
  check("profile services hide inactive service", r.status === 200 && !r.data.some((s) => s.id === S1.id), `status=${r.status}`);
  r = await request("/api/provider/services", { cookie: provA.cookie });
  check("provider's own list still shows the inactive service", r.status === 200 && r.data.some((s) => s.id === S1.id && s.active === false), `status=${r.status}`);

  // ================= 6/17. reactivate ==================================
  r = await request(`/api/services/${S1.id}`, { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body: { active: true } });
  check("provider reactivates service", r.status === 200 && r.data.active === true, `status=${r.status}`);

  // ================= 7. public listing + search foundation =============
  r = await request("/api/services");
  const list = r.data;
  check("public user sees active services (no auth)", r.status === 200 && list.some((s) => s.id === S1.id) && list.some((s) => s.id === S2.id) && list.some((s) => s.id === S3.id), `status=${r.status} count=${list.length}`);
  const s1item = list.find((s) => s.id === S1.id);
  check("listing carries provider name/rating", s1item.provider?.id === provAId && s1item.provider?.name === "Provider A" && typeof s1item.provider.ratingCount === "number");
  check("public listing never leaks private fields", list.every((s) => s.provider && !s.provider.trackCode && !s.provider.email && !s.provider.phone && !s.provider.session));
  r = await request("/api/profiles", { cookie: cust.cookie });
  check("directory still works and exposes rating aggregates", r.status === 200 && r.data.every((p) => typeof p.ratingCount === "number" && !p.trackCode), `status=${r.status}`);

  r = await request("/api/services?category=delivery");
  check("search by category", r.status === 200 && r.data.some((s) => s.id === S2.id) && r.data.some((s) => s.id === S3.id) && !r.data.some((s) => s.id === S1.id), `status=${r.status}`);
  r = await request("/api/services?q=errand");
  check("search by text query", r.status === 200 && r.data.some((s) => s.id === S1.id), `status=${r.status}`);
  r = await request("/api/services?area=Accra");
  check("search by provider city", r.status === 200 && r.data.some((s) => s.id === S1.id) && !r.data.some((s) => s.id === S3.id), `status=${r.status}`);
  r = await request("/api/services?area=Tema");
  check("search by service_area JSON city", r.status === 200 && r.data.some((s) => s.id === S1.id) && !r.data.some((s) => s.id === S3.id), `status=${r.status}`);
  r = await request("/api/services?limit=1");
  check("pagination limit", r.status === 200 && r.data.length === 1, `status=${r.status} count=${r.data.length}`);
  r = await request("/api/services?limit=1&offset=1");
  check("pagination offset", r.status === 200 && r.data.length === 1 && r.data[0].id !== list[0].id, `status=${r.status}`);

  // ================= 15. booking with a valid service ==================
  const bookingBody = (extra = {}) => ({
    personName: "Ada Lovelace",
    pickup: PICKUP,
    destination: DEST,
    ...extra,
  });
  // Client tries to force a price — the server must ignore it.
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provAId, serviceId: S1.id, priceAmount: 1, price: 999999999 }) });
  const B1 = r.data;
  check("booking with valid service succeeds", r.status === 201 && B1.status === "REQUESTED", `status=${r.status} ${r.data?.error || ""}`);
  check("booking stores service and profile", B1.serviceId === S1.id && B1.profileId === provAId);
  check("client-supplied price is ignored (database price wins)", B1.priceAmount === 6000 && B1.priceCurrency === "GHS", `price=${B1.priceAmount}`);
  const dbB1 = await prisma.booking.findUnique({ where: { id: B1.id } });
  check("booking price matches the authoritative service price", Number(dbB1?.price_amount) === 6000 && dbB1?.service_id === S1.id);
  await request(`/api/bookings/${B1.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });

  // ================= service-only booking derives the profile ==========
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ serviceId: S1.id }) });
  const B2 = r.data;
  check("service-only booking derives the provider profile", r.status === 201 && B2.profileId === provAId && B2.serviceId === S1.id, `status=${r.status} ${r.data?.error || ""}`);
  await request(`/api/bookings/${B2.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });

  // ================= 16. booking with an inactive service fails ========
  await request(`/api/services/${S1.id}`, { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body: { active: false } });
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provAId, serviceId: S1.id }) });
  check("booking with inactive service → 400", r.status === 400, `status=${r.status}`);
  await request(`/api/services/${S1.id}`, { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body: { active: true } });

  // ================= 17. booking with another provider's service =======
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provAId, serviceId: S3.id }) });
  check("booking with another provider's service → 400", r.status === 400, `status=${r.status} ${r.data?.error || ""}`);
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ serviceId: 999999 }) });
  check("booking with unknown service → 400", r.status === 400, `status=${r.status}`);

  // ================= 20. history survives service deactivation =========
  r = await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: bookingBody({ profileId: provAId, serviceId: S1.id }) });
  const B3 = r.data;
  check("booking created against active service", r.status === 201 && B3.status === "REQUESTED", `status=${r.status}`);
  r = await request(`/api/bookings/${B3.id}/accept`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });
  check("provider can still accept the service booking", r.status === 200 && r.data.status === "ACCEPTED", `status=${r.status}`);
  await request(`/api/services/${S1.id}`, { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body: { active: false } });
  r = await request(`/api/bookings/${B3.id}`, { cookie: cust.cookie });
  check("historical booking keeps service + price after deactivation", r.status === 200 && r.data.serviceId === S1.id && r.data.priceAmount === 6000 && r.data.status === "ACCEPTED", `status=${r.status}`);
  await request(`/api/bookings/${B3.id}/cancel`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf });

  // ================= deletion safety ===================================
  r = await request(`/api/services/${S3.id}`, { method: "DELETE", cookie: provB.cookie, csrf: provB.csrf });
  check("provider deletes a service with no bookings", r.status === 200 && r.data.ok === true, `status=${r.status}`);
  r = await request("/api/services?category=delivery");
  check("deleted service leaves the public listing", !r.data.some((s) => s.id === S3.id), `status=${r.status}`);
  r = await request(`/api/services/${S1.id}`, { method: "DELETE", cookie: provA.cookie, csrf: provA.csrf });
  check("service with bookings cannot be deleted → 409", r.status === 409, `status=${r.status} ${r.data?.error || ""}`);
  r = await request("/api/services/999999", { method: "DELETE", cookie: provA.cookie, csrf: provA.csrf });
  check("deleting unknown service → 404", r.status === 404, `status=${r.status}`);
  r = await request("/api/services/999999", { method: "PUT", cookie: provA.cookie, csrf: provA.csrf, body: { active: false } });
  check("updating unknown service → 404", r.status === 404, `status=${r.status}`);

  // ================= public profile detail exposes services ============
  r = await request(`/api/profiles/${provAId}`, { cookie: cust.cookie });
  const detail = r.data;
  check("profile detail exposes provider info", r.status === 200 && detail.name === "Provider A" && typeof detail.ratingCount === "number" && detail.rating === null, `status=${r.status}`);
  check("profile detail exposes service area", detail.serviceArea && detail.serviceArea.city === "Tema");
  check("profile detail lists only active services", Array.isArray(detail.services) && detail.services.some((s) => s.id === S2.id) && !detail.services.some((s) => s.id === S1.id), `services=${detail.services?.length}`);

  console.log(ok ? "\nALL SERVICES CHECKS PASSED" : "\nSOME SERVICES CHECKS FAILED");
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
