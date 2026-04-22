-- AlterEnum
ALTER TYPE "IngestionType" ADD VALUE 'CLOZE_QUALITY_ASSESSMENT';

-- AlterTable
ALTER TABLE "sentence_word" ADD COLUMN     "aiKeep" BOOLEAN,
ADD COLUMN     "aiNaturalness" INTEGER,
ADD COLUMN     "aiUsefulness" INTEGER;

-- AlterTable
ALTER TABLE "word" ADD COLUMN     "aiSynonyms" TEXT[] DEFAULT ARRAY[]::TEXT[];
