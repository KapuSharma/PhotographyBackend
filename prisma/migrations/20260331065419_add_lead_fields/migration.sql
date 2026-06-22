-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "company" TEXT,
ADD COLUMN     "contact" TEXT,
ADD COLUMN     "score" INTEGER DEFAULT 0,
ALTER COLUMN "eventDate" SET DATA TYPE TEXT,
ALTER COLUMN "source" SET DEFAULT 'Website Form';
