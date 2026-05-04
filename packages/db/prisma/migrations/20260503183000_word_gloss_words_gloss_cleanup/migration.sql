-- AlterTable
ALTER TABLE "word" ADD COLUMN "gloss" TEXT;

-- AlterEnum
ALTER TYPE "IngestionType" ADD VALUE 'WORDS_GLOSS_CLEANUP';
