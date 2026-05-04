import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import type PgBoss from "pg-boss"
import { chainCommonCurriculumKaikkiFromCommonWordsJob } from "../lib/ai-vocab-pipeline"
import { fetchTopFrequencyLemmas } from "../lib/fetch-top-frequency-lemmas"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"
import { syncLanguageCommonLemmasFromList } from "../lib/language-common-lemmas"

export interface CommonWordsTopJobData {
	jobId: string
	languageId: string
	limit?: number
	unitCount?: number
	glossLanguageName?: string
	glossLanguageCode?: string
	chainPipeline?: boolean
}

function asMetaRecord(metadata: unknown): Record<string, unknown> {
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>) }
	}
	return {}
}

export async function processCommonWordsTopJob(job: PgBoss.Job<CommonWordsTopJobData>) {
	const {
		jobId,
		languageId,
		limit: limitArg,
		unitCount: unitCountArg,
		glossLanguageName: glossNameArg,
		glossLanguageCode: glossCodeArg,
		chainPipeline: chainArg,
	} = job.data

	const row = await prisma.ingestionJob.findUnique({ where: { id: jobId } })
	const fileMeta = asMetaRecord(row?.metadata)
	const limit =
		typeof limitArg === "number" && limitArg > 0
			? limitArg
			: typeof fileMeta.limit === "number" && fileMeta.limit > 0
				? fileMeta.limit
				: 300
	const unitCount =
		typeof unitCountArg === "number" && unitCountArg > 0
			? unitCountArg
			: typeof fileMeta.unitCount === "number" && fileMeta.unitCount > 0
				? fileMeta.unitCount
				: 2000
	const glossLanguageName =
		typeof glossNameArg === "string"
			? glossNameArg
			: typeof fileMeta.glossLanguageName === "string"
				? fileMeta.glossLanguageName
				: "English"
	const glossLanguageCode =
		typeof glossCodeArg === "string"
			? glossCodeArg
			: typeof fileMeta.glossLanguageCode === "string"
				? fileMeta.glossLanguageCode
				: "en"
	const chainPipeline = chainArg === true || fileMeta.chainPipeline === true

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const r = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[common-words-top] skipped job ${jobId}: could not claim (ingestion status=${r?.status ?? "missing"})`,
		)
		return
	}

	try {
		const language = await prisma.language.findUnique({ where: { id: languageId } })
		if (!language) throw new Error(`Language ${languageId} not found`)

		await appendJobLog(
			jobId,
			"out",
			`Common words: fetching top ${limit} lemmas for ${language.name}…`,
		)

		const pack = await fetchTopFrequencyLemmas(language.code, limit)
		if (!pack) {
			throw new Error(
				`No HermitDave or BNPD frequency list available for language code "${language.code}"`,
			)
		}

		await appendJobLog(
			jobId,
			"out",
			`Source: ${pack.source} (${pack.format}) — ${pack.lemmas.length} lemmas (cap ${limit}).`,
		)

		if (await isIngestionJobCancelled(jobId)) return

		const prev = await snapshotJobMetadata(jobId)
		const done = await prisma.ingestionJob.updateMany({
			where: { id: jobId, status: "RUNNING" },
			data: {
				status: "COMPLETED",
				processedItems: pack.lemmas.length,
				totalItems: pack.lemmas.length,
				completedAt: new Date(),
				metadata: {
					...prev,
					topLemmas: pack.lemmas,
					limit,
					unitCount,
					glossLanguageName,
					glossLanguageCode,
					chainPipeline,
					frequencyFormat: pack.format,
					frequencySource: pack.source,
					downloadUrl: pack.downloadUrl,
				} as Prisma.InputJsonValue,
			},
		})
		if (done.count === 0) return

		await syncLanguageCommonLemmasFromList(languageId, pack.lemmas)

		await updateIngestionProgress(jobId, {
			processedItems: pack.lemmas.length,
			totalItems: pack.lemmas.length,
		})

		await appendJobLog(
			jobId,
			"out",
			"Common words: complete — review `topLemmas` in job metadata / output, then run common-curriculum (Kaikki) or LLM vocabulary when ready.",
		)

		if (chainPipeline) {
			await appendJobLog(jobId, "out", "Chaining to COMMON_CURRICULUM_KAIKKI (chainPipeline=true)…")
			await chainCommonCurriculumKaikkiFromCommonWordsJob(languageId, jobId)
		}
	} catch (err) {
		console.error("[common-words-top] Fatal error:", err)
		if (await isIngestionJobCancelled(jobId)) return
		await appendJobLog(jobId, "err", String(err))
		const snap = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true, processedItems: true },
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
