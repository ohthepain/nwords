import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { appendJobLog, snapshotJobMetadata } from "./job-logs"
import { chainFrequencyFromKaikki, chainTatoebaFromFrequency } from "./pipeline-chain"

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
export async function skipIngestionJobAndContinuePipeline(jobId: string): Promise<
	| { ok: true }
	| { ok: false; error: string; status: number }
> {
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
			break
		default:
			break
	}

	return { ok: true }
}
