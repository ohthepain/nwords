import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { runIngestJobMetaSerial } from "./ingest-job-meta-serial"

/** Stored under `IngestionJob.metadata.jobLogLines` (compact keys to limit JSON size). */
export const JOB_LOG_LINES_KEY = "jobLogLines" as const

/** ISO timestamp; refreshed by workers so long jobs are not marked stale while still progressing. */
export const LAST_WORKER_ACTIVITY_AT_KEY = "lastWorkerActivityAt" as const

export type JobLogStream = "out" | "err"

export type JobLogLine = {
	t: string
	s: JobLogStream
	m: string
}

export const JOB_LOG_MAX_LINES = 400
export const JOB_LOG_LINE_MAX_CHARS = 2000

function normalizeLines(raw: unknown): JobLogLine[] {
	if (!Array.isArray(raw)) return []
	const out: JobLogLine[] = []
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

function truncateLines(lines: JobLogLine[]): JobLogLine[] {
	if (lines.length <= JOB_LOG_MAX_LINES) return lines
	return lines.slice(-JOB_LOG_MAX_LINES)
}

/**
 * Append one log line to the job's metadata (read-merge-write).
 * Workers should await this; ingestion is mostly single-threaded per job id.
 */
export async function appendJobLog(
	jobId: string,
	stream: JobLogStream,
	message: string,
): Promise<void> {
	const text = message.replace(/\s+/g, " ").trim().slice(0, JOB_LOG_LINE_MAX_CHARS)
	if (!text) return

	await runIngestJobMetaSerial(jobId, async () => {
		const job = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true },
		})
		if (!job) return

		const prev = (job.metadata ?? {}) as Record<string, unknown>
		const existing = normalizeLines(prev[JOB_LOG_LINES_KEY])
		const line: JobLogLine = { t: new Date().toISOString(), s: stream, m: text }
		const nextLines = truncateLines([...existing, line])

		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				metadata: {
					...prev,
					[JOB_LOG_LINES_KEY]: nextLines,
					[LAST_WORKER_ACTIVITY_AT_KEY]: new Date().toISOString(),
				} as Prisma.InputJsonValue,
			},
		})
	})
}

export async function snapshotJobMetadata(jobId: string): Promise<Record<string, unknown>> {
	const row = await prisma.ingestionJob.findUnique({
		where: { id: jobId },
		select: { metadata: true },
	})
	return (row?.metadata ?? {}) as Record<string, unknown>
}

/** Keys to drop when cloning metadata for a retry job (fresh logs / speed samples). */
export function jobMetadataForRetry(meta: Record<string, unknown>): Record<string, unknown> {
	const {
		[JOB_LOG_LINES_KEY]: _logs,
		[LAST_WORKER_ACTIVITY_AT_KEY]: _act,
		speedSample: _speedSample,
		ingestSpeed: _ingestSpeed,
		...rest
	} = meta
	return rest
}
