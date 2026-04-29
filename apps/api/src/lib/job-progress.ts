import type { Prisma } from "@nwords/db"
import { runIngestJobMetaSerial } from "./ingest-job-meta-serial"
import { LAST_WORKER_ACTIVITY_AT_KEY } from "./job-logs"

/**
 * Merge ingestion speed samples into job metadata for the admin "speedometer".
 */
export async function updateIngestionProgress(
	jobId: string,
	partial: {
		processedItems?: number
		/** Add to current `processedItems` (safe for concurrent workers on the same job). */
		processedDelta?: number
		totalItems?: number
		errorCount?: number
		/** Add to current `errorCount` (safe for concurrent workers on the same job). */
		errorDelta?: number
		extraMetadata?: Record<string, unknown>
	},
): Promise<void> {
	await runIngestJobMetaSerial(jobId, async (tx) => {
		const job = await tx.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true, processedItems: true, errorCount: true },
		})
		if (!job) return

		const prev = (job.metadata ?? {}) as Record<string, unknown>
		const now = Date.now()
		let processed = job.processedItems
		if (partial.processedDelta !== undefined) {
			processed = job.processedItems + partial.processedDelta
		} else if (partial.processedItems !== undefined) {
			processed = partial.processedItems
		}

		let errors = job.errorCount
		if (partial.errorDelta !== undefined) {
			errors = job.errorCount + partial.errorDelta
		} else if (partial.errorCount !== undefined) {
			errors = partial.errorCount
		}

		const prevSample = prev.speedSample as { t: number; n: number } | undefined
		let itemsPerSecond: number | undefined
		if (prevSample && now > prevSample.t && processed >= prevSample.n) {
			const dt = (now - prevSample.t) / 1000
			if (dt > 0.5) {
				itemsPerSecond = (processed - prevSample.n) / dt
			}
		}

		const speedSample = { t: now, n: processed }
		const nextMeta: Record<string, unknown> = {
			...prev,
			...(partial.extraMetadata ?? {}),
			speedSample,
			...(itemsPerSecond !== undefined ? { ingestSpeed: { itemsPerSecond } } : {}),
			[LAST_WORKER_ACTIVITY_AT_KEY]: new Date().toISOString(),
		}

		await tx.ingestionJob.update({
			where: { id: jobId },
			data: {
				...(partial.processedItems !== undefined || partial.processedDelta !== undefined
					? { processedItems: processed }
					: {}),
				...(partial.totalItems !== undefined ? { totalItems: partial.totalItems } : {}),
				...(partial.errorCount !== undefined || partial.errorDelta !== undefined
					? { errorCount: errors }
					: {}),
				metadata: nextMeta as Prisma.InputJsonValue,
			},
		})
	})
}
