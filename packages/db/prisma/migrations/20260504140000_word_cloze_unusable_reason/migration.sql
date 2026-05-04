-- CreateEnum
CREATE TYPE "ClozeUnusableReason" AS ENUM (
  'ARCHAIC',
  'SELDOM_USED',
  'INAPPROPRIATE_LANGUAGE',
  'BAD_INPUT',
  'NOT_FEASIBLE_SURFACE_FORM',
  'PROPER_NOUN',
  'INCORRECT_LANGUAGE',
  'OTHER'
);

-- AlterTable
ALTER TABLE "word" ADD COLUMN "clozeUnusableReason" "ClozeUnusableReason",
ADD COLUMN "clozeUnusableDetail" TEXT;
