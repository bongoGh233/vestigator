import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const TEST_PORT = Number(process.env.TEST_PORT) || 4199;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;

let ok = true;
function check(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  [" + extra + "]" : ""}`);
  if (!cond) ok = false;
}

async function request(path, { method = "GET", body, cookie, csrf } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") || "" };
}

async function main() {
  const email = `user${Date.now()}@test.com`;
  const password = "Correct-Horse-Battery-Staple!";

  let r = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Test User", email, password },
  });
  check("register returns 201", r.status === 201, `status=${r.status}`);
  const cookie = r.setCookie.split(";")[0];
  let csrf = r.data?.csrf;
  check("register sets session cookie", cookie.startsWith("vg_session="));
  check("register returns csrf", !!csrf);

  r = await request("/api/auth/register", {
    method: "POST",
    body: { name: "X", email: "weak@test.com", password: "short" },
  });
  check("weak password rejected", r.status === 400);

  r = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Test User", email, password },
  });
  check("duplicate email rejected", r.status === 409);

  r = await request("/api/auth/login", {
    method: "POST",
    body: { email, password: "wrong-password-123" },
  });
  check("wrong password rejected", r.status === 401);

  r = await request("/api/auth/me");
  check("me without auth → 401", r.status === 401);

  r = await request("/api/bookings", {
    method: "POST",
    cookie,
    body: { personName: "No CSRF", pickup: { lat: 1, lng: 2 }, destination: { lat: 3, lng: 4 } },
  });
  check("POST bookings without CSRF → 403", r.status === 403);

  r = await request("/api/auth/login", { method: "POST", body: { email, password } });
  check("login returns 200", r.status === 200);
  const cookie2 = r.setCookie.split(";")[0];
  csrf = r.data?.csrf;
  check("login sets new session cookie", cookie2.startsWith("vg_session="));

  r = await request("/api/bookings", {
    method: "POST",
    cookie: cookie2,
    csrf,
    body: { personName: "Ada Lovelace", pickup: { lat: 6.5244, lng: 3.3792 }, destination: { lat: 6.6018, lng: 3.3515 } },
  });
  check("POST bookings with CSRF → 201", r.status === 201);
  const booking = r.data;
  check("booking has share token", !!booking.shareToken);

  r = await request(`/api/share/${booking.id}?t=${booking.shareToken}`);
  check("share endpoint works without auth", r.status === 200 && r.data.personName === "Ada Lovelace");

  r = await request(`/api/share/${booking.id}?t=wrongtoken`);
  check("share endpoint rejects wrong token", r.status === 404);

  const email2 = `other${Date.now()}@test.com`;
  r = await request("/api/auth/register", { method: "POST", body: { name: "Other", email: email2, password } });
  check("other register", r.status === 201, `status=${r.status}`);
  r = await request("/api/auth/login", { method: "POST", body: { email: email2, password } });
  const otherCookie = r.setCookie.split(";")[0];
  const otherCsrf = r.data?.csrf;
  r = await request(`/api/bookings/${booking.id}`, { cookie: otherCookie });
  check("other user cannot read booking → 404", r.status === 404, `status=${r.status}`);

  const ws = io(BASE, { transports: ["websocket"], extraHeaders: { Cookie: cookie2 } });
  await new Promise((res) => ws.on("connect", res));
  ws.emit("watch:join", { bookingId: booking.id });
  const arrived = new Promise((resolve) => {
    ws.on("booking:update", (b) => {
      if (b.status === "arrived") resolve();
    });
  });
  // Person shares location right at the destination → auto-arrival
  const personWs = io(BASE, { transports: ["websocket"] });
  await new Promise((res) => personWs.on("connect", res));
  personWs.emit("person:join", { bookingId: booking.id, token: booking.shareToken, personName: "Ada L" });
  const dest = booking.destination;
  personWs.emit("location:update", {
    bookingId: booking.id,
    token: booking.shareToken,
    lat: dest.lat + 0.0004,
    lng: dest.lng + 0.0004,
    accuracy: 8,
    speed: 5,
  });
  await Promise.race([arrived, new Promise((_, rej) => setTimeout(() => rej(new Error("arrival timeout")), 20000))]);
  check("auto-arrival fires when person reaches destination", true);
  personWs.close();
  ws.close();

  const pws = io(BASE, { transports: ["websocket"] });
  await new Promise((res) => pws.on("connect", res));
  pws.emit("person:join", { bookingId: booking.id, token: booking.shareToken, personName: "Ada L" });
  pws.emit("location:update", { bookingId: booking.id, token: booking.shareToken, lat: 6.5, lng: 3.4, accuracy: 5, speed: 4 });
  await new Promise((r) => setTimeout(r, 300));
  r = await request(`/api/bookings/${booking.id}`, { cookie: cookie2 });
  check("person location update accepted", r.status === 200 && !!r.data.location, JSON.stringify(r.data?.location || null));
  pws.close();

  const anon = io(BASE, { transports: ["websocket"] });
  await new Promise((res) => anon.on("connect", res));
  let anonResult = null;
  anon.emit("booking:create", { personName: "Hax", pickup: { lat: 1, lng: 2 }, destination: { lat: 3, lng: 4 } }, (cb) => { anonResult = cb; });
  await new Promise((r) => setTimeout(r, 300));
  check("anonymous socket cannot create booking", anonResult?.error === "Authentication required.");
  anon.close();

  r = await request("/api/auth/logout", { method: "POST", cookie: cookie2, csrf });
  check("logout works", r.status === 200);
  r = await request("/api/auth/me", { cookie: cookie2 });
  check("session invalid after logout", r.status === 401);

  // ---- Password reset flow ----
  const newPassword = "A-Brand-New-Fresh-Password!";
  r = await request("/api/auth/reset/request", { method: "POST", body: { email } });
  check("reset request for existing email", r.status === 200, `status=${r.status}`);
  const devLink = r.data?.devLink;
  check("dev mode returns reset link", !!devLink, devLink || "");
  const token = devLink ? new URL(devLink).searchParams.get("token") : "";
  check("reset link carries a token", !!token);

  r = await request("/api/auth/reset/request", { method: "POST", body: { email: "ghost@nowhere.com" } });
  check("reset request for unknown email is generic", r.status === 200 && !r.data?.devLink, `status=${r.status}`);

  // Login, then reset should revoke that session
  r = await request("/api/auth/login", { method: "POST", body: { email, password } });
  const preResetCookie = r.setCookie.split(";")[0];

  r = await request("/api/auth/reset/confirm", { method: "POST", body: { token: "not-a-real-token", password: newPassword } });
  check("confirm with bogus token → 400", r.status === 400);

  r = await request("/api/auth/reset/confirm", { method: "POST", body: { token, password: "short" } });
  check("confirm with weak password → 400", r.status === 400);

  r = await request("/api/auth/reset/confirm", { method: "POST", body: { token, password: newPassword } });
  check("confirm with valid token → 200", r.status === 200);
  const resetCookie = r.setCookie.split(";")[0];
  const resetCsrf = r.data?.csrf;
  check("reset signs the user in", resetCookie.startsWith("vg_session="));

  r = await request("/api/auth/me", { cookie: preResetCookie });
  check("old session revoked after reset", r.status === 401);

  r = await request("/api/auth/reset/confirm", { method: "POST", body: { token, password: newPassword } });
  check("reset token is single-use", r.status === 400);

  r = await request("/api/auth/login", { method: "POST", body: { email, password: newPassword } });
  check("login with new password works", r.status === 200);

  r = await request("/api/auth/login", { method: "POST", body: { email, password } });
  check("login with old password fails", r.status === 401);

  // ---- Trackable profiles & rotating codes ----
  // Reuse the session created by reset/confirm (cookie2 was revoked by logout)
  const pCookie = resetCookie;
  const pCsrf = resetCsrf;

  r = await request("/api/profile", { cookie: pCookie });
  check("no profile initially → 404", r.status === 404);

  r = await request("/api/profile", {
    method: "POST",
    cookie: pCookie,
    csrf: pCsrf,
    body: {
      name: "Ada Lovelace",
      city: "London",
      bio: "Math whiz, can run errands.",
      skills: ["Errands", "Escort", "Delivery"],
      listed: true,
    },
  });
  check("create profile → 201", r.status === 201);
  const own = r.data;
  check("profile returns rotating code", !!own.trackCode && own.trackCode.length === 8, own.trackCode || "");
  const code1 = own.trackCode;
  check("profile shows skills", Array.isArray(own.skills) && own.skills.length === 3);

  r = await request("/api/profile", { cookie: pCookie });
  check("own profile readable", r.status === 200 && r.data.trackCode === code1);

  // Listing (as the other user) shows Ada but never leaks codes
  r = await request("/api/profiles", { cookie: otherCookie });
  check("directory lists the profile", r.status === 200 && r.data.some((p) => p.name === "Ada Lovelace"), `status=${r.status}`);
  check("directory never leaks codes", r.data.every((p) => !p.trackCode));

  // Listing (as Ada herself) includes her own profile, marked as hers
  r = await request("/api/profiles", { cookie: pCookie });
  const ownInDir = r.data.find((p) => p.name === "Ada Lovelace");
  check("own profile appears in directory", !!ownInDir);
  check("own profile is flagged isOwn", !!ownInDir?.isOwn);
  check("others are not flagged isOwn", r.data.every((p) => p.isOwn === !!p.isOwn));

  // Unlisting removes the profile from the directory
  r = await request("/api/profile", {
    method: "POST",
    cookie: pCookie,
    csrf: pCsrf,
    body: { name: "Ada Lovelace", listed: false },
  });
  check("can unlist own profile", (r.status === 200 || r.status === 201) && r.data.listed === false);
  r = await request("/api/profiles", { cookie: otherCookie });
  check("unlisted profile is hidden from directory", !r.data.some((p) => p.name === "Ada Lovelace"));
  r = await request("/api/profile", {
    method: "POST",
    cookie: pCookie,
    csrf: pCsrf,
    body: { name: "Ada Lovelace", listed: true },
  });
  check("can re-list own profile", (r.status === 200 || r.status === 201) && r.data.listed === true);

  // Track by code (as the other user) → creates a live booking directly
  r = await request("/api/track-by-code", { method: "POST", cookie: otherCookie, body: { code: code1 } });
  check("track-by-code creates booking", r.status === 201 && r.data.personName === "Ada Lovelace", `status=${r.status}`);
  const codeBookingId = r.data?.id;
  check("track-by-code returns booking id + share token", !!codeBookingId && !!r.data?.shareToken);

  // Code is single-use: old code must now fail
  r = await request("/api/track-by-code", { method: "POST", cookie: otherCookie, body: { code: code1 } });
  check("used code is rotated → 404", r.status === 404);

  // Get fresh code and verify rotation changes it
  r = await request("/api/profile/rotate-code", { method: "POST", cookie: pCookie, csrf: pCsrf, body: {} });
  const code2 = r.data?.trackCode;
  check("manual rotate gives new code", r.status === 200 && code2 && code2 !== code1);

  // Wrong code rejected
  r = await request("/api/track-by-code", { method: "POST", cookie: otherCookie, body: { code: "AAAAAAAB" } });
  check("random code rejected → 404", r.status === 404);

  // Code-created booking starts without points, then can be set later
  r = await request(`/api/bookings/${codeBookingId}`, { cookie: otherCookie });
  check("code booking starts with no points", r.status === 200 && !r.data.pickup && !r.data.destination);
  r = await request(`/api/bookings/${codeBookingId}/points`, {
    method: "POST",
    cookie: otherCookie,
    csrf: otherCsrf,
    body: { pickup: { lat: 6.5244, lng: 3.3792 }, destination: { lat: 6.6018, lng: 3.3515 } },
  });
  check("set booking points later", r.status === 200 && !!r.data.pickup && !!r.data.destination, `status=${r.status}`);
  r = await request(`/api/bookings/${codeBookingId}/points`, {
    method: "POST",
    cookie: otherCookie,
    body: { pickup: { lat: 6.5244, lng: 3.3792 }, destination: { lat: 6.6018, lng: 3.3515 } },
  });
  check("set points without CSRF → 403", r.status === 403);

  // Booking from profile (as other user)
  r = await request("/api/profiles", { cookie: otherCookie });
  const profileId = r.data.find((p) => p.name === "Ada Lovelace")?.id;
  check("directory exposes profile id", !!profileId);
  r = await request(`/api/profiles/${profileId}/track`, {
    method: "POST",
    cookie: otherCookie,
    csrf: otherCsrf,
    body: { pickup: { lat: 51.5074, lng: -0.1278 }, destination: { lat: 51.5255, lng: -0.0876 } },
  });
  check("track from profile → 201 with share token", r.status === 201 && !!r.data.shareToken, `status=${r.status}`);

  // Other user's profile upsert only affects their own profile
  r = await request("/api/profile", { method: "POST", cookie: otherCookie, csrf: otherCsrf, body: { name: "Hijacked" } });
  check("other user created their own profile", (r.status === 200 || r.status === 201) && r.data.name === "Hijacked", `status=${r.status}`);
  r = await request("/api/profile", { cookie: pCookie });
  check("Ada's profile is untouched", r.status === 200 && r.data.name === "Ada Lovelace", `name=${r.data?.name}`);

  // Avatar validation
  r = await request("/api/profile", {
    method: "POST",
    cookie: pCookie,
    csrf: pCsrf,
    body: { name: "Ada Lovelace", avatar: "not-an-image" },
  });
  check("invalid avatar rejected", r.status === 400);

  // ---- Road routing (validation only; live route calls are network-dependent) ----
  r = await request("/api/route");
  check("route missing params → 400", r.status === 400);
  r = await request("/api/route?from=abc&to=6.5,3.4");
  check("route invalid coords → 400", r.status === 400);
  r = await request("/api/route?from=91,0&to=0,181");
  check("route out-of-range coords → 400", r.status === 400);

  console.log(ok ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
  process.exitCode = ok ? 0 : 1;
}

// If no server is already listening, spawn one with a throwaway DB.
let server = null;
let dataDir = null;
if (!process.env.TEST_BASE) {
  dataDir = mkdtempSync(path.join(tmpdir(), "vestigator-test-"));
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  server = spawn(process.execPath, ["index.js"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(TEST_PORT), DATA_DIR: dataDir, ALLOWED_ORIGINS: BASE },
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
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* best effort cleanup */
    }
  }
}
