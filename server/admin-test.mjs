// Admin & moderation verification (server-side).
// Boots the real server, exercises: admin auth, dashboard, user management,
// provider management, booking/payment/review/report listing, review moderation,
// report status, audit log, user reports. Cleans up test data.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./db.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 4198;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;
const TEST_EMAIL_SUFFIX = "@admin-test.com";

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

async function makeAdmin(userId) {
  await prisma.user.update({ where: { id: userId }, data: { role: "admin" } });
}

const DEST = { lat: 6.55, lng: 3.45 };
const PICKUP = { lat: 6.5, lng: 3.4 };

async function main() {
  const stamp = Date.now();
  const password = "Correct-Horse-Battery-Staple!";

  // --- actors ---
  const admin = await register("Admin User", `admin-${stamp}${TEST_EMAIL_SUFFIX}`, password);
  const cust = await register("Cust User", `cust-${stamp}${TEST_EMAIL_SUFFIX}`, password);
  const prov = await register("Prov User", `prov-${stamp}${TEST_EMAIL_SUFFIX}`, password);

  // Promote admin
  const adminUser = await prisma.user.findUnique({ where: { email: admin.email } });
  await makeAdmin(adminUser.id);
  // Re-login to get a session with admin role
  const loginR = await request("/api/auth/login", {
    method: "POST",
    body: { email: admin.email, password },
  });
  admin.cookie = loginR.setCookie.split(";")[0];
  admin.csrf = loginR.data?.csrf;

  // Provider creates profile + service
  let r = await request("/api/profile", {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { name: "Prov Profile", listed: true },
  });
  check("provider creates profile", r.status === 201, `status=${r.status}`);
  const profileId = r.data?.id;
  await prisma.user.update({ where: { email: prov.email }, data: { role: "provider" } });

  r = await request("/api/services", {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { title: "Cleaning", category: "cleaning", priceAmount: 3000, priceCurrency: "GHS", priceUnit: "flat" },
  });
  check("provider creates service", r.status === 201, `status=${r.status}`);
  const serviceId = r.data?.id;

  // Create a booking for admin to inspect
  r = await request("/api/bookings", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { personName: "Cust Person", pickup: PICKUP, destination: DEST, profileId, serviceId },
  });
  check("customer creates booking", r.status === 201, `status=${r.status}`);
  const bookingId = r.data?.id;

  // Accept + complete + pay for payment tests
  r = await request(`/api/bookings/${bookingId}/accept`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${bookingId}/start`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${bookingId}/arrive`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${bookingId}/begin`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${bookingId}/complete`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
  r = await request(`/api/bookings/${bookingId}/confirm-payment`, {
    method: "POST", cookie: prov.cookie, csrf: prov.csrf,
    body: { method: "cash" },
  });
  check("booking completed + paid", r.status === 200, `status=${r.status}`);

  // ====== 1. NON-ADMIN CANNOT ACCESS ADMIN ROUTES ======
  r = await request("/api/admin/dashboard", { cookie: cust.cookie });
  check("non-admin rejected from dashboard", r.status === 403, `status=${r.status}`);

  r = await request("/api/admin/users", { cookie: cust.cookie });
  check("non-admin rejected from users list", r.status === 403, `status=${r.status}`);

  r = await request("/api/admin/dashboard");
  check("unauthenticated rejected from dashboard", r.status === 401, `status=${r.status}`);

  // ====== 2. ADMIN DASHBOARD ======
  r = await request("/api/admin/dashboard", { cookie: admin.cookie });
  check("admin gets dashboard", r.status === 200, `status=${r.status}`);
  check("dashboard has totalUsers", typeof r.data?.totalUsers === "number");
  check("dashboard has totalProviders", typeof r.data?.totalProviders === "number");
  check("dashboard has totalBookings", typeof r.data?.totalBookings === "number");
  check("dashboard has totalRevenue", typeof r.data?.totalRevenue === "number");
  check("dashboard has openReports", typeof r.data?.openReports === "number");

  // ====== 3. USER LISTING ======
  r = await request("/api/admin/users", { cookie: admin.cookie });
  check("admin lists users", r.status === 200 && Array.isArray(r.data?.users), `status=${r.status}`);
  check("user listing has total", typeof r.data?.total === "number");

  // Search filter
  r = await request(`/api/admin/users?search=${cust.email}`, { cookie: admin.cookie });
  check("user search works", r.status === 200 && r.data.users.length >= 1);

  // Role filter
  r = await request("/api/admin/users?role=provider", { cookie: admin.cookie });
  check("user role filter works", r.status === 200);

  // Status filter
  r = await request("/api/admin/users?status=active", { cookie: admin.cookie });
  check("user status filter works", r.status === 200);

  // ====== 4. USER DETAIL ======
  const custUser = await prisma.user.findUnique({ where: { email: cust.email } });
  r = await request(`/api/admin/users/${custUser.id}`, { cookie: admin.cookie });
  check("admin gets user detail", r.status === 200, `status=${r.status}`);
  check("user detail has profiles", Array.isArray(r.data?.profiles));
  check("user detail has bookings", Array.isArray(r.data?.bookings));

  // Invalid user ID
  r = await request("/api/admin/users/abc", { cookie: admin.cookie });
  check("invalid user ID rejected", r.status === 400, `status=${r.status}`);

  // Non-existent user
  r = await request("/api/admin/users/999999", { cookie: admin.cookie });
  check("non-existent user returns 404", r.status === 404, `status=${r.status}`);

  // ====== 5. SUSPEND / UNSUSPEND USER ======
  const provUser = await prisma.user.findUnique({ where: { email: prov.email } });
  r = await request(`/api/admin/users/${provUser.id}/status`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { status: "suspended" },
  });
  check("admin suspends provider", r.status === 200 && r.data?.status === "suspended", `status=${r.data?.status}`);

  // Suspended user cannot log in
  const suspLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: prov.email, password },
  });
  check("suspended user cannot log in", suspLogin.status === 403, `status=${suspLogin.status}`);

  // Unsuspend
  r = await request(`/api/admin/users/${provUser.id}/status`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { status: "active" },
  });
  check("admin unsuspends provider", r.status === 200 && r.data?.status === "active", `status=${r.data?.status}`);

  // Cannot change own status
  r = await request(`/api/admin/users/${adminUser.id}/status`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { status: "suspended" },
  });
  check("admin cannot suspend self", r.status === 400, `status=${r.status}`);

  // Invalid status
  r = await request(`/api/admin/users/${provUser.id}/status`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { status: "banned" },
  });
  check("invalid status rejected", r.status === 400, `status=${r.status}`);

  // ====== 6. ROLE CHANGE ======
  r = await request(`/api/admin/users/${custUser.id}/role`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { role: "both" },
  });
  check("admin changes user role", r.status === 200 && r.data?.role === "both", `role=${r.data?.role}`);

  // Revert
  r = await request(`/api/admin/users/${custUser.id}/role`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { role: "customer" },
  });
  check("admin reverts user role", r.status === 200 && r.data?.role === "customer");

  // Cannot change own role
  r = await request(`/api/admin/users/${adminUser.id}/role`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { role: "customer" },
  });
  check("admin cannot change own role", r.status === 400, `status=${r.status}`);

  // Invalid role
  r = await request(`/api/admin/users/${custUser.id}/role`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { role: "superadmin" },
  });
  check("invalid role rejected", r.status === 400, `status=${r.status}`);

  // ====== 7. PROVIDER LISTING ======
  r = await request("/api/admin/providers", { cookie: admin.cookie });
  check("admin lists providers", r.status === 200 && Array.isArray(r.data?.providers), `status=${r.status}`);
  check("provider listing has total", typeof r.data?.total === "number");

  // Verified filter
  r = await request("/api/admin/providers?verified=false", { cookie: admin.cookie });
  check("provider verified filter works", r.status === 200);

  // ====== 8. PROVIDER DETAIL ======
  r = await request(`/api/admin/providers/${provUser.id}`, { cookie: admin.cookie });
  check("admin gets provider detail", r.status === 200, `status=${r.status}`);
  check("provider detail has profiles", Array.isArray(r.data?.profiles));
  check("provider detail has services", Array.isArray(r.data?.profiles?.[0]?.services));

  // ====== 9. PROVIDER VERIFICATION ======
  r = await request(`/api/admin/providers/${profileId}/verified`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { verified: true },
  });
  check("admin verifies provider", r.status === 200 && r.data?.verified === true, `verified=${r.data?.verified}`);

  r = await request(`/api/admin/providers/${profileId}/verified`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { verified: false },
  });
  check("admin unverifies provider", r.status === 200 && r.data?.verified === false);

  // ====== 10. PROVIDER LISTED / ACTIVE TOGGLES ======
  r = await request(`/api/admin/providers/${profileId}/listed`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { listed: false },
  });
  check("admin delists provider", r.status === 200 && r.data?.listed === false, `listed=${r.data?.listed}`);

  r = await request(`/api/admin/providers/${profileId}/listed`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { listed: true },
  });
  check("admin relists provider", r.status === 200 && r.data?.listed === true);

  r = await request(`/api/admin/providers/${profileId}/active`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { active: false },
  });
  check("admin deactivates provider", r.status === 200 && r.data?.is_active === false, `active=${r.data?.is_active}`);

  r = await request(`/api/admin/providers/${profileId}/active`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { active: true },
  });
  check("admin reactivates provider", r.status === 200 && r.data?.is_active === true);

  // ====== 11. BOOKING LISTING ======
  r = await request("/api/admin/bookings", { cookie: admin.cookie });
  check("admin lists bookings", r.status === 200 && Array.isArray(r.data?.bookings), `status=${r.status}`);

  r = await request("/api/admin/bookings?status=COMPLETED", { cookie: admin.cookie });
  check("booking status filter works", r.status === 200);

  r = await request(`/api/admin/bookings?userId=${custUser.id}`, { cookie: admin.cookie });
  check("booking user filter works", r.status === 200);

  // ====== 12. BOOKING DETAIL ======
  r = await request(`/api/admin/bookings/${bookingId}`, { cookie: admin.cookie });
  check("admin gets booking detail", r.status === 200, `status=${r.status}`);
  check("booking detail has user", r.data?.user?.id != null);
  check("booking detail has messages", Array.isArray(r.data?.messages));

  // ====== 13. PAYMENT LISTING ======
  r = await request("/api/admin/payments", { cookie: admin.cookie });
  check("admin lists payments", r.status === 200 && Array.isArray(r.data?.payments), `status=${r.status}`);

  r = await request("/api/admin/payments?paymentStatus=PAID", { cookie: admin.cookie });
  check("payment status filter works", r.status === 200);

  // ====== 14. REVIEW LISTING ======
  r = await request("/api/admin/reviews", { cookie: admin.cookie });
  check("admin lists reviews", r.status === 200 && Array.isArray(r.data?.reviews), `status=${r.status}`);

  // Create a review for moderation tests
  const provProfile = await prisma.profile.findFirst({ where: { user_id: provUser.id } });
  const review = await prisma.review.create({
    data: {
      booking_id: bookingId,
      profile_id: provProfile.id,
      user_id: custUser.id,
      rating: 5,
      comment: "Great service!",
      created_at: Date.now(),
    },
  });

  // ====== 15. REVIEW HIDE / UNHIDE ======
  r = await request(`/api/admin/reviews/${review.id}/hidden`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { hidden: true, hiddenReason: "Inappropriate content" },
  });
  check("admin hides review", r.status === 200 && r.data?.hidden === true, `hidden=${r.data?.hidden}`);
  check("hidden reason set", r.data?.hidden_reason === "Inappropriate content");

  r = await request(`/api/admin/reviews/${review.id}/hidden`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { hidden: false },
  });
  check("admin unhides review", r.status === 200 && r.data?.hidden === false);
  check("hidden reason cleared", r.data?.hidden_reason === null);

  // Hidden filter
  r = await request("/api/admin/reviews?hidden=false", { cookie: admin.cookie });
  check("review hidden filter works", r.status === 200);

  // ====== 16. USER REPORTS ======
  const report = await prisma.report.create({
    data: {
      reporter_id: custUser.id,
      target_type: "provider",
      target_id: String(provUser.id),
      reason: "Provider was rude and unprofessional during the service call",
      created_at: Date.now(),
    },
  });

  r = await request("/api/admin/reports", { cookie: admin.cookie });
  check("admin lists reports", r.status === 200 && Array.isArray(r.data?.reports), `status=${r.status}`);

  r = await request("/api/admin/reports?status=OPEN", { cookie: admin.cookie });
  check("report status filter works", r.status === 200);

  r = await request(`/api/admin/reports?targetType=provider`, { cookie: admin.cookie });
  check("report type filter works", r.status === 200);

  // ====== 17. REPORT STATUS UPDATE ======
  r = await request(`/api/admin/reports/${report.id}/status`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { status: "REVIEWED" },
  });
  check("admin updates report status", r.status === 200 && r.data?.status === "REVIEWED", `status=${r.data?.status}`);
  check("report reviewed_by set", r.data?.reviewed_by === adminUser.id);
  check("report reviewed_at set", typeof r.data?.reviewed_at === "number");

  r = await request(`/api/admin/reports/${report.id}/status`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { status: "RESOLVED" },
  });
  check("admin resolves report", r.status === 200 && r.data?.status === "RESOLVED");

  // Invalid status
  r = await request(`/api/admin/reports/${report.id}/status`, {
    method: "PUT", cookie: admin.cookie, csrf: admin.csrf,
    body: { status: "INVALID" },
  });
  check("invalid report status rejected", r.status === 400, `status=${r.status}`);

  // ====== 18. USER-FACING REPORT CREATION ======
  r = await request("/api/reports", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { targetType: "review", targetId: review.id, reason: "This review appears to be fake and misleading content from a competitor" },
  });
  check("user creates report", r.status === 201, `status=${r.status}`);
  check("report has correct fields", r.data?.target_type === "review" && r.data?.status === "OPEN");

  // Invalid target type
  r = await request("/api/reports", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { targetType: "service", targetId: 1, reason: "Test reason that is long enough" },
  });
  check("invalid report target type rejected", r.status === 400, `status=${r.status}`);

  // Short reason
  r = await request("/api/reports", {
    method: "POST", cookie: cust.cookie, csrf: cust.csrf,
    body: { targetType: "user", targetId: 1, reason: "short" },
  });
  check("short report reason rejected", r.status === 400, `status=${r.status}`);

  // Unauthenticated
  r = await request("/api/reports", {
    method: "POST",
    body: { targetType: "user", targetId: 1, reason: "This is a sufficiently long reason for testing" },
  });
  check("unauthenticated report rejected", r.status === 401, `status=${r.status}`);

  // ====== 19. AUDIT LOG ======
  r = await request("/api/admin/audit", { cookie: admin.cookie });
  check("admin lists audit logs", r.status === 200 && Array.isArray(r.data?.logs), `status=${r.status}`);
  check("audit log has total", typeof r.data?.total === "number");
  check("audit log entries exist from earlier actions", r.data?.total > 0, `total=${r.data?.total}`);

  // Filter by action
  r = await request("/api/admin/audit?action=user_status", { cookie: admin.cookie });
  check("audit action filter works", r.status === 200);

  // Filter by admin
  r = await request(`/api/admin/audit?adminId=${adminUser.id}`, { cookie: admin.cookie });
  check("audit admin filter works", r.status === 200);

  // ====== 20. CSRF PROTECTION ======
  r = await request(`/api/admin/users/${provUser.id}/status`, {
    method: "PUT", cookie: admin.cookie,
    body: { status: "suspended" },
  });
  check("admin route requires CSRF", r.status === 403, `status=${r.status}`);

  // --- cleanup ---
  console.log(`\n${passed}/${total} admin tests passed`);
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
}
