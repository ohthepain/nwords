import { prisma } from "@nwords/db"
import { sendIngestJob } from "./boss"
import { INGEST_QUEUE } from "./ingestion-queues"
import { resolveVocabLlmSeed } from "./language-common-lemmas"

export type AiVocabPipelineOptions = {
	/** Top frequency lemmas seed (default 200). */
	commonWordLimit?: number
	/** Total learning units the LLM must output (default 2000). */
	unitCount?: number
	/** Human name for gloss locale, e.g. "English". */
	glossLanguageName?: string
	/** Code for gloss locale, e.g. "en". */
	glossLanguageCode?: string
}

/**
 * Delete terminal ingestion rows and cancel RUNNING for this language (same hygiene as Kaikki pipeline),
 * then enqueue **`COMMON_WORDS_TOP` only** — review `topLemmas` in job metadata, then call
 * {@link enqueueVocabUnitsLlmFromCommonWords} (or admin **LLM vocabulary**) to run `VOCAB_UNITS_LLM`.
 *
 * Set `chainPipeline: true` on the job row / boss payload only when you want an immediate hand-off (rare).
 */
export async function enqueueAiVocabPipeline(
	languageId: string,
	options: AiVocabPipelineOptions = {},
): Promise<{ jobId: string } | null> {
	const lang = await prisma.language.findUnique({ where: { id: languageId } })
	if (!lang) return null

	await prisma.ingestionJob.deleteMany({
		where: {
			languageId,
			status: { in: ["COMPLETED", "FAILED", "CANCELLED", "PENDING"] },
		},
	})
	await prisma.ingestionJob.updateMany({
		where: { languageId, status: "RUNNING" },
		data: { status: "CANCELLED", completedAt: new Date() },
	})

	const commonWordLimit = options.commonWordLimit ?? 200
	const unitCount = options.unitCount ?? 2000
	const glossLanguageName = options.glossLanguageName ?? "English"
	const glossLanguageCode = options.glossLanguageCode ?? "en"

	const job = await prisma.ingestionJob.create({
		data: {
			type: "COMMON_WORDS_TOP",
			languageId,
			metadata: {
				chainPipeline: false,
				limit: commonWordLimit,
				unitCount,
				glossLanguageName,
				glossLanguageCode,
				languageCode: lang.code,
				languageName: lang.name,
			},
		},
	})

	await sendIngestJob(INGEST_QUEUE.COMMON_WORDS_TOP, {
		jobId: job.id,
		languageId,
		limit: commonWordLimit,
		unitCount,
		glossLanguageName,
		glossLanguageCode,
		chainPipeline: false,
	})

	return { jobId: job.id }
}

async function startVocabUnitsLlmFromSeed(
	languageId: string,
	opts?: { forceCommonWordsJobId?: string },
): Promise<{ jobId: string }> {
	const seed = await resolveVocabLlmSeed(languageId, opts)
	const lang = await prisma.language.findUnique({ where: { id: languageId } })
	if (!lang) throw new Error(`Language ${languageId} not found`)

	const vocabJob = await prisma.ingestionJob.create({
		data: {
			type: "VOCAB_UNITS_LLM",
			languageId,
			metadata: {
				requiredWords: seed.requiredWords,
				unitCount: seed.unitCount,
				glossLanguageName: seed.glossLanguageName,
				glossLanguageCode: seed.glossLanguageCode,
				languageCode: lang.code,
				languageName: lang.name,
				...(seed.chainedFromJobId ? { chainedFromJobId: seed.chainedFromJobId } : {}),
			},
		},
	})

	await sendIngestJob(INGEST_QUEUE.VOCAB_UNITS_LLM, {
		jobId: vocabJob.id,
		languageId,
		requiredWords: seed.requiredWords,
		unitCount: seed.unitCount,
		glossLanguageName: seed.glossLanguageName,
		glossLanguageCode: seed.glossLanguageCode,
	})

	return { jobId: vocabJob.id }
}

/**
 * Enqueue `VOCAB_UNITS_LLM` from the **curated common-lemmas list** when it has entries;
 * otherwise from the latest completed `COMMON_WORDS_TOP` job (list is synced from that job).
 * Pass `completedCommonWordsJobId` to pin a specific completed common-words job (overwrites the curated list to match that job).
 */
export async function enqueueVocabUnitsLlmFromCommonWords(
	languageId: string,
	completedCommonWordsJobId?: string,
): Promise<{ jobId: string }> {
	if (completedCommonWordsJobId) {
		return startVocabUnitsLlmFromSeed(languageId, {
			forceCommonWordsJobId: completedCommonWordsJobId,
		})
	}
	return startVocabUnitsLlmFromSeed(languageId)
}

/**
 * After `COMMON_WORDS_TOP` completes, enqueue `VOCAB_UNITS_LLM` using lemmas from that job’s metadata.
 */
export async function chainVocabUnitsLlmFromCommonWordsJob(
	languageId: string,
	completedCommonWordsJobId: string,
): Promise<{ jobId: string }> {
	return startVocabUnitsLlmFromSeed(languageId, {
		forceCommonWordsJobId: completedCommonWordsJobId,
	})
}
