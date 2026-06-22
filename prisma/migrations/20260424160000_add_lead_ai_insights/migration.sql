-- AI intelligence report enrichment fields for Lead
ALTER TABLE "Lead" ADD COLUMN "aiInsights"      JSONB;
ALTER TABLE "Lead" ADD COLUMN "aiInsightsAt"    TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "aiInsightsModel" TEXT;
ALTER TABLE "Lead" ADD COLUMN "aiInsightsError" TEXT;
