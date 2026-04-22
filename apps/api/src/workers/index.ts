import type PgBoss from "pg-boss"
import { INGEST_QUEUE } from "../lib/ingestion-queues"
import type { ClozeQualityJobData } from "./cloze-quality"
import { processClozeQualityJob } from "./cloze-quality"
import type { FixedExpressionsJobData } from "./fixed-expressions"
import { processFixedExpressionsJob } from "./fixed-expressions"
import type { FrequencyJobData } from "./frequency"
import { processFrequencyJob } from "./frequency"
import type { KaikkiJobData } from "./kaikki"
import { processKaikkiJob } from "./kaikki"
import type { TatoebaJobData } from "./tatoeba"
import { processTatoebaJob } from "./tatoeba"
import type { WordFormsJobData } from "./word-forms"
import { processWordFormsJob } from "./word-forms"

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
	await boss.work(INGEST_QUEUE.WORD_FORMS, opts, async ([job]) =>
		processWordFormsJob(job as PgBoss.Job<WordFormsJobData>),
	)
	await boss.work(INGEST_QUEUE.FIXED_EXPRESSIONS, opts, async ([job]) =>
		processFixedExpressionsJob(job as PgBoss.Job<FixedExpressionsJobData>),
	)
	await boss.work(INGEST_QUEUE.CLOZE_QUALITY, opts, async ([job]) =>
		processClozeQualityJob(job as PgBoss.Job<ClozeQualityJobData>),
	)

	console.log(
		"[workers] Registered: kaikki, frequency, tatoeba, word-forms, fixed-expressions, cloze-quality",
	)
}
