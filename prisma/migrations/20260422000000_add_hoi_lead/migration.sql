-- CreateTable
CREATE TABLE IF NOT EXISTS "HoiLead" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceLeadId" TEXT NOT NULL DEFAULT '',
    "sourceUrl" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "budgetMin" DOUBLE PRECISION,
    "budgetMax" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "country" TEXT NOT NULL DEFAULT '',
    "skills" JSONB NOT NULL DEFAULT '[]',
    "postedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientName" TEXT NOT NULL DEFAULT '',
    "clientHistory" TEXT NOT NULL DEFAULT '',
    "competitionCount" INTEGER NOT NULL DEFAULT 0,
    "rawPayload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'New',
    "assignedTo" TEXT NOT NULL DEFAULT '',
    "score" INTEGER NOT NULL DEFAULT 0,
    "scoreBreakdown" JSONB NOT NULL DEFAULT '{}',
    "recommendedService" TEXT NOT NULL DEFAULT '',
    "scoreReason" TEXT NOT NULL DEFAULT '',
    "suggestedReply" TEXT NOT NULL DEFAULT '',
    "rejected" BOOLEAN NOT NULL DEFAULT false,
    "rejectReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HoiLead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "HoiLead_clientId_source_sourceLeadId_key" ON "HoiLead"("clientId", "source", "sourceLeadId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HoiLead_clientId_status_idx" ON "HoiLead"("clientId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HoiLead_clientId_source_idx" ON "HoiLead"("clientId", "source");

-- AddForeignKey
ALTER TABLE "HoiLead" ADD CONSTRAINT "HoiLead_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
