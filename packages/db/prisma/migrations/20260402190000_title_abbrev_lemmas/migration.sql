-- Title / honorific abbreviations stored as short lemmas (e.g. "dr") without Wiktionary abbreviation sense tags.
UPDATE "word"
SET
  "isAbbreviation" = true,
  "isTestable" = false,
  "rank" = 0,
  "testSentenceIds" = ARRAY[]::TEXT[],
  "cefrLevel" = NULL
WHERE lemma IN ('dr', 'mr', 'mrs', 'ms', 'mx', 'jr', 'sr');
