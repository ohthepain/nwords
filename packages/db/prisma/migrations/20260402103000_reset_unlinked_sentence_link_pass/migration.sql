-- Re-queue first-pass sentence linking for rows that have no SentenceWord links but were
-- already scored (e.g. homograph tokens were skipped, so score was stored and linking never retried).
UPDATE "sentence"
SET "testQualityScore" = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM "sentence_word" sw WHERE sw."sentenceId" = "sentence"."id"
)
AND "testQualityScore" IS NOT NULL;
