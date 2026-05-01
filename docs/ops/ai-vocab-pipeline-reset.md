# AI vocabulary pipeline — operational reset

This runbook matches the AI-first path (`COMMON_WORDS_TOP` → `VOCAB_UNITS_LLM`) described in the codebase.

## Environment

- **`VOCAB_PIPELINE`**: unset or any value other than `legacy` — new installs skip Tatoeba when running the legacy **frequency** worker’s chain step; use **Common words** / **LLM vocabulary** on Languages admin or `enqueueAiVocabPipeline` / `enqueueVocabUnitsLlmFromCommonWords`.
- **`VOCAB_PIPELINE=legacy`**: enabling a language with zero words runs **Kaikki → frequency → Tatoeba** as before; frequency completion chains Tatoeba.

- **`VOCAB_UNITS_LLM_MODEL`**: optional OpenAI override for the vocabulary-units worker (see worker code); other providers use the admin-configured model.
- **`VOCAB_UNITS_LLM_BATCH_SIZE`**: optional, default `200` (50–500). The worker asks for candidate chunks, deduplicates accepted `(text + POS)` pairs locally, assigns ranks in accepted order, and upserts each accepted unit immediately.
- **`VOCAB_UNITS_LLM_MIN_ACCEPTED_RATIO`**: optional, default `0.75`. The requested `unitCount` is still the target; after the chunk budget is exhausted, the job can still complete if this ratio of unique units has been accepted and all required seeds are present.
- **`VOCAB_UNITS_LLM_MIN_ACCEPTED_COUNT`**: optional absolute override for the minimum accepted unit count. Capped at `unitCount`.
- **`VOCAB_UNITS_LLM_MAX_CHUNKS`**: optional. Defaults to roughly twice the number of chunks needed for `unitCount`, plus buffer. Raise this if a language has many duplicate candidate responses or required seeds remain missing after the default chunk budget.

## Truncate content for one language (PostgreSQL)

Run in a transaction after backup. Replace `:language_id` with the UUID from `language.id`.

1. **Sentence links and translations for that language’s sentences**

```sql
DELETE FROM sentence_word sw
USING sentence s
WHERE sw.sentence_id = s.id AND s.language_id = :language_id::uuid;

DELETE FROM sentence_translation st
USING sentence s
WHERE (st.original_sentence_id = s.id OR st.translated_sentence_id = s.id)
  AND s.language_id = :language_id::uuid;

DELETE FROM sentence WHERE language_id = :language_id::uuid;
```

2. **Words (all sources)** — cascades `sentence_word`, `word_form`, `user_word_knowledge`, etc.

```sql
DELETE FROM word WHERE language_id = :language_id::uuid;
```

3. **Optional: learner state for that language**

```sql
DELETE FROM user_word_knowledge uwk
USING word w
WHERE uwk.word_id = w.id AND w.language_id = :language_id::uuid;
-- If words were already deleted, skip the above and instead reset profiles:
DELETE FROM user_language_profile WHERE language_id = :language_id::uuid;
```

Adjust depending on whether you already dropped `word` rows (FKs from knowledge to `word.id`).

4. **Frequency list row** (optional, for a clean frequency re-import)

```sql
DELETE FROM frequency_list WHERE language_id = :language_id::uuid;
```

## Two-step AI curriculum (default)

1. **`COMMON_WORDS_TOP`** — writes `topLemmas` to job metadata for review (does not auto-start the LLM by default).
2. **`VOCAB_UNITS_LLM`** — after review, start via **Languages → LLM vocabulary**, or `POST /api/admin/languages/:id/run-llm-vocab-from-common-words` with `{}` or `{ "commonWordsJobId": "<uuid>" }`, or `POST /api/admin/jobs/vocab-units-llm/from-common-words`.

Ensure **AI provider + API key** are set before the LLM step. Optional auto-chain: pass `chainPipeline: true` when enqueueing **Common words** if you want the old one-shot behavior.

## Rebuild curriculum

1. Run **Common words**, inspect the job output, then **LLM vocabulary** (or `POST /api/admin/languages/:id/run-ai-vocab-pipeline` for step 1 only).
2. After you add an AI **sentence/cloze** job, link sentences and run **Assess cloze quality** if needed.

## Rerun semantics

- **`VOCAB_UNITS_LLM`** upserts `Word` rows for AI units and **deletes** other `AI_CURRICULUM` words for that language not present in the latest run. **Kaikki-sourced rows** (`curriculumSource: KAIKKI`) are never deleted by that job.
