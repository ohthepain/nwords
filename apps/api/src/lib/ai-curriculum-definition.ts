/**
 * AI curriculum words (`curriculumSource: AI_CURRICULUM`) store meaning in `definitions` as a
 * string[] compatible with Kaikki rows: `[gloss]` so hints and admin UIs keep working.
 *
 * Extended structured fields live in `curriculumUnit`:
 * - `unitType`: WORD | PARTICLE | FIXED_EXPR | SPLIT
 * - `form`: optional object from the LLM (tense, number, …)
 * - `tags`: string[]
 * - `lang`: BCP-ish language code from the model
 *
 * **Rerun policy (`VOCAB_UNITS_LLM`):** upsert by `(languageId, lemma, pos)`, then delete every
 * `Word` with `curriculumSource: AI_CURRICULUM` for that language whose id is **not** in the
 * upserted set. Kaikki rows are never removed by this job.
 */

export type AiCurriculumUnitJson = {
	unitType: string
	form?: Record<string, unknown>
	tags: string[]
	lang?: string
}
