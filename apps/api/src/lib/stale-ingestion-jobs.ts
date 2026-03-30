import type { PrismaClient } from "@nwords/db"
import { LAST_WORKER_ACTIVITY_AT_KEY } from "./job-logs"

function asMetaRecord(metadata: unknown): Record<string, unknown> {
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>) }
	}
	return {}
}

/**
 * Mark long-running `RUNNING` ingestion jobs as `FAILED` so spot/preempted workers
 * do not leave the admin UI stuck. pg-boss may still retry its own job row separately.
 *
 * Jobs that write `metadata.lastWorkerActivityAt` (progress / logs) are skipped if that
 * timestamp is within the same window, so multi-hour Tatoeba linking is not killed.
 */
export async function sweepStaleRunningIngestionJobs(prisma: PrismaClient): Promise<number> {
	const raw = process.env.STALE_INGESTION_JOB_MINUTES?.trim()
	const minutes = raw ? Number.parseInt(raw, 10) : 120
	if (!Number.isFinite(minutes) || minutes <= 0) {
		return 0
	}

	const cutoff = new Date(Date.now() - minutes * 60_000)
	const stale = await prisma.ingestionJob.findMany({
		where: {
			status: "RUNNING",
			startedAt: { lt: cutoff },
		},
		select: { id: true, metadata: true },
	})

	for (const row of stale) {
		const prev = asMetaRecord(row.metadata)
		const lastAct = prev[LAST_WORKER_ACTIVITY_AT_KEY]
		if (typeof lastAct === "string") {
			const lastMs = Date.parse(lastAct)
			if (Number.isFinite(lastMs) && lastMs >= Date.now() - minutes * 60_000) {
				continue
			}
		}
		await prisma.ingestionJob.update({
			where: { id: row.id },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: {
					...prev,
					error: `Stale RUNNING: no completion within ${minutes} minutes (worker likely lost)`,
					staleSweep: true,
					staleSweepAt: new Date().toISOString(),
				},
			},
		})
	}

	return stale.length
}
