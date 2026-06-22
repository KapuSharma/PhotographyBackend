-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "scheduledById" TEXT,
    "title" TEXT NOT NULL DEFAULT 'Consultation Call',
    "meetingLink" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "durationMins" INTEGER NOT NULL DEFAULT 30,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "emailSentAt" TIMESTAMP(3),
    "emailError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Meeting_clientId_leadId_idx" ON "Meeting"("clientId", "leadId");

-- CreateIndex
CREATE INDEX "Meeting_leadId_startTime_idx" ON "Meeting"("leadId", "startTime");

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_scheduledById_fkey" FOREIGN KEY ("scheduledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
