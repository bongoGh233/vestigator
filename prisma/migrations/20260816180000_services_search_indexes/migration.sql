-- Phase 3, Step 3: search foundation for the public service listing.
--
-- The public search (`GET /api/services`) filters active services of listed
-- providers by exact category, ILIKE text on title/description, and area
-- (provider city / service_area JSON city). The category/active/profile_id
-- filters already have btree indexes from the marketplace v2 migration; these
-- trigram GIN indexes accelerate the leading-wildcard ILIKE scans.
--
-- pg_trgm is an installable extension on Supabase/PostgreSQL and the indexes
-- are intentionally declarative-ONLY (not represented in schema.prisma), just
-- like the CHECK constraints and partial unique indexes added in v2.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "services_title_trgm_idx" ON "services" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "services_description_trgm_idx" ON "services" USING gin ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "profiles_city_trgm_idx" ON "profiles" USING gin ("city" gin_trgm_ops);
