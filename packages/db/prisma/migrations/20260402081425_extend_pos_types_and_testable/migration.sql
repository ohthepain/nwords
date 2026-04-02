-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PartOfSpeech" ADD VALUE 'PRONOUN';
ALTER TYPE "PartOfSpeech" ADD VALUE 'DETERMINER';
ALTER TYPE "PartOfSpeech" ADD VALUE 'PREPOSITION';
ALTER TYPE "PartOfSpeech" ADD VALUE 'CONJUNCTION';
ALTER TYPE "PartOfSpeech" ADD VALUE 'PARTICLE';
ALTER TYPE "PartOfSpeech" ADD VALUE 'INTERJECTION';
ALTER TYPE "PartOfSpeech" ADD VALUE 'NUMERAL';
ALTER TYPE "PartOfSpeech" ADD VALUE 'PROPER_NOUN';

-- AlterTable
ALTER TABLE "word" ADD COLUMN     "alternatePos" "PartOfSpeech"[] DEFAULT ARRAY[]::"PartOfSpeech"[],
ADD COLUMN     "isTestable" BOOLEAN NOT NULL DEFAULT true;
