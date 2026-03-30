import { prisma } from "@nwords/db"
import PgBoss from "pg-boss"

let boss: PgBoss | null = null
let workersRegistered = false
let staleSweepTimer: ReturnType<typeof setInterval> | null = null

async function runStaleIngestionSweep(): Promise<void> {
	try {
		const { sweepStaleRunningIngestionJobs } = await import("./stale-ingestion-jobs.js")
		const n = await sweepStaleRunningIngestionJobs(prisma)
		if (n > 0) {
			console.log(`[ingest] marked ${n} stale RUNNING job(s) as FAILED`)
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

	if (process.env.DISABLE_INGEST_WORKERS !== "true" && !workersRegistered) {
		await registerIngestWorkers(instance)
		workersRegistered = true
		scheduleStaleIngestionSweep()
	}

	boss = instance
	return boss
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
	}
}
