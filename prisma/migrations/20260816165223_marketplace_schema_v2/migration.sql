-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "accepted_at" BIGINT,
ADD COLUMN     "completed_at" BIGINT,
ADD COLUMN     "expires_at" BIGINT,
ADD COLUMN     "price_amount" INTEGER,
ADD COLUMN     "price_currency" TEXT NOT NULL DEFAULT 'GHS',
ADD COLUMN     "profile_id" INTEGER,
ADD COLUMN     "reviewed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "service_id" INTEGER,
ADD COLUMN     "started_at" BIGINT,
ALTER COLUMN "status" SET DEFAULT 'REQUESTED';

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "rating_avg" DOUBLE PRECISION,
ADD COLUMN     "rating_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "service_area" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'customer';

-- CreateTable
CREATE TABLE "services" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'other',
    "price_amount" INTEGER NOT NULL,
    "price_currency" TEXT NOT NULL DEFAULT 'GHS',
    "price_unit" TEXT NOT NULL DEFAULT 'flat',
    "duration_min" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" SERIAL NOT NULL,
    "booking_id" TEXT NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "dow" INTEGER NOT NULL,
    "start_min" INTEGER NOT NULL,
    "end_min" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "availability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "services_profile_id_idx" ON "services"("profile_id");

-- CreateIndex
CREATE INDEX "services_category_idx" ON "services"("category");

-- CreateIndex
CREATE INDEX "services_active_idx" ON "services"("active");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_booking_id_key" ON "reviews"("booking_id");

-- CreateIndex
CREATE INDEX "reviews_profile_id_idx" ON "reviews"("profile_id");

-- CreateIndex
CREATE INDEX "reviews_user_id_idx" ON "reviews"("user_id");

-- CreateIndex
CREATE INDEX "availability_profile_id_idx" ON "availability"("profile_id");

-- CreateIndex
CREATE INDEX "bookings_profile_id_idx" ON "bookings"("profile_id");

-- CreateIndex
CREATE INDEX "bookings_service_id_idx" ON "bookings"("service_id");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability" ADD CONSTRAINT "availability_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Marketplace foundation: CHECK constraints, partial unique indexes, backfill.
-- (Raw SQL — these constructs are not expressible in the Prisma schema.)
-- ---------------------------------------------------------------------------

-- Marketplace role is application-managed ("customer" | "provider" | "both").
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('customer', 'provider', 'both'));

-- Existing users who already have a trackable profile keep both capabilities.
UPDATE "users" SET "role" = 'both' WHERE EXISTS (SELECT 1 FROM "profiles" WHERE "profiles"."user_id" = "users"."id");

-- Profile rating aggregates.
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_rating_avg_check" CHECK ("rating_avg" IS NULL OR ("rating_avg" >= 0 AND "rating_avg" <= 5));
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_rating_count_check" CHECK ("rating_count" >= 0);

-- Booking status: legacy tracking values AND the marketplace lifecycle.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_status_check" CHECK ("status" IN (
  'pending', 'online', 'in_transit', 'arrived', 'cancelled',
  'REQUESTED', 'ACCEPTED', 'REJECTED', 'PROVIDER_EN_ROUTE', 'ARRIVED',
  'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED'
));
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_price_amount_check" CHECK ("price_amount" IS NULL OR "price_amount" >= 0);

-- Service pricing/duration sanity.
ALTER TABLE "services" ADD CONSTRAINT "services_price_amount_check" CHECK ("price_amount" >= 0);
ALTER TABLE "services" ADD CONSTRAINT "services_price_unit_check" CHECK ("price_unit" IN ('flat', 'per_hour', 'per_km'));
ALTER TABLE "services" ADD CONSTRAINT "services_duration_min_check" CHECK ("duration_min" IS NULL OR "duration_min" > 0);

-- Reviews carry a 1..5 rating.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_check" CHECK ("rating" >= 1 AND "rating" <= 5);

-- Recurring weekly availability windows (dow: 0=Sunday..6=Saturday; minutes since midnight).
ALTER TABLE "availability" ADD CONSTRAINT "availability_dow_check" CHECK ("dow" BETWEEN 0 AND 6);
ALTER TABLE "availability" ADD CONSTRAINT "availability_start_min_check" CHECK ("start_min" >= 0 AND "start_min" < 1440);
ALTER TABLE "availability" ADD CONSTRAINT "availability_end_min_check" CHECK ("end_min" > "start_min" AND "end_min" <= 1440);

-- One ACTIVE booking per provider. The partial index only covers rows that
-- have a provider profile and an active status, so historical (completed /
-- cancelled / rejected / expired) bookings and legacy profile-less bookings
-- are unaffected.
CREATE UNIQUE INDEX "bookings_active_provider_unique" ON "bookings"("profile_id")
  WHERE "profile_id" IS NOT NULL
    AND "status" IN ('REQUESTED', 'ACCEPTED', 'PROVIDER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS');

-- One outstanding REQUEST from a customer to a provider. Once the provider
-- acts (accept/reject) the row leaves 'REQUESTED' and a fresh request is
-- allowed again.
CREATE UNIQUE INDEX "bookings_active_customer_provider_unique" ON "bookings"("user_id", "profile_id")
  WHERE "profile_id" IS NOT NULL AND "status" IN ('REQUESTED');
