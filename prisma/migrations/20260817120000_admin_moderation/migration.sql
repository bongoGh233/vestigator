-- Admin & Moderation: adds admin role, user status, provider verification,
-- review moderation, user reports, and audit log.

-- 1. Extend User.role CHECK to include 'admin'.
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('customer', 'provider', 'both', 'admin'));

-- 2. User.status — 'active' | 'suspended'.
ALTER TABLE "users" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'suspended'));

-- 3. Profile.verified — provider identity verified by admin.
ALTER TABLE "profiles" ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false;

-- 4. Review moderation fields.
ALTER TABLE "reviews" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "reviews" ADD COLUMN "hidden_reason" TEXT;

-- 5. Reports — user-generated reports against users, providers, bookings, reviews.
CREATE TABLE "reports" (
    "id"          SERIAL PRIMARY KEY,
    "reporter_id" INTEGER NOT NULL,
    "target_type" TEXT    NOT NULL,
    "target_id"   TEXT    NOT NULL,
    "reason"      TEXT    NOT NULL,
    "status"      TEXT    NOT NULL DEFAULT 'OPEN',
    "created_at"  BIGINT  NOT NULL,
    "reviewed_at" BIGINT,
    "reviewed_by" INTEGER
);
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_type_check" CHECK ("target_type" IN ('user', 'provider', 'booking', 'review'));
ALTER TABLE "reports" ADD CONSTRAINT "reports_status_check" CHECK ("status" IN ('OPEN', 'REVIEWED', 'RESOLVED', 'DISMISSED'));
ALTER TABLE "reports" ADD FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "reports" ADD FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL;
CREATE INDEX "reports_status_idx" ON "reports"("status");
CREATE INDEX "reports_target_idx" ON "reports"("target_type", "target_id");

-- 6. AuditLog — append-only admin action log.
CREATE TABLE "audit_logs" (
    "id"          SERIAL PRIMARY KEY,
    "admin_id"    INTEGER NOT NULL,
    "action"      TEXT    NOT NULL,
    "target_type" TEXT    NOT NULL,
    "target_id"   TEXT    NOT NULL,
    "meta"        TEXT,
    "created_at"  BIGINT  NOT NULL
);
ALTER TABLE "audit_logs" ADD FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE CASCADE;
CREATE INDEX "audit_logs_admin_idx" ON "audit_logs"("admin_id");
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");
CREATE INDEX "audit_logs_created_idx" ON "audit_logs"("created_at");
