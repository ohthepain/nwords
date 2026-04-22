/** pg-boss queue names for ingestion workers */
export const INGEST_QUEUE = {
	KAIKKI: "ingest:kaikki",
	FREQUENCY: "ingest:frequency",
	TATOEBA: "ingest:tatoeba",
	WORD_FORMS: "ingest:word-forms",
	FIXED_EXPRESSIONS: "ingest:fixed-expressions",
	CLOZE_QUALITY: "ingest:cloze-quality",
} as const
