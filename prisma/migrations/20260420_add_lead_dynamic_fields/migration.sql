-- AlterTable: add dynamic fields to Lead
ALTER TABLE "Lead"
  ADD COLUMN "ownerId"         TEXT,
  ADD COLUMN "estimatedValue"  DOUBLE PRECISION,
  ADD COLUMN "currency"        TEXT DEFAULT 'INR',
  ADD COLUMN "temperature"     TEXT,
  ADD COLUMN "priority"        TEXT,
  ADD COLUMN "tags"             JSONB DEFAULT '[]',
  ADD COLUMN "lastActivityAt"  TIMESTAMP(3),
  ADD COLUMN "nextFollowUpAt"  TIMESTAMP(3),
  ADD COLUMN "wonAt"           TIMESTAMP(3),
  ADD COLUMN "lostAt"          TIMESTAMP(3),
  ADD COLUMN "lostReason"      TEXT;

-- Backfill lastActivityAt with updatedAt so "last activity" has a sensible default
UPDATE "Lead" SET "lastActivityAt" = "updatedAt" WHERE "lastActivityAt" IS NULL;

-- Backfill wonAt for existing Booked leads
UPDATE "Lead" SET "wonAt" = "updatedAt" WHERE "status" = 'Booked' AND "wonAt" IS NULL;

-- Backfill lostAt for existing Lost leads
UPDATE "Lead" SET "lostAt" = "updatedAt" WHERE "status" = 'Lost' AND "lostAt" IS NULL;

-- Foreign key: owner → User
ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "Lead_clientId_status_idx"  ON "Lead"("clientId", "status");
CREATE INDEX "Lead_clientId_ownerId_idx" ON "Lead"("clientId", "ownerId");
CREATE INDEX "Lead_clientId_wonAt_idx"   ON "Lead"("clientId", "wonAt");
