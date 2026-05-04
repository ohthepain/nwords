import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import type PgBoss from "pg-boss"
import { fetchHermitDaveFrequencyLemmasOnly } from "../lib/fetch-top-frequency-lemmas"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"
import {
	appendCommonLemmasNotAlreadyPresent,
	normalizeCommonLemma,
} from "../lib/language-common-lemmas"

export interface HermitDaveCommonLemmasJobData {
	jobId: string
	languageId: string
	scanLimit?: number
}

function asMetaRecord(metadata: unknown): Record<string, unknown> {
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>) }
	}
	return {}
}

export async function processHermitDaveCommonLemmasJob(
	job: PgBoss.Job<HermitDaveCommonLemmasJobData>,
) {
	const { jobId, languageId, scanLimit: scanLimitArg } = job.data

	const row = await prisma.ingestionJob.findUnique({ where: { id: jobId } })
	const fileMeta = asMetaRecord(row?.metadata)
	const scanLimitRaw =
		typeof scanLimitArg === "number" && scanLimitArg > 0
			? scanLimitArg
			: typeof fileMeta.scanLimit === "number" && fileMeta.scanLimit > 0
				? fileMeta.scanLimit
				: 2000
	const scanLimit = Math.min(Math.floor(scanLimitRaw), 25_000)

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const r = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[hermit-dave-common-lemmas] skipped job ${jobId}: could not claim (ingestion status=${r?.status ?? "missing"})`,
		)
		return
	}

	try {
		const language = await prisma.language.findUnique({ where: { id: languageId } })
		if (!language) throw new Error(`Language ${languageId} not found`)

		await appendJobLog(
			jobId,
			"out",
			`Hermit Dave common lemmas: reading top ${scanLimit} ranked lines for ${language.name} (${language.code})…`,
		)

		await updateIngestionProgress(jobId, { totalItems: scanLimit, processedItems: 0 })

		const pack = await fetchHermitDaveFrequencyLemmasOnly(language.code, scanLimit)
		if (!pack) {
			throw new Error(
				`No HermitDave FrequencyWords list for language code "${language.code}" — add a BNPD/other seed or contribute a HermitDave file for this language.`,
			)
		}

		const seenLine = new Set<string>()
		const uniqueFromFile: string[] = []
		for (const w of pack.lemmas) {
			const n = normalizeCommonLemma(w)
			if (!n || seenLine.has(n)) continue
			seenLine.add(n)
			uniqueFromFile.push(w)
		}

		await appendJobLog(
			jobId,
			"out",
			`Source: ${pack.source} — scanned ${pack.lemmas.length} ranked line(s) (${uniqueFromFile.length} unique lemmas in scan window).`,
		)

		if (await isIngestionJobCancelled(jobId)) return

		const stats = await appendCommonLemmasNotAlreadyPresent(languageId, pack.lemmas, {
			sourceForNewRows: "HERMIT_DAVE",
		})

		await appendJobLog(
			jobId,
			"out",
			`HermitDave append complete — added ${stats.added}, skipped ${stats.skippedAlreadyInDb} already in common lemmas, ${stats.skippedDuplicateInCandidates} duplicate(s) inside file window.`,
		)

		await updateIngestionProgress(jobId, {
			totalItems: pack.lemmas.length,
			processedItems: pack.lemmas.length,
		})

		const prev = await snapshotJobMetadata(jobId)
		const done = await prisma.ingestionJob.updateMany({
			where: { id: jobId, status: "RUNNING" },
			data: {
				status: "COMPLETED",
				completedAt: new Date(),
				totalItems: pack.lemmas.length,
				processedItems: pack.lemmas.length,
				metadata: {
					...prev,
					scanLimit,
					scannedHermitDaveLines: pack.lemmas.length,
					uniqueLemmaCountInScan: uniqueFromFile.length,
					addedLemmaCount: stats.added,
					skippedExistingInDb: stats.skippedAlreadyInDb,
					skippedDuplicatesInHermitSlice: stats.skippedDuplicateInCandidates,
					frequencySource: pack.source,
					downloadUrl: pack.downloadUrl,
					format: pack.format,
				} as Prisma.InputJsonValue,
			},
		})
		if (done.count === 0) return
	} catch (err) {
		console.error("[hermit-dave-common-lemmas] Fatal error:", err)
		if (await isIngestionJobCancelled(jobId)) return
		await appendJobLog(jobId, "err", String(err))
		const snap = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true },
		})
		const prevMeta = asMetaRecord(snap?.metadata)
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: {
					...prevMeta,
					error: err instanceof Error ? err.message : String(err),
				} as Prisma.InputJsonValue,
			},
		})
		throw err
	}
}
