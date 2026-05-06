import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { chainCommonCurriculumKaikkiFromCommonWordsJob } from "./ai-vocab-pipeline"
import { appendJobLog, snapshotJobMetadata } from "./job-logs"
import {
	chainFrequencyFromKaikki,
	chainTatoebaFromFrequency,
	chainWordFormsFromTatoeba,
} from "./pipeline-chain"
import { chainWordsGlossCleanup } from "./words-gloss-pipeline"

function asMetaRecord(metadata: unknown): Record<string, unknown> {
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>) }
	}
	return {}
}

/**
 * Operator-only: mark a stuck RUNNING/PENDING job as COMPLETED (assume work is already in DB),
 * append a log line, and enqueue the next pipeline step when `metadata.chainPipeline` is true.
 */
export async function skipIngestionJobAndContinuePipeline(
	jobId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
	const job = await prisma.ingestionJob.findUnique({ where: { id: jobId } })
	if (!job) {
		return { ok: false, error: "Job not found", status: 404 }
	}
	if (job.status !== "PENDING" && job.status !== "RUNNING") {
		return {
			ok: false,
			error: `Only pending or running jobs can be skipped (status is ${job.status})`,
			status: 400,
		}
	}

	const meta = asMetaRecord(job.metadata)
	const chain = meta.chainPipeline === true

	await appendJobLog(
		jobId,
		"out",
		chain
			? "Operator skip: assuming import results are already in the DB; marking complete and continuing pipeline."
			: "Operator skip: assuming import results are already in the DB; marking complete.",
	)

	const snap = await snapshotJobMetadata(jobId)
	await prisma.ingestionJob.update({
		where: { id: jobId },
		data: {
			status: "COMPLETED",
			completedAt: new Date(),
			metadata: {
				...snap,
				operatorSkipAssumedDbComplete: true,
				operatorSkippedAt: new Date().toISOString(),
			} as Prisma.InputJsonValue,
		},
	})

	if (!chain) {
		return { ok: true }
	}

	const languageId = job.languageId
	switch (job.type) {
		case "KAIKKI_WORDS": {
			const freqBusy = await prisma.ingestionJob.findFirst({
				where: {
					languageId,
					type: "FREQUENCY_LIST",
					status: { in: ["PENDING", "RUNNING"] },
				},
				select: { id: true },
			})
			if (!freqBusy) {
				await chainFrequencyFromKaikki(languageId)
			}
			break
		}
		case "FREQUENCY_LIST":
			await chainTatoebaFromFrequency(languageId, { operatorSkippedFrequencyJob: true })
			break
		case "TATOEBA_SENTENCES":
			await chainWordFormsFromTatoeba(languageId, { operatorSkippedTatoebaJob: true })
			break
		case "WORD_FORMS":
			break
		case "COMMON_WORDS_TOP": {
			const m = asMetaRecord(job.metadata)
			if (
				m.chainPipeline === true &&
				Array.isArray(m.topLemmas) &&
				m.topLemmas.every((x): x is string => typeof x === "string") &&
				m.topLemmas.length > 0
			) {
				await chainCommonCurriculumKaikkiFromCommonWordsJob(languageId, jobId)
			}
			break
		}
		case "VOCAB_UNITS_LLM":
			break
		case "VOCAB_CLEANUP":
			break
		case "WORDS_GLOSS_CLEANUP":
			break
		case "CURRICULUM_TESTABILITY_TRIM":
			break
		case "CURRICULUM_TESTABILITY_TRIM_RETRY":
			break
		case "COMMON_CURRICULUM_KAIKKI":
			await chainWordsGlossCleanup(languageId)
			break
		case "HERMIT_DAVE_COMMON_LEMMAS":
			break
		default:
			break
	}

	return { ok: true }
}
