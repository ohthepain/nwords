-- CreateEnum
CREATE TYPE "CurriculumSource" AS ENUM ('KAIKKI', 'AI_CURRICULUM');

-- CreateEnum
CREATE TYPE "SentenceSource" AS ENUM ('TATOEBA', 'AI_GENERATED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IngestionType" ADD VALUE 'COMMON_WORDS_TOP';
ALTER TYPE "IngestionType" ADD VALUE 'VOCAB_UNITS_LLM';

-- AlterTable
ALTER TABLE "sentence" ADD COLUMN     "source" "SentenceSource";

-- AlterTable
ALTER TABLE "word" ADD COLUMN     "curriculumSource" "CurriculumSource" NOT NULL DEFAULT 'KAIKKI',
ADD COLUMN     "curriculumUnit" JSONB;
