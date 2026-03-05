-- Migration: Partial indexes
--
-- Prisma does not support partial indexes in schema.prisma.
-- This migration must be run AFTER the initial schema migration
-- (npx prisma migrate dev --name initial_schema) to replace the
-- Prisma-generated regular indexes with the partial indexes
-- specified in UPDATED-SPEC.md.
--
-- Apply manually:
--   psql $DATABASE_URL -f prisma/migrations/0001_partial_indexes/migration.sql

-- transfers: only index rows where status = 'pending'
-- Query pattern: stuck-detector scans for pending transfers older than threshold
DROP INDEX IF EXISTS "idx_transfers_status";
CREATE INDEX "idx_transfers_status" ON "transfers" ("status") WHERE status = 'pending';

-- anomalies: only index rows where resolved_at IS NULL (active anomalies)
-- Query pattern: alert list fetches only unresolved anomalies
DROP INDEX IF EXISTS "idx_anomalies_active";
CREATE INDEX "idx_anomalies_active" ON "anomalies" ("corridor_id") WHERE "resolved_at" IS NULL;
