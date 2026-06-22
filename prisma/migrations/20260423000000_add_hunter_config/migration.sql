-- CreateTable
CREATE TABLE "HunterConfig" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "keywords" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HunterConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HunterConfig_clientId_key" ON "HunterConfig"("clientId");

-- AddForeignKey
ALTER TABLE "HunterConfig" ADD CONSTRAINT "HunterConfig_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
