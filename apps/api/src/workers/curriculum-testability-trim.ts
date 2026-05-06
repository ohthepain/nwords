import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { generateObject } from "ai"
import type PgBoss from "pg-boss"
import { z } from "zod"
import { createModel } from "../lib/ai"
import { getAiConfig } from "../lib/app-settings"
import {
	COMMON_CURRICULUM_FREQUENCY_TAG,
	pgJsonArrayContainsScalar,
} from "../lib/common-curriculum-tags"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"
import { normalizeCommonLemma } from "../lib/language-common-lemmas"
import { extractDefinitionStrings } from "../lib/word-gloss-heuristics"
import { countClozeScopedNonTestableWords, runClozeGenerationWorkload } from "./cloze-generation"

export interface CurriculumTestabilityTrimJobData {
	jobId: string
	languageId: string
	dryRun?: boolean
	/** Rows per LLM request (default 100). */
	batchSize?: number
}

/** Re-check non-testable: runs the same cloze pipeline as “Generate clozes” for scoped `isTestable=false` rows. */
export type CurriculumTestabilityTrimRetryJobData = CurriculumTestabilityTrimJobData

const TX_CHUNK = 400

const trimBatchResponseSchema = z.object({
	removeIds: z.array(z.string().uuid()),
})

function asMetaRecord(metadata: unknown): Record<string, unknown> {
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>) }
	}
	return {}
}

function resolveBatchSize(jobMeta: Record<string, unknown>, explicit?: number): number {
	if (typeof explicit === "number" && explicit >= 10 && explicit <= 200) return Math.floor(explicit)
	const fromMeta = jobMeta.batchSize
	if (typeof fromMeta === "number" && fromMeta >= 10 && fromMeta <= 200) return Math.floor(fromMeta)
	const raw = process.env.CURRICULUM_TESTABILITY_TRIM_BATCH_SIZE?.trim()
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN
	if (Number.isFinite(n) && n >= 10 && n <= 200) return n
	return 100
}

function trimLlmConcurrency(): number {
	const raw = Number(process.env.CURRICULUM_TESTABILITY_TRIM_LLM_CONCURRENCY)
	const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4
	return Math.max(1, Math.min(12, n))
}

function chunkArray<T>(arr: T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
	return out
}

function baseLemmaFromUnit(curriculumUnit: unknown): string | undefined {
	if (
		curriculumUnit === null ||
		typeof curriculumUnit !== "object" ||
		Array.isArray(curriculumUnit)
	) {
		return undefined
	}
	const base = (curriculumUnit as Record<string, unknown>).baseLemma
	if (typeof base !== "string") return undefined
	const s = normalizeCommonLemma(base)
	return s.length > 0 ? s : undefined
}

function defsForPrompt(definitions: unknown): string[] {
	return extractDefinitionStrings(definitions)
		.slice(0, 4)
		.map((d) => (d.length > 240 ? `${d.slice(0, 237)}...` : d))
}

async function runPool<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>,
	shouldStop: () => Promise<boolean>,
): Promise<void> {
	let next = 0
	const runWorker = async () => {
		for (;;) {
			if (await shouldStop()) return
			const i = next++
			if (i >= items.length) return
			if (items[i] === undefined) {
				console.error(`[curriculum-testability-trim] item ${i} is undefined`)
				continue
			}
			if (items[i] === null) {
				console.error(`[curriculum-testability-trim] item ${i} is null`)
				continue
			}
			await fn(items[i])
		}
	}
	const workers = Math.max(1, Math.min(concurrency, Math.max(1, items.length)))
	await Promise.all(Array.from({ length: workers }, () => runWorker()))
}

