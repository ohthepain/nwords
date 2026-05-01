/**
 * When `VOCAB_PIPELINE=legacy`, Kaikki → frequency chains continue into Tatoeba and word-forms.
 * Otherwise (default) the frequency step skips Tatoeba; use `enqueueAiVocabPipeline` for curriculum.
 */
export function isLegacyVocabPipeline(): boolean {
	return process.env.VOCAB_PIPELINE?.trim() === "legacy"
}
