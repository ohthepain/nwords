-- AlterTable
ALTER TABLE "word" ADD COLUMN "isAbbreviation" BOOLEAN NOT NULL DEFAULT false;

-- Letter-dot abbreviations (e.g. i.e., u.s.): not part of core vocabulary training
UPDATE "word"
SET
  "isAbbreviation" = true,
  "rank" =               0,
  "testSentenceIds" =    ARRAY[]::TEXT[],
  "cefrLevel" =          NULL
WHERE lemma ~ '^([a-z]\.)+[a-z]?\.?$';
