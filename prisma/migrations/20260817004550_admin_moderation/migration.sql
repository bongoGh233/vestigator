-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_admin_id_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_reporter_id_fkey";

-- DropForeignKey
ALTER TABLE "reports" DROP CONSTRAINT "reports_reviewed_by_fkey";

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "audit_logs_admin_idx" RENAME TO "audit_logs_admin_id_idx";

-- RenameIndex
ALTER INDEX "audit_logs_created_idx" RENAME TO "audit_logs_created_at_idx";

-- RenameIndex
ALTER INDEX "reports_target_idx" RENAME TO "reports_target_type_target_id_idx";
