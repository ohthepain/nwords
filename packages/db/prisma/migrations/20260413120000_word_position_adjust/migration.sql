-- AlterTable
ALTER TABLE "word" ADD COLUMN "positionAdjust" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "word" ADD COLUMN "effectiveRank" INTEGER NOT NULL DEFAULT 0;

-- Backfill: set effectiveRank = rank for all existing words
UPDATE "word" SET "effectiveRank" = "rank";

-- CreateIndex
CREATE INDEX "word_languageId_effectiveRank_idx" ON "word"("languageId", "effectiveRank");
