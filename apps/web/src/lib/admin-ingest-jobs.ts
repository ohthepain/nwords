/** Shared labels and styles for admin ingestion job UIs (languages + jobs pages). */

/** Matches `JOB_LOG_LINES_KEY` in API `job-logs.ts` — persisted on `IngestionJob.metadata`. */
export const JOB_LOG_METADATA_KEY = "jobLogLines" as const

export type PersistedJobLogLine = {
	t: string
	s: "out" | "err"
	m: string
}

export function parseJobLogLines(metadata: unknown): PersistedJobLogLine[] {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return []
	const raw = (metadata as Record<string, unknown>)[JOB_LOG_METADATA_KEY]
	if (!Array.isArray(raw)) return []
	const out: PersistedJobLogLine[] = []
	for (const x of raw) {
		if (x === null || typeof x !== "object") continue
		const o = x as Record<string, unknown>
		const t = o.t
		const s = o.s
		const m = o.m
		if (typeof t !== "string" || (s !== "out" && s !== "err") || typeof m !== "string") continue
		out.push({ t, s, m })
	}
	return out
}

/** Drop verbose log arrays from list payloads (speed samples etc. stay). */
export function stripJobLogsFromMetadata(metadata: unknown): Record<string, unknown> | null {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null
	const m = { ...(metadata as Record<string, unknown>) }
	delete m[JOB_LOG_METADATA_KEY]
	return m
}

export const JOB_TYPE_LABELS: Record<string, string> = {
	KAIKKI_WORDS: "Kaikki Dictionary",
	FREQUENCY_LIST: "Frequency List",
	TATOEBA_SENTENCES: "Tatoeba Sentences",
	WORD_FORMS: "Word Forms",
	AUDIO_FILES: "Audio Files",
}

export const STATUS_STYLES: Record<string, string> = {
	PENDING: "bg-muted text-muted-foreground",
	RUNNING: "bg-brand/15 text-brand",
	COMPLETED: "bg-known/15 text-known",
	FAILED: "bg-destructive/15 text-destructive",
	CANCELLED: "bg-muted text-muted-foreground",
}

/** When a worker fails, `metadata.error` holds the message (no streamed logs yet). */
export function jobMetadataError(metadata: unknown): string | null {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null
	const err = (metadata as Record<string, unknown>).error
	return typeof err === "string" && err.trim().length > 0 ? err.trim() : null
}

/** Compact relative time for job rows. */
export function formatJobRelativeTime(iso: string): string {
	const d = new Date(iso)
	const now = new Date()
	const diffMs = now.getTime() - d.getTime()
	const diffMin = Math.floor(diffMs / 60000)

	if (diffMin < 1) return "just now"
	if (diffMin < 60) return `${diffMin}m ago`
	if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`
	return d.toLocaleDateString()
}
