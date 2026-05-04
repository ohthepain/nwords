/**
 * Curriculum words backed by learner-facing payloads:
 * - `AI_CURRICULUM` (`VOCAB_UNITS_LLM`): see field notes below.
 * - Common curriculum Kaikki job (`COMMON_CURRICULUM_KAIKKI`):
 *   bases use `seedOrder` in `curriculumUnit` / tags; **`Word.curriculumSource`** is **`COMMON`** for
 *   frequency-common-words list seeds, **`HERMIT_DAVE`** for Hermit-append seeds, **`KAIKKI`** for
 *   promoted/form-expanded rows derived from Kaikki.
 * - All managed rows include **`common-frequency`** in `curriculumUnit.tags` (see `COMMON_CURRICULUM_FREQUENCY_TAG`).
 *
 * `definitions` stays a string[] gloss list (Kaikki compatible).
 *
 * Extended structured fields live in `curriculumUnit`:
 * - `unitType`: WORD | PARTICLE | FIXED_EXPR | SPLIT
 * - `form`: optional object from the LLM (tense, number, …)
 * - `baseLemma` / `formKey` / `formTags` / `formSource`: present when a Kaikki inflection is
 *   promoted into its own learning unit.
 * - `tags`: string[]
 * - `lang`: BCP-ish language code from the model
 *
 * **Rerun policy (`VOCAB_UNITS_LLM`):** upsert by `(languageId, lemma, pos)`, then delete every
 * `Word` with `curriculumSource: AI_CURRICULUM` for that language whose id is **not** in the
 * upserted set. Kaikki bulk rows are never removed by this job.
 *
 * **Rerun policy (`COMMON_CURRICULUM_KAIKKI`):** prune any word for that language whose
 * **`curriculumUnit.tags` contains `"common-frequency"`** but whose id was **not** kept in this run’s
 * output set (bases, promoted forms, Kaikki-missing stubs). Does not touch bulk-import `KAIKKI` rows
 * without that tag.
 */

export type AiCurriculumUnitJson = {
	unitType: string
	form?: Record<string, unknown>
	baseLemma?: string
	formKey?: string
	formTags?: string[]
	formSource?: string
	tags: string[]
	lang?: string
	/** Zero-based seed order for common-curriculum rows (`COMMON_CURRICULUM_KAIKKI` job output). */
	seedOrder?: number
}
