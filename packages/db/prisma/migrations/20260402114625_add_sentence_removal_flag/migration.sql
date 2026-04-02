-- AlterEnum
ALTER TYPE "ClozeIssueStatus" ADD VALUE 'SENTENCE_REMOVED';

-- AlterTable
ALTER TABLE "sentence" ADD COLUMN     "markedForRemoval" BOOLEAN NOT NULL DEFAULT false;
