// Schema v2 (marketplace foundation) verification.
// Verifies the additive migration against the live PostgreSQL database:
// new tables/columns, CHECK constraints, partial unique indexes, FKs and
// one-review-per-booking. Cleans up every row it creates.
import { prisma } from "./db.js";

let ok = true;
function check(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  [" + extra + "]" : ""}`);
  if (!cond) ok = false;
}

const RUN = `s${Date.now()}`;
const email = (n) => `${n}-${RUN}@schema-test.com`;

async function pgCode(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err?.meta?.code || err?.code || null;
  }
}

const created = { users: [], bookings: [], services: [], reviews: [], availability: [] };

async function main() {
  const t0 = Date.now();

  // --- tables / columns -------------------------------------------------
  const tables = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  const names = new Set(tables.map((t) => t.table_name));
  check("services table exists", names.has("services"));
  check("reviews table exists", names.has("reviews"));
  check("availability table exists", names.has("availability"));
  check("messages table exists", names.has("messages"));
  check("notifications table exists", names.has("notifications"));
  check("reports table exists", names.has("reports"));
  check("audit_logs table exists", names.has("audit_logs"));

  const cols = await prisma.$queryRawUnsafe(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const hasCol = (t, c) => cols.some((r) => r.table_name === t && r.column_name === c);
  check("users.role added", hasCol("users", "role"));
  check("users.status added", hasCol("users", "status"));
  check("profiles.rating_avg added", hasCol("profiles", "rating_avg"));
  check("profiles.rating_count added", hasCol("profiles", "rating_count"));
  check("profiles.service_area added", hasCol("profiles", "service_area"));
  check("profiles.timezone added", hasCol("profiles", "timezone"));
  check("profiles.verified added", hasCol("profiles", "verified"));
  check("reviews.hidden added", hasCol("reviews", "hidden"));
  check("reviews.hidden_reason added", hasCol("reviews", "hidden_reason"));
  for (const c of ["profile_id", "service_id", "price_amount", "price_currency", "accepted_at", "started_at", "completed_at", "expires_at", "reviewed", "payment_status", "payment_method", "paid_at", "platform_fee"]) {
    check(`bookings.${c} added`, hasCol("bookings", c));
  }
  for (const c of ["profile_id", "title", "description", "category", "price_amount", "price_currency", "price_unit", "duration_min", "active", "created_at", "updated_at"]) {
    check(`services.${c} exists`, hasCol("services", c));
  }
  for (const c of ["booking_id", "profile_id", "user_id", "rating", "comment", "created_at"]) {
    check(`reviews.${c} exists`, hasCol("reviews", c));
  }
  for (const c of ["profile_id", "dow", "start_min", "end_min", "active"]) {
    check(`availability.${c} exists`, hasCol("availability", c));
  }
  for (const c of ["booking_id", "sender_id", "body", "created_at", "read_at"]) {
    check(`messages.${c} exists`, hasCol("messages", c));
  }
  for (const c of ["user_id", "type", "title", "body", "link", "ref_type", "ref_id", "read_at", "created_at"]) {
    check(`notifications.${c} exists`, hasCol("notifications", c));
  }
  for (const c of ["reporter_id", "target_type", "target_id", "reason", "status", "created_at", "reviewed_at", "reviewed_by"]) {
    check(`reports.${c} exists`, hasCol("reports", c));
  }
  for (const c of ["admin_id", "action", "target_type", "target_id", "meta", "created_at"]) {
    check(`audit_logs.${c} exists`, hasCol("audit_logs", c));
  }

  // --- users + profiles + service ---------------------------------------
  const cust = await prisma.user.create({
    data: { name: "Schema Customer", email: email("cust"), password_hash: "x", created_at: t0, role: "customer" },
  });
  const prov = await prisma.user.create({
    data: { name: "Schema Provider", email: email("prov"), password_hash: "x", created_at: t0, role: "provider" },
  });
  const prov2 = await prisma.user.create({
    data: { name: "Schema Provider 2", email: email("prov2"), password_hash: "x", created_at: t0, role: "provider" },
  });
  created.users.push(cust.id, prov.id, prov2.id);
  check("users.role stores 'customer'/'provider'", cust.role === "customer" && prov.role === "provider");

  const mkProfile = (userId, name, trackCode) =>
    prisma.profile.create({
      data: {
        user_id: userId,
        name,
        track_code: trackCode,
        code_expires_at: t0 + 60_000,
        created_at: t0,
        updated_at: t0,
      },
    });
  const p1 = await mkProfile(prov.id, "Provider One", `${RUN}A`);
  const p2 = await mkProfile(prov2.id, "Provider Two", `${RUN}B`);
  created.users.length; // (profile cleanup is handled by user cascade)

  const svc = await prisma.service.create({
    data: { profile_id: p1.id, title: "Errand", price_amount: 1500, created_at: t0, updated_at: t0 },
  });
  created.services.push(svc.id);
  check("service defaults applied", svc.price_currency === "GHS" && svc.price_unit === "flat" && svc.active === true);

  const mkBooking = (data) => prisma.booking.create({
    data: {
      id: `sb-${Math.random().toString(36).slice(2, 10)}-${RUN}`,
      user_id: data.user_id,
      profile_id: data.profile_id ?? null,
      service_id: data.service_id ?? null,
      share_token: `st-${Math.random().toString(36).slice(2, 12)}`,
      code: Math.random().toString(36).slice(2, 8).toUpperCase(),
      person_name: data.person_name || "Schema Person",
      status: data.status || "REQUESTED",
      created_at: t0,
      price_amount: data.price_amount ?? null,
      ...(data.pickup ? { pickup: data.pickup } : {}),
    },
  });

  // --- CHECK constraints -------------------------------------------------
  check(
    "users.role CHECK rejects unknown role",
    (await pgCode(() =>
      prisma.$executeRaw`UPDATE "users" SET "role" = 'superadmin' WHERE "id" = ${prov.id}`
    )) === "23514"
  );

  check(
    "users.role CHECK accepts 'admin'",
    (await pgCode(() =>
      prisma.$executeRaw`UPDATE "users" SET "role" = 'admin' WHERE "id" = ${prov.id}`
    )) === null
  );
  // Revert to provider for remaining tests
  await prisma.user.update({ where: { id: prov.id }, data: { role: "provider" } });

  check(
    "bookings.status CHECK accepts legacy 'pending'",
    (await pgCode(() => mkBooking({ user_id: cust.id, status: "pending" }))) === null
  );
  check(
    "bookings.status CHECK accepts 'REQUESTED'",
    (await pgCode(() => mkBooking({ user_id: cust.id, status: "REQUESTED" }))) === null
  );
  check(
    "bookings.status CHECK rejects bogus status",
    (await pgCode(() =>
      prisma.$executeRaw`INSERT INTO "bookings" ("id", "user_id", "share_token", "code", "person_name", "created_at", "status")
        VALUES (${`bad-status-${RUN}`}, ${cust.id}, 'x', 'y', 'p', ${t0}, 'nonsense')`
    )) === "23514"
  );

  check(
    "services.price_amount CHECK rejects negative price",
    (await pgCode(() =>
      prisma.$executeRaw`INSERT INTO "services" ("profile_id", "title", "price_amount", "created_at", "updated_at")
        VALUES (${p1.id}, 'Bad', ${-5}, ${t0}, ${t0})`
    )) === "23514"
  );
  check(
    "services.price_unit CHECK rejects unknown unit",
    (await pgCode(() =>
      prisma.$executeRaw`INSERT INTO "services" ("profile_id", "title", "price_amount", "price_unit", "created_at", "updated_at")
        VALUES (${p1.id}, 'Bad', ${10}, 'per_kg', ${t0}, ${t0})`
    )) === "23514"
  );

  check(
    "availability.dow CHECK rejects out-of-range day",
    (await pgCode(() =>
      prisma.$executeRaw`INSERT INTO "availability" ("profile_id", "dow", "start_min", "end_min") VALUES (${p1.id}, ${7}, ${0}, ${60})`
    )) === "23514"
  );
  check(
    "availability window CHECK rejects end <= start",
    (await pgCode(() =>
      prisma.$executeRaw`INSERT INTO "availability" ("profile_id", "dow", "start_min", "end_min") VALUES (${p1.id}, ${1}, ${120}, ${60})`
    )) === "23514"
  );
  const av = await prisma.availability.create({
    data: { profile_id: p1.id, dow: 1, start_min: 480, end_min: 1080 },
  });
  created.availability.push(av.id);
  check("valid availability window accepted", !!av.id);

  // --- review constraints ------------------------------------------------
  const revBooking = await mkBooking({ user_id: cust.id, profile_id: p1.id, status: "COMPLETED" });
  created.bookings.push(revBooking.id);
  check(
    "reviews.rating CHECK rejects 6",
    (await pgCode(() =>
      prisma.$executeRaw`INSERT INTO "reviews" ("booking_id", "profile_id", "user_id", "rating", "created_at")
        VALUES (${`rv-bad-${RUN}`}, ${p1.id}, ${cust.id}, ${6}, ${t0})`
    )) === "23514"
  );
  check(
    "reviews.rating CHECK rejects 0",
    (await pgCode(() =>
      prisma.$executeRaw`INSERT INTO "reviews" ("booking_id", "profile_id", "user_id", "rating", "created_at")
        VALUES (${`rv-bad0-${RUN}`}, ${p1.id}, ${cust.id}, ${0}, ${t0})`
    )) === "23514"
  );
  const rv = await prisma.review.create({
    data: { booking_id: revBooking.id, profile_id: p1.id, user_id: cust.id, rating: 4, created_at: t0 },
  });
  created.reviews.push(rv.id);
  check("review rating 4 accepted", !!rv.id);
  check(
    "one review per booking (unique booking_id)",
    (await pgCode(() =>
      prisma.review.create({
        data: { booking_id: revBooking.id, profile_id: p1.id, user_id: cust.id, rating: 2, created_at: t0 },
      })
    )) === "P2002"
  );

  // --- partial unique indexes --------------------------------------------
  const b1 = await mkBooking({ user_id: cust.id, profile_id: p1.id, status: "REQUESTED" });
  created.bookings.push(b1.id);
  check(
    "one active booking per provider: 2nd REQUESTED blocked",
    (await pgCode(() =>
      prisma.booking.create({
        data: {
          id: `sb2-${Math.random().toString(36).slice(2, 10)}-${RUN}`,
          user_id: prov.id,
          profile_id: p1.id,
          share_token: "st-x",
          code: "XXXX",
          person_name: "P",
          status: "REQUESTED",
          created_at: t0,
        },
      })
    )) === "P2002"
  );
  check(
    "duplicate request from same customer to same provider blocked",
    (await pgCode(() =>
      mkBooking({ user_id: cust.id, profile_id: p1.id, status: "REQUESTED" })
    )) === "P2002"
  );

  // resolve the active request so history can be tested
  await prisma.booking.update({ where: { id: b1.id }, data: { status: "REJECTED" } });
  const doneB = await mkBooking({ user_id: cust.id, profile_id: p1.id, status: "COMPLETED" });
  created.bookings.push(doneB.id);
  check(
    "historical COMPLETED booking does not block a new active booking",
    (await pgCode(() => mkBooking({ user_id: cust.id, profile_id: p1.id, status: "REQUESTED" }))) === null
  );
  check(
    "legacy booking without profile_id is not restricted by provider index",
    (await pgCode(() => mkBooking({ user_id: cust.id, status: "pending" }))) === null
  );

  // --- FK behavior -------------------------------------------------------
  const p2Booking = await mkBooking({ user_id: cust.id, profile_id: p2.id, status: "ACCEPTED" });
  created.bookings.push(p2Booking.id);
  const svc2 = await prisma.service.create({
    data: { profile_id: p2.id, title: "Gone soon", price_amount: 100, created_at: t0, updated_at: t0 },
  });
  created.services.push(svc2.id);
  await prisma.profile.delete({ where: { id: p2.id } });
  const p2After = await prisma.booking.findUnique({ where: { id: p2Booking.id } });
  check("deleting provider profile SET NULLs booking.profile_id (history kept)", p2After !== null && p2After.profile_id === null);
  const gone = await prisma.service.count({ where: { id: svc2.id } });
  check("deleting provider profile cascades services", gone === 0);

  // --- role backfill behavior --------------------------------------------
  const withProfile = await prisma.user.findUnique({ where: { id: prov.id }, include: { profiles: true } });
  check("provider role is preserved as 'provider'", withProfile?.role === "provider");

  // --- admin & moderation tables -----------------------------------------
  check(
    "users.status CHECK rejects invalid status",
    (await pgCode(() =>
      prisma.$executeRaw`UPDATE "users" SET "status" = 'banned' WHERE "id" = ${cust.id}`
    )) === "23514"
  );
  check(
    "users.status accepts 'suspended'",
    (await pgCode(() =>
      prisma.$executeRaw`UPDATE "users" SET "status" = 'suspended' WHERE "id" = ${cust.id}`
    )) === null
  );
  await prisma.user.update({ where: { id: cust.id }, data: { status: "active" } });

  const report = await prisma.report.create({
    data: {
      reporter_id: cust.id,
      target_type: "user",
      target_id: String(prov.id),
      reason: "Test report for schema verification",
      created_at: t0,
    },
  });
  check("report created", !!report?.id);

  check(
    "reports.target_type CHECK rejects invalid type",
    (await pgCode(() =>
      prisma.$executeRaw`INSERT INTO "reports" ("reporter_id", "target_type", "target_id", "reason", "created_at")
        VALUES (${cust.id}, 'service', '1', 'bad', ${t0})`
    )) === "23514"
  );

  check(
    "reports.status CHECK rejects invalid status",
    (await pgCode(() =>
      prisma.$executeRaw`INSERT INTO "reports" ("reporter_id", "target_type", "target_id", "reason", "status", "created_at")
        VALUES (${cust.id}, 'user', '1', 'bad reason that is long enough', 'CLOSED', ${t0})`
    )) === "23514"
  );

  const audit = await prisma.auditLog.create({
    data: {
      admin_id: prov.id,
      action: "test_action",
      target_type: "user",
      target_id: String(cust.id),
      created_at: t0,
    },
  });
  check("audit_log created", !!audit?.id);

  // Cascade: deleting the user who created reports/audit_logs should cascade
  await prisma.report.delete({ where: { id: report.id } });
  await prisma.auditLog.delete({ where: { id: audit.id } });

  console.log("");
  console.log(ok ? "SCHEMA CHECKS PASSED" : "SCHEMA CHECKS FAILED");
  return ok;
}

async function run() {
  let ok = false;
  try {
    ok = await main();
  } catch (err) {
    console.error("schema-test crashed:", err);
  } finally {
    await prisma.user
      .deleteMany({ where: { email: { endsWith: "@schema-test.com" } } })
      .catch(() => {});
    await prisma.$disconnect();
  }
  process.exit(ok ? 0 : 1);
}

run();
