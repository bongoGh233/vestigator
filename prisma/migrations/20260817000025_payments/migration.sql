-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "paid_at" BIGINT,
ADD COLUMN     "payment_method" TEXT,
ADD COLUMN     "payment_status" TEXT NOT NULL DEFAULT 'UNPAID',
ADD COLUMN     "platform_fee" INTEGER;
