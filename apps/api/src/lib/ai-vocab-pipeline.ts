import { prisma } from "@nwords/db"
import { sendIngestJob } from "./boss"
import { INGEST_QUEUE } from "./ingestion-queues"
import { resolveVocabLlmSeed } from "./language-common-lemmas"

export type AiVocabPipelineOptions = {
	/** Top frequency lemmas seed (default 300). */
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
 * then enqueue COMMON_WORDS_TOP — review lemmas in metadata, then run common-curriculum (Kaikki) or optional LLM.
 * {@link enqueueCommonCurriculumKaikkiFromCommonWords}; {@link enqueueVocabUnitsLlmFromCommonWords} for LLM only.
 *
 * With `chainPipeline: true`, COMMON_WORDS_TOP hands off automatically to `COMMON_CURRICULUM_KAIKKI`.
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

	const commonWordLimit = options.commonWordLimit ?? 300
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

async function startCommonCurriculumKaikkiFromSeed(
	languageId: string,
	opts?: { forceCommonWordsJobId?: string },
): Promise<{ jobId: string }> {
	const seed = await resolveVocabLlmSeed(languageId, opts)
	const lang = await prisma.language.findUnique({ where: { id: languageId } })
	if (!lang) throw new Error(`Language ${languageId} not found`)

	const job = await prisma.ingestionJob.create({
		data: {
			type: "COMMON_CURRICULUM_KAIKKI",
			languageId,
			metadata: {
				requiredWords: seed.requiredWords,
				unitCount: seed.unitCount,
				glossLanguageName: seed.glossLanguageName,
				glossLanguageCode: seed.glossLanguageCode,
				languageCode: lang.code,
				languageName: lang.name,
				...(opts?.forceCommonWordsJobId
					? { forceCommonWordsJobId: opts.forceCommonWordsJobId }
					: {}),
				...(seed.chainedFromJobId ? { chainedFromCommonWordsJobId: seed.chainedFromJobId } : {}),
			},
		},
	})

	await sendIngestJob(INGEST_QUEUE.COMMON_CURRICULUM_KAIKKI, {
		jobId: job.id,
		languageId,
		...(opts?.forceCommonWordsJobId ? { forceCommonWordsJobId: opts.forceCommonWordsJobId } : {}),
	})

	return { jobId: job.id }
}

/** Build `COMMON` curriculum words from curated common lemmas via Kaikki (inflection-aware). */
export async function enqueueCommonCurriculumKaikkiFromCommonWords(
	languageId: string,
	completedCommonWordsJobId?: string,
): Promise<{ jobId: string }> {
	if (completedCommonWordsJobId) {
		return startCommonCurriculumKaikkiFromSeed(languageId, {
			forceCommonWordsJobId: completedCommonWordsJobId,
		})
	}
	return startCommonCurriculumKaikkiFromSeed(languageId)
}

/** Chain target after {@link COMMON_WORDS_TOP} completes when `chainPipeline` is true. */
export async function chainCommonCurriculumKaikkiFromCommonWordsJob(
	languageId: string,
	completedCommonWordsJobId: string,
): Promise<{ jobId: string }> {
	return startCommonCurriculumKaikkiFromSeed(languageId, {
		forceCommonWordsJobId: completedCommonWordsJobId,
	})
}

/** Manual step: append top-N HermitDave frequency lemmas into `language_common_lemma` (skips existing). */
export async function enqueueHermitDaveCommonLemmasJob(
	languageId: string,
	options?: { scanLimit?: number },
): Promise<{ jobId: string }> {
	const scanLimitRaw = options?.scanLimit ?? 2000
	const scanLimit =
		Number.isFinite(scanLimitRaw) && scanLimitRaw > 0
			? Math.min(Math.floor(scanLimitRaw), 25_000)
			: 2000

	const lang = await prisma.language.findUnique({ where: { id: languageId } })
	if (!lang) throw new Error(`Language ${languageId} not found`)

	const job = await prisma.ingestionJob.create({
		data: {
			type: "HERMIT_DAVE_COMMON_LEMMAS",
			languageId,
			metadata: {
				scanLimit,
				languageCode: lang.code,
				languageName: lang.name,
			},
		},
	})

	await sendIngestJob(INGEST_QUEUE.HERMIT_DAVE_COMMON_LEMMAS, {
		jobId: job.id,
		languageId,
		scanLimit,
	})

	return { jobId: job.id }
}
