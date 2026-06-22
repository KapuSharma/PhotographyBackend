-- CreateTable
CREATE TABLE "HuntSource" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "niche" TEXT NOT NULL DEFAULT 'Other',
    "location" TEXT NOT NULL DEFAULT '',
    "feeds" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HuntSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HuntSignal" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "profileName" TEXT NOT NULL DEFAULT '',
    "profileHandle" TEXT NOT NULL DEFAULT '',
    "profileUrl" TEXT NOT NULL DEFAULT '',
    "postUrl" TEXT NOT NULL DEFAULT '',
    "postContent" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT '',
    "region" TEXT NOT NULL DEFAULT '',
    "niche" TEXT NOT NULL DEFAULT 'Other',
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "matchedKeywords" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'New',
    "pubDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HuntSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HuntSource_clientId_idx" ON "HuntSource"("clientId");

-- CreateIndex
CREATE INDEX "HuntSignal_clientId_status_idx" ON "HuntSignal"("clientId", "status");

-- CreateIndex
CREATE INDEX "HuntSignal_clientId_platform_idx" ON "HuntSignal"("clientId", "platform");

-- AddForeignKey
ALTER TABLE "HuntSource" ADD CONSTRAINT "HuntSource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HuntSignal" ADD CONSTRAINT "HuntSignal_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HuntSignal" ADD CONSTRAINT "HuntSignal_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "HuntSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
