/** pg-boss queue names for ingestion workers */
export const INGEST_QUEUE = {
	KAIKKI: "ingest:kaikki",
	FREQUENCY: "ingest:frequency",
	TATOEBA: "ingest:tatoeba",
	WORD_FORMS: "ingest:word-forms",
	FIXED_EXPRESSIONS: "ingest:fixed-expressions",
	CLOZE_QUALITY: "ingest:cloze-quality",
	CLOZE_GENERATION: "ingest:cloze-generation",
	COMMON_WORDS_TOP: "ingest:common-words-top",
	HERMIT_DAVE_COMMON_LEMMAS: "ingest:hermit-dave-common-lemmas",
	COMMON_CURRICULUM_KAIKKI: "ingest:common-curriculum-kaikki",
	VOCAB_UNITS_LLM: "ingest:vocab-units-llm",
	VOCAB_CLEANUP: "ingest:vocab-cleanup",
	WORDS_GLOSS_CLEANUP: "ingest:words-gloss-cleanup",
	CURRICULUM_TESTABILITY_TRIM: "ingest:curriculum-testability-trim",
	CURRICULUM_TESTABILITY_TRIM_RETRY: "ingest:curriculum-testability-trim-retry",
} as const
