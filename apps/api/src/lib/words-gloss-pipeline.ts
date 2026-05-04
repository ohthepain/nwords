import { prisma } from "@nwords/db"
import { sendIngestJob } from "./boss"
import { INGEST_QUEUE } from "./ingestion-queues"

/** After COMMON_CURRICULUM_KAIKKI completes; normalizes gloss + testability for learner-facing rows. */
export async function chainWordsGlossCleanup(
	languageId: string,
): Promise<{ jobId: string } | null> {
	const lang = await prisma.language.findUnique({ where: { id: languageId } })
	if (!lang) return null

	const job = await prisma.ingestionJob.create({
		data: {
			type: "WORDS_GLOSS_CLEANUP",
			languageId,
			metadata: {
				chainedFromCommonCurriculumKaikki: true,
				languageCode: lang.code,
				languageName: lang.name,
			},
		},
	})

	await sendIngestJob(INGEST_QUEUE.WORDS_GLOSS_CLEANUP, {
		jobId: job.id,
		languageId,
	})

	return { jobId: job.id }
}
