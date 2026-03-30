import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { LAST_WORKER_ACTIVITY_AT_KEY } from "./job-logs"
import { runIngestJobMetaSerial } from "./ingest-job-meta-serial"

/**
 * Merge ingestion speed samples into job metadata for the admin "speedometer".
 */
export async function updateIngestionProgress(
	jobId: string,
	partial: {
		processedItems?: number
		totalItems?: number
		errorCount?: number
		extraMetadata?: Record<string, unknown>
	},
): Promise<void> {
	await runIngestJobMetaSerial(jobId, async () => {
		const job = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true, processedItems: true },
		})
		if (!job) return

		const prev = (job.metadata ?? {}) as Record<string, unknown>
		const now = Date.now()
		const processed = partial.processedItems ?? job.processedItems
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

		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				...(partial.processedItems !== undefined ? { processedItems: partial.processedItems } : {}),
				...(partial.totalItems !== undefined ? { totalItems: partial.totalItems } : {}),
				...(partial.errorCount !== undefined ? { errorCount: partial.errorCount } : {}),
				metadata: nextMeta as Prisma.InputJsonValue,
			},
		})
	})
}
