import PgBoss from "pg-boss"

let boss: PgBoss | null = null
let workersRegistered = false

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
	}

	boss = instance
	return boss
}

export async function stopBoss(): Promise<void> {
	if (boss) {
		await boss.stop()
		boss = null
		workersRegistered = false
	}
}