const TRIM_SYSTEM = `You are cleaning and normalizing vocabulary data for a language learning app.

Your job is to decide which rows should be REMOVED from active vocabulary testing.

CRITICAL PRINCIPLES:

1. FREQUENCY IS THE MOST IMPORTANT SIGNAL
- High-frequency words and forms (A1–A2, low rank numbers) should almost always be kept
- Low-frequency or rare forms can be removed

2. FUNCTION WORDS MUST BE KEPT
Always keep high-frequency grammar words, even if abstract:
- pronouns (det, den, de, dem)
- determiners (denna, detta, dessa)
- auxiliary and modal verbs (är, har, vill, kan, ska)
- prepositions and conjunctions (i, på, och, men, att)

These are essential for forming sentences and are highly testable.

3. TESTABILITY RULE
A word is testable if:
- it is required to form a correct sentence, OR
- choosing the wrong word would produce an incorrect or unnatural sentence

This includes:
- modal verbs (vill, kan, ska)
- auxiliary verbs (är, har)
- pronouns and determiners

Do NOT mark a word as "not testable" just because:
- it is abstract
- it is predictable
- it has weak standalone meaning

4. KEEP COMMON FORMS (DO NOT OVER-NORMALIZE)
Do NOT reduce every lemma to a single form.

Instead:
- Keep multiple common spoken forms of a word
- Remove only rare or unusual inflections

For verbs:
- Keep common forms such as present and past (e.g. vill, ville)
- Remove rare or archaic forms

For nouns/adjectives:
- Keep common forms (e.g. singular, plural if frequent)
- Remove unusual or low-frequency inflections

5. REMOVE BAD ENTRIES
Remove rows if:
- The definition is junk, malformed, or irrelevant (e.g. "id", nonsense text)
- The lemma is clearly broken or non-existent (e.g. "detet", "deten")
- The sense is obscure, archaic, or domain-specific (e.g. musical notes like "D♭")
- The row is an inflection-only artifact that does not correspond to real usage

6. HANDLE MULTIPLE ROWS OF THE SAME LEMMA
- Keep multiple entries if they represent common and distinct forms used in real speech
- Remove duplicate, malformed, or rare entries
- Remove incorrect or misleading senses (e.g. wrong part of speech)

7. DECISION ORDER (FOLLOW STRICTLY)
When deciding to remove a row, apply rules in this order:

1. If it is a high-frequency function word → KEEP
2. If it is a high-frequency common form → KEEP
3. If it is malformed or junk → REMOVE
4. If it is a rare or obscure sense → REMOVE
5. If it is a rare inflection → REMOVE

Never remove a row solely because it is abstract or grammatical.

OUTPUT

Return ONLY structured data matching the schema:
{ "removeIds": string[] }

Include only ids from the input. Use an empty array if nothing should be removed.
`

type ScopedRow = {
	id: string
	lemma: string
	pos: string
	effectiveRank: number
	rank: number
	gloss: string | null
	definitions: unknown
	curriculumUnit: unknown
}

const PREVIEW_CAP = 80

async function llmRemoveIdsForBatch(
	model: ReturnType<typeof createModel>,
	languageName: string,
	languageCode: string,
	batch: ScopedRow[],
	batchIndex: number,
	batchTotal: number,
): Promise<string[]> {
	const inputIdSet = new Set(batch.map((r) => r.id))
	const payload = {
		targetLanguage: languageName,
		targetLanguageCode: languageCode,
		batchIndex: batchIndex + 1,
		batchTotal,
		words: batch.map((r) => ({
			id: r.id,
			lemma: r.lemma,
			baseLemma: baseLemmaFromUnit(r.curriculumUnit) ?? null,
			pos: r.pos,
			gloss: r.gloss,
			definitions: defsForPrompt(r.definitions),
			effectiveRank: r.effectiveRank,
		})),
	}

	const prompt = `Batch ${batchIndex + 1}/${batchTotal}. INPUT JSON:\n${JSON.stringify(payload, null, 2)}\n\nReturn removeIds for rows to drop from testing.`

	for (let attempt = 0; attempt < 2; attempt++) {
		const { object } = await generateObject({
			model,
			schema: trimBatchResponseSchema,
			system: TRIM_SYSTEM,
			prompt:
				attempt === 0
					? prompt
					: `${prompt}\n\nRetry: removeIds must be a subset of the input ids only.`,
		})
		const filtered = object.removeIds.filter((id) => inputIdSet.has(id))
		if (filtered.length === object.removeIds.length || attempt === 1) return filtered
	}

	return []
}

