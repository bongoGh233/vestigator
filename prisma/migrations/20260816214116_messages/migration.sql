-- DropIndex
DROP INDEX "profiles_city_trgm_idx";

-- DropIndex
DROP INDEX "services_description_trgm_idx";

-- DropIndex
DROP INDEX "services_title_trgm_idx";

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "booking_id" TEXT NOT NULL,
    "sender_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,
    "read_at" BIGINT,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_booking_id_created_at_idx" ON "messages"("booking_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_booking_id_sender_id_idx" ON "messages"("booking_id", "sender_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
