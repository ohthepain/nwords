import type PgBoss from "pg-boss"
import { INGEST_QUEUE } from "../lib/ingestion-queues"
import type { ClozeGenerationJobData } from "./cloze-generation"
import { processClozeGenerationJob } from "./cloze-generation"
import type { ClozeQualityJobData } from "./cloze-quality"
import { processClozeQualityJob } from "./cloze-quality"
import type { CommonCurriculumKaikkiJobData } from "./common-curriculum-kaikki"
import { processCommonCurriculumKaikkiJob } from "./common-curriculum-kaikki"
import type { CommonWordsTopJobData } from "./common-words-top"
import { processCommonWordsTopJob } from "./common-words-top"
import type { CurriculumTestabilityTrimJobData } from "./curriculum-testability-trim"
import { processCurriculumTestabilityTrimJob } from "./curriculum-testability-trim"
import type { FixedExpressionsJobData } from "./fixed-expressions"
import { processFixedExpressionsJob } from "./fixed-expressions"
import type { FrequencyJobData } from "./frequency"
import { processFrequencyJob } from "./frequency"
import type { HermitDaveCommonLemmasJobData } from "./hermit-dave-common-lemmas"
import { processHermitDaveCommonLemmasJob } from "./hermit-dave-common-lemmas"
import type { KaikkiJobData } from "./kaikki"
import { processKaikkiJob } from "./kaikki"
import type { TatoebaJobData } from "./tatoeba"
import { processTatoebaJob } from "./tatoeba"
import type { VocabCleanupJobData } from "./vocab-cleanup"
import { processVocabCleanupJob } from "./vocab-cleanup"
import type { VocabUnitsLlmJobData } from "./vocab-units-llm"
import { processVocabUnitsLlmJob } from "./vocab-units-llm"
import type { WordFormsJobData } from "./word-forms"
import { processWordFormsJob } from "./word-forms"
import type { WordsGlossCleanupJobData } from "./words-gloss-cleanup"
import { processWordsGlossCleanupJob } from "./words-gloss-cleanup"

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
	await boss.work(INGEST_QUEUE.CLOZE_GENERATION, opts, async ([job]) =>
		processClozeGenerationJob(job as PgBoss.Job<ClozeGenerationJobData>),
	)
	await boss.work(INGEST_QUEUE.COMMON_WORDS_TOP, opts, async ([job]) =>
		processCommonWordsTopJob(job as PgBoss.Job<CommonWordsTopJobData>),
	)
	await boss.work(INGEST_QUEUE.HERMIT_DAVE_COMMON_LEMMAS, opts, async ([job]) =>
		processHermitDaveCommonLemmasJob(job as PgBoss.Job<HermitDaveCommonLemmasJobData>),
	)
	await boss.work(INGEST_QUEUE.COMMON_CURRICULUM_KAIKKI, opts, async ([job]) =>
		processCommonCurriculumKaikkiJob(job as PgBoss.Job<CommonCurriculumKaikkiJobData>),
	)
	await boss.work(INGEST_QUEUE.VOCAB_UNITS_LLM, opts, async ([job]) =>
		processVocabUnitsLlmJob(job as PgBoss.Job<VocabUnitsLlmJobData>),
	)
	await boss.work(INGEST_QUEUE.VOCAB_CLEANUP, opts, async ([job]) =>
		processVocabCleanupJob(job as PgBoss.Job<VocabCleanupJobData>),
	)
	await boss.work(INGEST_QUEUE.WORDS_GLOSS_CLEANUP, opts, async ([job]) =>
		processWordsGlossCleanupJob(job as PgBoss.Job<WordsGlossCleanupJobData>),
	)
	await boss.work(INGEST_QUEUE.CURRICULUM_TESTABILITY_TRIM, opts, async ([job]) =>
		processCurriculumTestabilityTrimJob(job as PgBoss.Job<CurriculumTestabilityTrimJobData>),
	)

	console.log(
		"[workers] Registered: kaikki, frequency, tatoeba, word-forms, fixed-expressions, cloze-quality, cloze-generation, common-words-top, hermit-dave-common-lemmas, common-curriculum-kaikki, vocab-units-llm, vocab-cleanup, words-gloss-cleanup, curriculum-testability-trim",
	)
}
