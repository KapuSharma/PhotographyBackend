-- AlterTable
ALTER TABLE "AIConfig" ADD COLUMN     "aiAssistantName" TEXT NOT NULL DEFAULT 'AI Assistant',
ADD COLUMN     "humanDelay" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smsNotifications" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "tone" SET DEFAULT 'professional';
