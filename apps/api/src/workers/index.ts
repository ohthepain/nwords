import type PgBoss from "pg-boss"
import { INGEST_QUEUE } from "../lib/ingestion-queues"
import type { FrequencyJobData } from "./frequency"
import { processFrequencyJob } from "./frequency"
import type { KaikkiJobData } from "./kaikki"
import { processKaikkiJob } from "./kaikki"
import type { TatoebaJobData } from "./tatoeba"
import { processTatoebaJob } from "./tatoeba"

export { INGEST_QUEUE as QUEUE }

/** pg-boss 10+ registers queues explicitly; `send` / job rows reference `queue(name)` with a FK. */
export async function ensureIngestQueues(boss: PgBoss) {
	const rows = await boss.getQueues()
	const existing = new Set(rows.map((r) => r.name))
	for (const name of Object.values(INGEST_QUEUE)) {
		if (!existing.has(name)) {
			await boss.createQueue(name)
		}
	}
}

export async function registerIngestWorkers(boss: PgBoss) {
	const opts = { batchSize: 1 }
	await boss.work(INGEST_QUEUE.KAIKKI, opts, async ([job]) =>
		processKaikkiJob(job as PgBoss.Job<KaikkiJobData>),
	)
	await boss.work(INGEST_QUEUE.FREQUENCY, opts, async ([job]) =>
		processFrequencyJob(job as PgBoss.Job<FrequencyJobData>),
	)
	await boss.work(INGEST_QUEUE.TATOEBA, opts, async ([job]) =>
		processTatoebaJob(job as PgBoss.Job<TatoebaJobData>),
	)

	console.log("[workers] Registered: kaikki, frequency, tatoeba")
}