async function runCurriculumTestabilityTrimInner(
	job: PgBoss.Job<CurriculumTestabilityTrimJobData>,
): Promise<void> {
	const { jobId, languageId } = job.data
	const row = await prisma.ingestionJob.findUnique({ where: { id: jobId } })
	const fileMeta = asMetaRecord(row?.metadata)

	const dryRun =
		job.data.dryRun === true ||
		fileMeta.dryRun === true ||
		(typeof fileMeta.dryRun === "string" && fileMeta.dryRun === "true")

	const batchSize = resolveBatchSize(fileMeta, job.data.batchSize)

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const r = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[curriculum-testability-trim] skipped job ${jobId}: could not claim (status=${r?.status ?? "missing"})`,
		)
		return
	}

	let batchErrors = 0

	try {
		const language = await prisma.language.findUnique({ where: { id: languageId } })
		if (!language) throw new Error(`Language ${languageId} not found`)

		const aiConfig = await getAiConfig()
		if (!aiConfig) {
			throw new Error("AI is not configured. Set provider, model, and API key in admin settings.")
		}
		const model = createModel(aiConfig)

		await appendJobLog(
			jobId,
			"out",
			`Curriculum testability trim (LLM): ${language.name} — ${dryRun ? "DRY RUN" : "apply"}; batch size ${batchSize}; concurrency ${trimLlmConcurrency()}.`,
		)

		const commonFreqContain = pgJsonArrayContainsScalar(COMMON_CURRICULUM_FREQUENCY_TAG)

		const rows = (await prisma.$queryRawUnsafe(
			`SELECT w.id, w.lemma, w.pos::text AS pos, w."effectiveRank", w.rank, w.gloss, w.definitions, w."curriculumUnit"
			FROM word w
			WHERE w."languageId" = $1::uuid
			AND w.rank > 0
			AND w."isAbbreviation" = false
			AND w."isOffensive" = false
			AND (
				w."curriculumSource" IN ('AI_CURRICULUM', 'COMMON', 'HERMIT_DAVE')
				OR (
					w."curriculumSource" = 'KAIKKI'
					AND w."curriculumUnit" IS NOT NULL
					AND COALESCE(w."curriculumUnit"::jsonb->'tags', '[]'::jsonb) @> ${commonFreqContain}
				)
			)
			ORDER BY w."effectiveRank" ASC, w.rank ASC`,
			languageId,
		)) as ScopedRow[]

		if (rows.length === 0) {
			await appendJobLog(jobId, "out", "No scoped curriculum rows — nothing to trim.")
			const metaPrev = await snapshotJobMetadata(jobId)
			await prisma.ingestionJob.updateMany({
				where: { id: jobId, status: "RUNNING" },
				data: {
					status: "COMPLETED",
					processedItems: 0,
					totalItems: 0,
					completedAt: new Date(),
					metadata: {
						...metaPrev,
						dryRun,
						batchSize,
						curriculumTestabilityTrim: {
							scopedRows: 0,
							testableRows: 0,
							batchesTotal: 0,
							removeIdsCount: 0,
							batchErrors: 0,
							previewSample: [],
						},
					} as Prisma.InputJsonValue,
				},
			})
			return
		}

		/** Dry run: do not touch DB; still evaluate all scoped rows as if deciding testability fresh. */
		const rowsToProcess = rows
		const batches = chunkArray(rowsToProcess, batchSize)

		await updateIngestionProgress(jobId, {
			totalItems: rowsToProcess.length,
			processedItems: 0,
			errorCount: 0,
		})

		await appendJobLog(
			jobId,
			"out",
			`${dryRun ? "Dry run — " : ""}Scoped ${rows.length.toLocaleString()} row(s) → ${batches.length} LLM batch(es).`,
		)

		const removeAccum = new Set<string>()
		const concurrency = trimLlmConcurrency()

		const processBatch = async (batch: ScopedRow[], bi: number) => {
			if (await isIngestionJobCancelled(jobId)) return
			try {
				const ids = await llmRemoveIdsForBatch(
					model,
					language.name,
					language.code,
					batch,
					bi,
					batches.length,
				)
				for (const id of ids) removeAccum.add(id)
			} catch (err) {
				batchErrors++
				await appendJobLog(
					jobId,
					"err",
					`Batch ${bi + 1}/${batches.length}: ${err instanceof Error ? err.message : String(err)}`,
				)
				await updateIngestionProgress(jobId, { errorDelta: 1 })
			} finally {
				await updateIngestionProgress(jobId, { processedDelta: batch.length })
			}
		}

		await runPool(
			batches.map((b, i) => [b, i] as const),
			concurrency,
			async ([batch, bi]) => processBatch(batch, bi),
			() => isIngestionJobCancelled(jobId),
		)

		if (await isIngestionJobCancelled(jobId)) return

		const rowIdSet = new Set(rows.map((r) => r.id))
		const untestableTarget = [...removeAccum].filter((id) => rowIdSet.has(id))

		const previewSample = untestableTarget.slice(0, PREVIEW_CAP).map((id) => {
			const r = rows.find((x) => x.id === id)
			return r ? { id, lemma: r.lemma, pos: r.pos, effectiveRank: r.effectiveRank } : { id }
		})

		await appendJobLog(
			jobId,
			"out",
			`LLM suggested ${untestableTarget.length.toLocaleString()} row(s) to mark untestable${batchErrors > 0 ? `; ${batchErrors} batch error(s)` : ""}.`,
		)

		if (!dryRun && rows.length > 0) {
			const rowIds = rows.map((r) => r.id)
			const keepTestableIds = rowIds.filter((id) => !removeAccum.has(id))
			const markUntestableIds = rowIds.filter((id) => removeAccum.has(id))
			await appendJobLog(
				jobId,
				"out",
				`Applying isTestable from LLM: ${keepTestableIds.length.toLocaleString()} true, ${markUntestableIds.length.toLocaleString()} false (of ${rowIds.length.toLocaleString()} row(s) in this job).`,
			)
			for (let i = 0; i < keepTestableIds.length; i += TX_CHUNK) {
				if (await isIngestionJobCancelled(jobId)) return
				const slice = keepTestableIds.slice(i, i + TX_CHUNK)
				await prisma.word.updateMany({
					where: { id: { in: slice }, languageId },
					data: { isTestable: true },
				})
			}
			for (let i = 0; i < markUntestableIds.length; i += TX_CHUNK) {
				if (await isIngestionJobCancelled(jobId)) return
				const slice = markUntestableIds.slice(i, i + TX_CHUNK)
				await prisma.word.updateMany({
					where: { id: { in: slice }, languageId },
					data: { isTestable: false },
				})
			}
		}

		const metaPrev = await snapshotJobMetadata(jobId)

		await prisma.ingestionJob.updateMany({
			where: { id: jobId, status: "RUNNING" },
			data: {
				status: "COMPLETED",
				processedItems: rowsToProcess.length,
				totalItems: rowsToProcess.length,
				completedAt: new Date(),
				metadata: {
					...metaPrev,
					dryRun,
					batchSize,
					curriculumTestabilityTrim: {
						scopedRows: rows.length,
						testableRows: rowsToProcess.length,
						batchesTotal: batches.length,
						removeIdsCount: untestableTarget.length,
						batchErrors,
						previewSample,
					},
				} as Prisma.InputJsonValue,
			},
		})

		await appendJobLog(
			jobId,
			"out",
			dryRun
				? "Dry run complete — no DB updates. See metadata curriculumTestabilityTrim."
				: `Applied isTestable from LLM: ${(rows.length - untestableTarget.length).toLocaleString()} true, ${untestableTarget.length.toLocaleString()} false.`,
		)
	} catch (err) {
		console.error("[curriculum-testability-trim] Fatal error:", err)
		if (await isIngestionJobCancelled(jobId)) return
		await appendJobLog(jobId, "err", String(err))
		const snap = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true },
		})
		const meta = snap?.metadata
		const prevMeta =
			meta !== null && typeof meta === "object" && !Array.isArray(meta)
				? { ...(meta as Record<string, unknown>) }
				: {}
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: {
					...prevMeta,
					error: err instanceof Error ? err.message : String(err),
					curriculumTestabilityTrimBatchErrors: batchErrors,
				} as Prisma.InputJsonValue,
			},
		})
		throw err
	}
}

export async function processCurriculumTestabilityTrimJob(
	job: PgBoss.Job<CurriculumTestabilityTrimJobData>,
) {
	await runCurriculumTestabilityTrimInner(job)
}

export async function processCurriculumTestabilityTrimRetryJob(
	job: PgBoss.Job<CurriculumTestabilityTrimRetryJobData>,
) {
	const { jobId, languageId } = job.data
	const snap = await prisma.ingestionJob.findUnique({ where: { id: jobId } })
	const fileMeta = asMetaRecord(snap?.metadata)
	const dryRun =
		job.data.dryRun === true ||
		fileMeta.dryRun === true ||
		(typeof fileMeta.dryRun === "string" && fileMeta.dryRun === "true")

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const row = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[curriculum-testability-trim-retry] skipped job ${jobId}: could not claim (status=${row?.status ?? "missing"})`,
		)
		return
	}

	try {
		const language = await prisma.language.findUnique({ where: { id: languageId } })
		if (!language) throw new Error(`Language ${languageId} not found`)

		await appendJobLog(
			jobId,
			"out",
			dryRun
				? `Dry run — non-testable re-check (cloze pipeline): ${language.name}…`
				: `Non-testable re-check — full cloze generation for scoped rows (${language.name}): same pipeline as Generate clozes (unit gate → candidates → normalization → validator).`,
		)

		if (dryRun) {
			const n = await countClozeScopedNonTestableWords(languageId)
			await appendJobLog(
				jobId,
				"out",
				`Dry run — would process ${n.toLocaleString()} non-testable curriculum-scoped row(s); no AI or DB cloze writes.`,
			)
			const metaPrev = await snapshotJobMetadata(jobId)
			await prisma.ingestionJob.updateMany({
				where: { id: jobId, status: "RUNNING" },
				data: {
					status: "COMPLETED",
					processedItems: n,
					totalItems: n,
					completedAt: new Date(),
					metadata: {
						...metaPrev,
						dryRun: true,
						curriculumTestabilityTrimRetry: {
							mode: "cloze_reverify_dry_run",
							scopedNonTestableRows: n,
						},
					} as Prisma.InputJsonValue,
				},
			})
			return
		}

		await runClozeGenerationWorkload({
			jobId,
			languageId,
			resetExisting: false,
			nonTestableScopedOnly: true,
		})
	} catch (err) {
		console.error("[curriculum-testability-trim-retry] Fatal error:", err)
		if (await isIngestionJobCancelled(jobId)) return
		await appendJobLog(jobId, "err", String(err))
		const metaSnap = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true },
		})
		const meta = metaSnap?.metadata
		const prevMeta =
			meta !== null && typeof meta === "object" && !Array.isArray(meta)
				? { ...(meta as Record<string, unknown>) }
				: {}
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
