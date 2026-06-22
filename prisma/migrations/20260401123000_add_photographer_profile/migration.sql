-- AlterTable
ALTER TABLE "AIConfig" ADD COLUMN     "primaryNiche" TEXT NOT NULL DEFAULT 'commercial';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "activity" JSONB DEFAULT '[]';

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "duration" TEXT,
ADD COLUMN     "price" TEXT;

-- CreateTable
CREATE TABLE "SiteContent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "hero" JSONB,
    "brand" JSONB,
    "trust" JSONB,

    CONSTRAINT "SiteContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhotographerProfile" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fullName" TEXT,
    "studioName" TEXT,
    "location" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "yearsExperience" TEXT,
    "bio" TEXT,
    "niches" JSONB DEFAULT '[]',
    "shootingStyle" TEXT,
    "editingStyle" TEXT,
    "minBudget" TEXT,
    "depositPercent" TEXT DEFAULT '50',
    "paymentTerms" TEXT,
    "avgProjectValue" TEXT,
    "bookingLeadTime" TEXT,
    "turnaround" TEXT,
    "travelsInterstate" TEXT DEFAULT 'No',
    "travelsInternational" TEXT DEFAULT 'No',
    "idealClientDesc" TEXT,
    "pastClients" TEXT,
    "responseStyle" TEXT DEFAULT 'Professional',
    "dealBreakers" TEXT,
    "qualifyingQuestions" TEXT,
    "closingLine" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhotographerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "leadId" TEXT,
    "company" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "paymentDate" TEXT,
    "method" TEXT NOT NULL DEFAULT 'Awaiting',
    "paymentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteContent_clientId_key" ON "SiteContent"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "PhotographerProfile_clientId_key" ON "PhotographerProfile"("clientId");

-- AddForeignKey
ALTER TABLE "SiteContent" ADD CONSTRAINT "SiteContent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotographerProfile" ADD CONSTRAINT "PhotographerProfile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
