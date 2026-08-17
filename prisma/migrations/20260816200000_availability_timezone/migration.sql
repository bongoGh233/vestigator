-- Phase 3, Step 8: per-profile IANA timezone for weekly availability windows.
--
-- availability.dow/start_min/end_min are wall-clock values in the provider's
-- local timezone. A NULL timezone means "not configured" (interpreted as UTC)
-- and preserves every existing provider: no availability data is required and
-- no legacy behaviour changes. IANA ids are validated at the app layer before
-- they reach the database.

ALTER TABLE "profiles" ADD COLUMN "timezone" TEXT;
