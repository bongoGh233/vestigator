// Reviews & Ratings verification (server-side).
// Boots the real server against the configured PostgreSQL database, then
// exercises the review lifecycle end to end: ownership, completion gating,
// one-review-per-booking, rating/comment validation, comment sanitization,
// self-review protection, concurrency-safe rating aggregation, and the public
// reviews listing. Cleans up every test row it creates.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./db.js";

const TEST_PORT = Number(process.env.TEST_PORT) || 4195;
const BASE = process.env.TEST_BASE || `http://localhost:${TEST_PORT}`;
const SWEEP_MS = Number(process.env.TEST_SWEEP_MS) || 800;
const TEST_EMAIL_SUFFIX = "@review-test.com";
const PASSWORD = "Correct-Horse-Battery-Staple!";

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
  let r = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await request("/api/auth/register", {
      method: "POST",
      body: { name, email, password },
    });
    if (r.status === 201) break;
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  if (!r || r.status !== 201) {
    throw new Error(`register failed: ${r?.status} ${JSON.stringify(r?.data)}`);
  }
  const cookie = r.setCookie.split(";")[0];
  const csrf = r.data?.csrf;
  if (role !== "customer") {
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await prisma.user.update({ where: { email }, data: { role } });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
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

async function createProfile(actor, name) {
  const r = await request("/api/profile", {
    method: "POST",
    cookie: actor.cookie,
    csrf: actor.csrf,
    body: { name, skills: ["errands"], listed: true },
  });
  return r.data?.id;
}

async function createService(actor, title) {
  const r = await request("/api/services", {
    method: "POST",
    cookie: actor.cookie,
    csrf: actor.csrf,
    body: { title, description: "test service", category: "Errands", priceAmount: 5000, priceCurrency: "GHS", priceUnit: "flat", durationMin: 30 },
  });
  return { id: r.data?.id, status: r.status };
}

// Create a marketplace booking and drive it through accept → start → arrive →
// begin → complete so it is reviewable. Returns the booking object. The shared
// Supabase pooler is intermittently unreachable for a few seconds, so each step
// retries transient failures instead of cascading into undefined-URL 404s.
async function driveToCompleted(cust, prov, profileId, { serviceId } = {}) {
  let b = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await request("/api/bookings", {
      method: "POST",
      cookie: cust.cookie,
      csrf: cust.csrf,
      body: mkBookingBody(profileId, serviceId ? { serviceId } : {}),
    });
    if (r.status === 201) {
      b = r.data;
      break;
    }
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  if (!b || !b.id) {
    throw new Error(`driveToCompleted: booking creation failed ${JSON.stringify(b)}`);
  }
  for (const action of ["accept", "start", "arrive", "begin", "complete"]) {
    let done = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await request(`/api/bookings/${b.id}/${action}`, { method: "POST", cookie: prov.cookie, csrf: prov.csrf });
      if (r.status === 200) {
        done = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
    }
    if (!done) throw new Error(`driveToCompleted: ${action} failed for booking ${b.id}`);
  }
  return b;
}

async function main() {
  const stamp = Date.now();

  // --- actors -------------------------------------------------------------
  // The register endpoint is rate-limited to 5 per hour per server process,
  // and this suite boots a fresh server, so actors are kept to exactly 5 and
  // reused across checks. provA is a "both" user so the same actor can later
  // create a booking against their own service (self-review guard).
  const cust = await register("Review Customer", `cust-${stamp}${TEST_EMAIL_SUFFIX}`, PASSWORD);
  const cust2 = await register("Review Customer Two", `cust2-${stamp}${TEST_EMAIL_SUFFIX}`, PASSWORD);
  const provA = await register("Provider Alpha", `prova-${stamp}${TEST_EMAIL_SUFFIX}`, PASSWORD, "both");
  const provGate = await register("Provider Gate", `provgate-${stamp}${TEST_EMAIL_SUFFIX}`, PASSWORD, "provider");
  const provAgg = await register("Provider Agg", `provagg-${stamp}${TEST_EMAIL_SUFFIX}`, PASSWORD, "provider");

  const provAId = await createProfile(provA, "Provider Alpha");
  const provGateId = await createProfile(provGate, "Provider Gate");
  const provAggId = await createProfile(provAgg, "Provider Agg");
  check("all actor profiles created", [provAId, provGateId, provAggId].every((x) => typeof x === "number"));

  const provAService = await createService(provA, "Airport Run");
  const aggService = await createService(provAgg, "Aggregate Run");
  check("services created", provAService.status === 201 && aggService.status === 201);

  const getBooking = (id, cookie) => request(`/api/bookings/${id}`, { cookie });
  const getProfile = (id, cookie) => request(`/api/profiles/${id}`, { cookie });
  const getReviews = (id, cookie) => request(`/api/profiles/${id}/reviews`, { cookie });

  // ================= 1. happy path ========================================
  const b1 = await driveToCompleted(cust, provA, provAId, { serviceId: provAService.id });
  let r = await getBooking(b1.id, cust.cookie);
  check("completed booking exposes reviewed=false initially", r.status === 200 && r.data.reviewed === false, `reviewed=${r.data?.reviewed}`);

  r = await request(`/api/bookings/${b1.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5, comment: "Excellent!" } });
  check("customer reviews own completed booking → 201", r.status === 201 && typeof r.data?.reviewId === "number", `status=${r.status} ${r.data?.error || ""}`);

  r = await getBooking(b1.id, cust.cookie);
  check("reviewed flag flips to true", r.data?.reviewed === true, `reviewed=${r.data?.reviewed}`);

  r = await request(`/api/bookings/${b1.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 4 } });
  check("duplicate review → 409", r.status === 409, `status=${r.status}`);

  r = await getProfile(provAId, cust.cookie);
  check("profile aggregate after one review (5 → 5.0/1)", r.data?.rating === 5 && r.data?.ratingCount === 1, `rating=${r.data?.rating} count=${r.data?.ratingCount}`);

  // ================= 2. completion gating ==================================
  const g1 = (await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provGateId) })).data;
  r = await request(`/api/bookings/${g1.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5 } });
  check("REQUESTED cannot be reviewed → 409", r.status === 409, `status=${r.status}`);
  await request(`/api/bookings/${g1.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });

  const g2 = (await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provGateId) })).data;
  await request(`/api/bookings/${g2.id}/accept`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  r = await request(`/api/bookings/${g2.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5 } });
  check("ACCEPTED cannot be reviewed → 409", r.status === 409, `status=${r.status}`);
  await request(`/api/bookings/${g2.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });

  const g3 = (await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provGateId) })).data;
  await request(`/api/bookings/${g3.id}/accept`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  await request(`/api/bookings/${g3.id}/start`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  r = await request(`/api/bookings/${g3.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5 } });
  check("PROVIDER_EN_ROUTE cannot be reviewed → 409", r.status === 409, `status=${r.status}`);
  await request(`/api/bookings/${g3.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });

  const g4 = (await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provGateId) })).data;
  await request(`/api/bookings/${g4.id}/accept`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  await request(`/api/bookings/${g4.id}/start`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  await request(`/api/bookings/${g4.id}/arrive`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  r = await request(`/api/bookings/${g4.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5 } });
  check("ARRIVED cannot be reviewed → 409", r.status === 409, `status=${r.status}`);
  await request(`/api/bookings/${g4.id}/begin`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  await request(`/api/bookings/${g4.id}/complete`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });

  const g5 = (await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provGateId) })).data;
  await request(`/api/bookings/${g5.id}/accept`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  await request(`/api/bookings/${g5.id}/start`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  await request(`/api/bookings/${g5.id}/arrive`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  await request(`/api/bookings/${g5.id}/begin`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  r = await request(`/api/bookings/${g5.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5 } });
  check("IN_PROGRESS cannot be reviewed → 409", r.status === 409, `status=${r.status}`);
  await request(`/api/bookings/${g5.id}/complete`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });

  const g6 = (await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provGateId) })).data;
  await request(`/api/bookings/${g6.id}/cancel`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf });
  r = await request(`/api/bookings/${g6.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5 } });
  check("CANCELLED cannot be reviewed → 409", r.status === 409, `status=${r.status}`);

  const g7 = (await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provGateId) })).data;
  await request(`/api/bookings/${g7.id}/reject`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  r = await request(`/api/bookings/${g7.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5 } });
  check("REJECTED cannot be reviewed → 409", r.status === 409, `status=${r.status}`);

  const g8 = (await request("/api/bookings", { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: mkBookingBody(provGateId) })).data;
  await prisma.booking.update({ where: { id: g8.id }, data: { expires_at: BigInt(Date.now() - 1000) } });
  await request(`/api/bookings/${g8.id}/accept`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf });
  const g8Status = await poll(async () => {
    const s = (await getBooking(g8.id, cust.cookie)).data?.status;
    return s === "EXPIRED" ? s : null;
  });
  check("sweeper expires the pending request", g8Status === "EXPIRED", `status=${g8Status}`);
  r = await request(`/api/bookings/${g8.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5 } });
  check("EXPIRED cannot be reviewed → 409", r.status === 409, `status=${r.status}`);

  // ================= 3. rating validation ==================================
  const v1 = await driveToCompleted(cust2, provGate, provGateId);
  const reviewAttempt = (body) => request(`/api/bookings/${v1.id}/review`, { method: "POST", cookie: cust2.cookie, csrf: cust2.csrf, body });
  r = await reviewAttempt({ rating: 6 });
  check("rating above 5 → 400", r.status === 400, `status=${r.status}`);
  r = await reviewAttempt({ rating: 0 });
  check("rating below 1 → 400", r.status === 400);
  r = await reviewAttempt({ rating: 3.5 });
  check("fractional rating → 400", r.status === 400);
  r = await reviewAttempt({ rating: "5" });
  check("string rating → 400", r.status === 400, `status=${r.status}`);
  r = await reviewAttempt({});
  check("missing rating → 400", r.status === 400);
  r = await reviewAttempt({ rating: null });
  check("null rating → 400", r.status === 400);
  r = await reviewAttempt({ rating: 4 });
  check("valid rating 4 still accepted", r.status === 201, `status=${r.status} ${r.data?.error || ""}`);

  // ================= 4. comment validation & sanitization ==================
  const s1 = await driveToCompleted(cust, provGate, provGateId);
  r = await request(`/api/bookings/${s1.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 4, comment: "x".repeat(501) } });
  check("comment over 500 → 400", r.status === 400, `status=${r.status} ${r.data?.error || ""}`);
  r = await request(`/api/bookings/${s1.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 4, comment: { nested: true } } });
  check("object comment → 400", r.status === 400);
  r = await request(`/api/bookings/${s1.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 4, comment: ["array"] } });
  check("array comment → 400", r.status === 400);

  const s2 = await driveToCompleted(cust2, provGate, provGateId);
  r = await request(`/api/bookings/${s2.id}/review`, { method: "POST", cookie: cust2.cookie, csrf: cust2.csrf, body: { rating: 4, comment: "  Clean   up   here\u0000\u0007  " } });
  check("dirty comment accepted after sanitization", r.status === 201, `status=${r.status} ${r.data?.error || ""}`);
  r = await getReviews(provGateId, cust.cookie);
  const comments = (r.data?.reviews || []).map((x) => x.comment);
  check("control chars stripped + whitespace collapsed", comments.includes("Clean up here"), `comments=${JSON.stringify(comments)}`);

  const s3 = await driveToCompleted(cust2, provGate, provGateId);
  r = await request(`/api/bookings/${s3.id}/review`, { method: "POST", cookie: cust2.cookie, csrf: cust2.csrf, body: { rating: 5 } });
  check("rating-only review (empty comment) → 201", r.status === 201, `status=${r.status}`);

  // ================= 5. authorization ======================================
  const n1 = await driveToCompleted(cust2, provA, provAId, { serviceId: provAService.id });
  r = await request(`/api/bookings/${n1.id}/review`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: { rating: 5 } });
  check("provider cannot review (not booking owner) → 404", r.status === 404, `status=${r.status}`);
  r = await request(`/api/bookings/${n1.id}/review`, { method: "POST", cookie: provGate.cookie, csrf: provGate.csrf, body: { rating: 5 } });
  check("unrelated actor cannot review → 404", r.status === 404, `status=${r.status}`);

  const self = await driveToCompleted(provA, provA, provAId, { serviceId: provAService.id });
  r = await request(`/api/bookings/${self.id}/review`, { method: "POST", cookie: provA.cookie, csrf: provA.csrf, body: { rating: 5, comment: "self review" } });
  check("provider cannot review their own service → 409", r.status === 409, `status=${r.status} ${r.data?.error || ""}`);

  // ================= 6. aggregate correctness ==============================
  const rounds = [
    [cust, 5, "round 1"],
    [cust2, 4, "round 2"],
    [cust2, 3, "round 3"],
  ];
  for (const [actor, rating, comment] of rounds) {
    const b = await driveToCompleted(actor, provAgg, provAggId, { serviceId: aggService.id });
    r = await request(`/api/bookings/${b.id}/review`, { method: "POST", cookie: actor.cookie, csrf: actor.csrf, body: { rating, comment } });
    check(`aggregate review (${comment}) → 201`, r.status === 201, `status=${r.status}`);
  }
  r = await getProfile(provAggId, cust.cookie);
  check("aggregate avg/count after 5,4,3 → 4.0/3", r.data?.rating === 4 && r.data?.ratingCount === 3, `rating=${r.data?.rating} count=${r.data?.ratingCount}`);

  r = await getReviews(provAggId, cust.cookie);
  check("reviews listing returns 3 newest-first", r.status === 200 && r.data?.reviews?.length === 3 && r.data.reviews[0].comment === "round 3", `status=${r.status} first=${r.data?.reviews?.[0]?.comment}`);
  check(
    "reviews listing never leaks emails",
    (r.data?.reviews || []).every((x) => x.reviewer?.name && !x.reviewer?.email) && !JSON.stringify(r.data).includes("@"),
    ""
  );

  r = await request("/api/services?q=Airport", { cookie: cust.cookie });
  const aggItem = r.data?.find((s) => s.provider?.id === provAId);
  check("service listing carries provider rating aggregates", aggItem?.provider?.ratingAvg === 5 && aggItem?.provider?.ratingCount === 1, `item=${JSON.stringify(aggItem?.provider)}`);

  r = await request("/api/profiles", { cookie: cust.cookie });
  const dirAgg = r.data?.find((p) => p.id === provAggId);
  check("directory exposes rating aggregates", !!dirAgg && dirAgg.rating === 4 && dirAgg.ratingCount === 3, `dir=${JSON.stringify(dirAgg && { rating: dirAgg.rating, ratingCount: dirAgg.ratingCount })}`);

  // ================= 7. concurrency ========================================
  // provAgg already holds the 5,4,3 reviews (avg 4.0, count 3); the concurrent
  // reviews below add 5 and 3 → avg 4.0, count 5, then the racing reviews add
  // exactly one more → count 6.
  const c1 = await driveToCompleted(cust, provAgg, provAggId);
  const c2 = await driveToCompleted(cust2, provAgg, provAggId);
  const [ra, rb] = await Promise.all([
    request(`/api/bookings/${c1.id}/review`, { method: "POST", cookie: cust.cookie, csrf: cust.csrf, body: { rating: 5 } }),
    request(`/api/bookings/${c2.id}/review`, { method: "POST", cookie: cust2.cookie, csrf: cust2.csrf, body: { rating: 3 } }),
  ]);
  check("concurrent reviews on different bookings both succeed", ra.status === 201 && rb.status === 201, `a=${ra.status} b=${rb.status}`);
  r = await getProfile(provAggId, cust.cookie);
  check("concurrent reviews → exact aggregate (avg 4.0, count 5)", r.data?.rating === 4 && r.data?.ratingCount === 5, `rating=${r.data?.rating} count=${r.data?.ratingCount}`);

  const c3 = await driveToCompleted(cust2, provAgg, provAggId);
  const [rc, rd] = await Promise.all([
    request(`/api/bookings/${c3.id}/review`, { method: "POST", cookie: cust2.cookie, csrf: cust2.csrf, body: { rating: 2 } }),
    request(`/api/bookings/${c3.id}/review`, { method: "POST", cookie: cust2.cookie, csrf: cust2.csrf, body: { rating: 4 } }),
  ]);
  check("same-booking race → exactly one 201 and one 409", (rc.status === 201 && rd.status === 409) || (rc.status === 409 && rd.status === 201), `a=${rc.status} b=${rd.status}`);
  r = await getProfile(provAggId, cust.cookie);
  check("rating_count reflects only the winning raced review", r.data?.ratingCount === 6, `count=${r.data?.ratingCount}`);

  // ================= 8. reviews listing guards =============================
  r = await getReviews(provAId, null);
  check("reviews listing requires auth → 401", r.status === 401, `status=${r.status}`);
  r = await getReviews(999999999, cust.cookie);
  check("unknown profile reviews → 404", r.status === 404, `status=${r.status}`);
  r = await getReviews("abc", cust.cookie);
  check("non-integer profile reviews → 404", r.status === 404, `status=${r.status}`);
  await prisma.profile.update({ where: { id: provGateId }, data: { is_active: false } });
  r = await getReviews(provGateId, cust.cookie);
  check("inactive profile reviews → 404", r.status === 404, `status=${r.status}`);
  await prisma.profile.update({ where: { id: provGateId }, data: { is_active: true } });

  console.log(ok ? "\nALL REVIEWS CHECKS PASSED" : "\nSOME REVIEWS CHECKS FAILED");
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
