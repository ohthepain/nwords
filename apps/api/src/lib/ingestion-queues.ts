/** pg-boss queue names for ingestion workers */
export const INGEST_QUEUE = {
	KAIKKI: "ingest:kaikki",
	FREQUENCY: "ingest:frequency",
	TATOEBA: "ingest:tatoeba",
	WORD_FORMS: "ingest:word-forms",
} as const
