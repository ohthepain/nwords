import { type Prisma, prisma } from "@nwords/db"
import PgBoss from "pg-boss"

let boss: PgBoss | null = null
let workersRegistered = false
let staleSweepTimer: ReturnType<typeof setInterval> | null = null
let staleSweepStarted = false

async function runStaleIngestionSweep(): Promise<void> {
	try {
		const { sweepStalePendingIngestionJobs, sweepStaleRunningIngestionJobs } = await import(
			"./stale-ingestion-jobs.js"
		)
		const [nRun, nPen] = await Promise.all([
			sweepStaleRunningIngestionJobs(prisma),
			sweepStalePendingIngestionJobs(prisma),
		])
		if (nRun > 0) {
			console.log(`[ingest] marked ${nRun} stale RUNNING job(s) as FAILED`)
		}
		if (nPen > 0) {
			console.log(`[ingest] marked ${nPen} stale PENDING job(s) as FAILED (no worker pickup)`)
		}
	} catch (err) {
		console.error("[ingest] stale sweep failed:", err)
	}
}

function scheduleStaleIngestionSweep(): void {
	if (staleSweepTimer) {
		clearInterval(staleSweepTimer)
		staleSweepTimer = null
	}
	// One shot when workers start (no-op if STALE_INGESTION_JOB_MINUTES is 0 or unset invalid).
	void runStaleIngestionSweep()

	const raw = process.env.STALE_INGESTION_SWEEP_INTERVAL_MS?.trim()
	const ms = raw ? Number.parseInt(raw, 10) : 600_000
	if (!Number.isFinite(ms) || ms <= 0) {
		return
	}
	staleSweepTimer = setInterval(() => {
		void runStaleIngestionSweep()
	}, ms)
}

export async function getBoss(): Promise<PgBoss> {
	if (boss) return boss

	const connectionString = process.env.DATABASE_URL
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set")
	}

	const instance = new PgBoss({
		connectionString,
		retryLimit: 2,
		retryDelay: 30,
		// pg-boss enforces expireInHours < 24 (strict), not <= 24
		expireInHours: 23,
		archiveCompletedAfterSeconds: 60 * 60 * 24 * 7, // 7 days
	})

	instance.on("error", (err) => console.error("[pg-boss] error:", err))

	await instance.start()
	console.log("[pg-boss] started")

	const { ensureIngestQueues, registerIngestWorkers } = await import("../workers/index.js")
	await ensureIngestQueues(instance)

	if (process.env.DISABLE_INGEST_WORKERS === "true") {
		console.warn(
			"[pg-boss] DISABLE_INGEST_WORKERS=true — queue consumers are off. Ingestion jobs stay PENDING until a process runs workers (e.g. apps/api with this unset).",
		)
	} else if (!workersRegistered) {
		await registerIngestWorkers(instance)
		workersRegistered = true
	}
	if (!staleSweepStarted) {
		staleSweepStarted = true
		scheduleStaleIngestionSweep()
	}

	boss = instance
	return boss
}

/**
 * Enqueue a pg-boss job tied to `IngestionJob` `payload.jobId`.
 * On failure, marks that ingestion row FAILED so it does not sit PENDING forever with no logs.
 */
export async function sendIngestJob(
	queue: string,
	payload: Record<string, unknown> & { jobId: string },
): Promise<void> {
	const jobId = payload.jobId
	try {
		const instance = await getBoss()
		await instance.send(queue, payload)
	} catch (err) {
		const row = await prisma.ingestionJob.findUnique({ where: { id: jobId } })
		const meta = row?.metadata
		const base =
			meta !== null && typeof meta === "object" && !Array.isArray(meta)
				? { ...(meta as Record<string, unknown>) }
				: {}
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: {
					...base,
					error: err instanceof Error ? err.message : String(err),
					stage: "pg-boss-send",
				} as Prisma.InputJsonValue,
			},
		})
		throw err
	}
}

export async function stopBoss(): Promise<void> {
	if (staleSweepTimer) {
		clearInterval(staleSweepTimer)
		staleSweepTimer = null
	}
	if (boss) {
		await boss.stop()
		boss = null
		workersRegistered = false
		staleSweepStarted = false
	}
}
