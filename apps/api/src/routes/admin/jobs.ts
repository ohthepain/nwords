import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { zValidator } from "@hono/zod-validator"
import { type Prisma, prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { createModel } from "../../lib/ai"
import {
	enqueueAiVocabPipeline,
	enqueueCommonCurriculumKaikkiFromCommonWords,
	enqueueVocabUnitsLlmFromCommonWords,
} from "../../lib/ai-vocab-pipeline"
import { getAiConfig } from "../../lib/app-settings"
import { sendIngestJob } from "../../lib/boss"
import { INGEST_QUEUE } from "../../lib/ingestion-queues"
import { jobMetadataForRetry } from "../../lib/job-logs"
import { skipIngestionJobAndContinuePipeline } from "../../lib/skip-ingestion-chain"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"
import { runClozeGenerationPromptPreview } from "../../workers/cloze-generation"

const UPLOAD_DIR = path.join(process.cwd(), "uploads")

const adminPartOfSpeechSchema = z.enum([
	"NOUN",
	"VERB",
	"ADJECTIVE",
	"ADVERB",
	"PRONOUN",
	"DETERMINER",
	"PREPOSITION",
	"CONJUNCTION",
	"PARTICLE",
	"INTERJECTION",
	"NUMERAL",
	"PROPER_NOUN",
])

const TYPE_TO_QUEUE: Record<string, string> = {
	KAIKKI_WORDS: INGEST_QUEUE.KAIKKI,
	FREQUENCY_LIST: INGEST_QUEUE.FREQUENCY,
	TATOEBA_SENTENCES: INGEST_QUEUE.TATOEBA,
	WORD_FORMS: INGEST_QUEUE.WORD_FORMS,
	FIXED_EXPRESSIONS: INGEST_QUEUE.FIXED_EXPRESSIONS,
	CLOZE_QUALITY_ASSESSMENT: INGEST_QUEUE.CLOZE_QUALITY,
	CLOZE_GENERATION: INGEST_QUEUE.CLOZE_GENERATION,
	COMMON_WORDS_TOP: INGEST_QUEUE.COMMON_WORDS_TOP,
	COMMON_CURRICULUM_KAIKKI: INGEST_QUEUE.COMMON_CURRICULUM_KAIKKI,
	VOCAB_UNITS_LLM: INGEST_QUEUE.VOCAB_UNITS_LLM,
	VOCAB_CLEANUP: INGEST_QUEUE.VOCAB_CLEANUP,
	WORDS_GLOSS_CLEANUP: INGEST_QUEUE.WORDS_GLOSS_CLEANUP,
	CURRICULUM_TESTABILITY_TRIM: INGEST_QUEUE.CURRICULUM_TESTABILITY_TRIM,
	HERMIT_DAVE_COMMON_LEMMAS: INGEST_QUEUE.HERMIT_DAVE_COMMON_LEMMAS,
}

type RetryPlan =
	| { ok: true; queue: string; payload: Record<string, unknown> }
	| { ok: false; error: string }

function asMetaRecord(metadata: unknown): Record<string, unknown> {
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>) }
	}
	return {}
}

async function planRetryFromJob(job: {
	type: string
	languageId: string
	metadata: unknown
}): Promise<RetryPlan> {
	const meta = asMetaRecord(job.metadata)

	const language = await prisma.language.findUnique({ where: { id: job.languageId } })
	if (!language) {
		return { ok: false, error: "Language not found" }
	}

	switch (job.type) {
		case "KAIKKI_WORDS": {
			const filePath = typeof meta.filePath === "string" ? meta.filePath : undefined
			if (filePath) {
				try {
					await access(filePath)
				} catch {
					return { ok: false, error: "Original uploaded file is no longer on disk" }
				}
				return {
					ok: true,
					queue: INGEST_QUEUE.KAIKKI,
					payload: {
						languageId: job.languageId,
						filePath,
						chainPipeline: meta.chainPipeline === true,
						...(typeof meta.kaikkiMode === "string" ? { kaikkiMode: meta.kaikkiMode } : {}),
					},
				}
			}
			const rawUrls = meta.downloadUrls
			const urls = Array.isArray(rawUrls)
				? rawUrls.filter((u): u is string => typeof u === "string" && u.length > 0)
				: []
			const downloadUrl = typeof meta.downloadUrl === "string" ? meta.downloadUrl : undefined
			if (urls.length === 0 && !downloadUrl) {
				return {
					ok: false,
					error: "Job has no file path or download URLs in metadata; cannot retry",
				}
			}
			const payload: Record<string, unknown> = {
				languageId: job.languageId,
				chainPipeline: meta.chainPipeline === true,
			}
			if (urls.length > 1) {
				payload.downloadUrls = urls
			} else if (urls.length === 1) {
				payload.downloadUrl = urls[0]
			} else if (downloadUrl) {
				payload.downloadUrl = downloadUrl
			}
			if (typeof meta.kaikkiMode === "string") payload.kaikkiMode = meta.kaikkiMode
			return { ok: true, queue: INGEST_QUEUE.KAIKKI, payload }
		}
		case "FREQUENCY_LIST": {
			const filePath = typeof meta.filePath === "string" ? meta.filePath : undefined
			const downloadUrl = typeof meta.downloadUrl === "string" ? meta.downloadUrl : undefined
			const source = typeof meta.source === "string" ? meta.source : "retry"
			const fr = meta.format
			const format = fr === "bnpd" || fr === "hermitdave" || fr === "tsv" ? fr : "tsv"

			if (filePath) {
				try {
					await access(filePath)
				} catch {
					return { ok: false, error: "Original uploaded file is no longer on disk" }
				}
				return {
					ok: true,
					queue: INGEST_QUEUE.FREQUENCY,
					payload: {
						languageId: job.languageId,
						filePath,
						source,
						format,
						chainPipeline: meta.chainPipeline === true,
					},
				}
			}
			if (!downloadUrl) {
				return { ok: false, error: "Job has no file path or download URL; cannot retry" }
			}
			return {
				ok: true,
				queue: INGEST_QUEUE.FREQUENCY,
				payload: {
					languageId: job.languageId,
					downloadUrl,
					source,
					format,
					chainPipeline: meta.chainPipeline === true,
				},
			}
		}
		case "TATOEBA_SENTENCES": {
			const filePath = typeof meta.filePath === "string" ? meta.filePath : undefined
			const downloadUrl = typeof meta.downloadUrl === "string" ? meta.downloadUrl : undefined
			const langCodeRaw =
				typeof meta.tatoebaLangCode === "string"
					? meta.tatoebaLangCode
					: (language.code3 ?? language.code)
			if (!langCodeRaw?.trim()) {
				return { ok: false, error: "Language has no ISO 639-3 code for Tatoeba" }
			}
			const langCode = langCodeRaw.toLowerCase()
			const base: Record<string, unknown> = {
				languageId: job.languageId,
				langCode,
				chainPipeline: meta.chainPipeline === true,
			}
			if (typeof meta.translationLinksPath === "string") {
				base.translationLinksPath = meta.translationLinksPath
			}
			if (filePath) {
				try {
					await access(filePath)
				} catch {
					return { ok: false, error: "Original uploaded file is no longer on disk" }
				}
				base.filePath = filePath
				return { ok: true, queue: INGEST_QUEUE.TATOEBA, payload: base }
			}
			if (!downloadUrl) {
				return { ok: false, error: "Job has no file path or download URL; cannot retry" }
			}
			base.downloadUrl = downloadUrl
			return { ok: true, queue: INGEST_QUEUE.TATOEBA, payload: base }
		}
		case "WORD_FORMS": {
			const filePath = typeof meta.filePath === "string" ? meta.filePath : undefined
			if (filePath) {
				try {
					await access(filePath)
				} catch {
					return { ok: false, error: "Original uploaded file is no longer on disk" }
				}
				return {
					ok: true,
					queue: INGEST_QUEUE.WORD_FORMS,
					payload: {
						languageId: job.languageId,
						filePath,
						chainPipeline: meta.chainPipeline === true,
						...(typeof meta.kaikkiMode === "string" ? { kaikkiMode: meta.kaikkiMode } : {}),
					},
				}
			}
			const rawUrls = meta.downloadUrls
			const urls = Array.isArray(rawUrls)
				? rawUrls.filter((u): u is string => typeof u === "string" && u.length > 0)
				: []
			const downloadUrl = typeof meta.downloadUrl === "string" ? meta.downloadUrl : undefined
			if (urls.length === 0 && !downloadUrl) {
				return {
					ok: false,
					error: "Job has no file path or download URLs in metadata; cannot retry",
				}
			}
			const payload: Record<string, unknown> = {
				languageId: job.languageId,
				chainPipeline: meta.chainPipeline === true,
			}
			if (urls.length > 1) {
				payload.downloadUrls = urls
			} else if (urls.length === 1) {
				payload.downloadUrl = urls[0]
			} else if (downloadUrl) {
				payload.downloadUrl = downloadUrl
			}
			if (typeof meta.kaikkiMode === "string") payload.kaikkiMode = meta.kaikkiMode
			return { ok: true, queue: INGEST_QUEUE.WORD_FORMS, payload }
		}
		case "FIXED_EXPRESSIONS": {
			return {
				ok: true,
				queue: INGEST_QUEUE.FIXED_EXPRESSIONS,
				payload: { languageId: job.languageId },
			}
		}
		case "CLOZE_QUALITY_ASSESSMENT": {
			return {
				ok: true,
				queue: INGEST_QUEUE.CLOZE_QUALITY,
				payload: { languageId: job.languageId },
			}
		}
		case "CLOZE_GENERATION": {
			return {
				ok: true,
				queue: INGEST_QUEUE.CLOZE_GENERATION,
				payload: {
					languageId: job.languageId,
					...(typeof meta.unitsLimit === "number" ? { unitsLimit: meta.unitsLimit } : {}),
					...(typeof meta.candidatesPerUnit === "number"
						? { candidatesPerUnit: meta.candidatesPerUnit }
						: {}),
					...(typeof meta.selectedPerUnit === "number"
						? { selectedPerUnit: meta.selectedPerUnit }
						: {}),
					resetExisting: false,
				},
			}
		}
		case "COMMON_WORDS_TOP": {
			const limit = typeof meta.limit === "number" && meta.limit > 0 ? meta.limit : 300
			const unitCount =
				typeof meta.unitCount === "number" && meta.unitCount > 0 ? meta.unitCount : 2000
			const glossLanguageName =
				typeof meta.glossLanguageName === "string" ? meta.glossLanguageName : "English"
			const glossLanguageCode =
				typeof meta.glossLanguageCode === "string" ? meta.glossLanguageCode : "en"
			return {
				ok: true,
				queue: INGEST_QUEUE.COMMON_WORDS_TOP,
				payload: {
					languageId: job.languageId,
					limit,
					unitCount,
					glossLanguageName,
					glossLanguageCode,
					chainPipeline: meta.chainPipeline === true,
				},
			}
		}
		case "COMMON_CURRICULUM_KAIKKI": {
			return {
				ok: true,
				queue: INGEST_QUEUE.COMMON_CURRICULUM_KAIKKI,
				payload: {
					languageId: job.languageId,
					...(typeof meta.forceCommonWordsJobId === "string"
						? { forceCommonWordsJobId: meta.forceCommonWordsJobId }
						: {}),
				},
			}
		}
		case "HERMIT_DAVE_COMMON_LEMMAS": {
			const scanLimit =
				typeof meta.scanLimit === "number" && meta.scanLimit > 0 ? meta.scanLimit : 2000
			return {
				ok: true,
				queue: INGEST_QUEUE.HERMIT_DAVE_COMMON_LEMMAS,
				payload: {
					languageId: job.languageId,
					scanLimit,
				},
			}
		}
		case "VOCAB_UNITS_LLM": {
			const requiredWords = Array.isArray(meta.requiredWords)
				? meta.requiredWords.filter(
						(x): x is string => typeof x === "string" && x.trim().length > 0,
					)
				: []
			if (requiredWords.length === 0) {
				return { ok: false, error: "Job metadata missing requiredWords; cannot retry" }
			}
			const unitCount =
				typeof meta.unitCount === "number" && meta.unitCount > 0 ? meta.unitCount : 2000
			const glossLanguageName =
				typeof meta.glossLanguageName === "string" ? meta.glossLanguageName : "English"
			const glossLanguageCode =
				typeof meta.glossLanguageCode === "string" ? meta.glossLanguageCode : "en"
			return {
				ok: true,
				queue: INGEST_QUEUE.VOCAB_UNITS_LLM,
				payload: {
					languageId: job.languageId,
					requiredWords,
					unitCount,
					glossLanguageName,
					glossLanguageCode,
					chainPipeline: meta.chainPipeline === true,
				},
			}
		}
		case "VOCAB_CLEANUP": {
			return {
				ok: true,
				queue: INGEST_QUEUE.VOCAB_CLEANUP,
				payload: {
					languageId: job.languageId,
					dryRun: meta.dryRun === true,
					...(typeof meta.senseOffset === "number" ? { senseOffset: meta.senseOffset } : {}),
				},
			}
		}
		case "WORDS_GLOSS_CLEANUP": {
			return {
				ok: true,
				queue: INGEST_QUEUE.WORDS_GLOSS_CLEANUP,
				payload: {
					languageId: job.languageId,
				},
			}
		}
		case "CURRICULUM_TESTABILITY_TRIM": {
			return {
				ok: true,
				queue: INGEST_QUEUE.CURRICULUM_TESTABILITY_TRIM,
				payload: {
					languageId: job.languageId,
					dryRun: meta.dryRun === true,
					...(typeof meta.batchSize === "number" ? { batchSize: meta.batchSize } : {}),
				},
			}
		}
		default:
			return { ok: false, error: "This job type cannot be retried from the admin UI" }
	}
}

async function requeueIngestionJobFromSource(
	sourceJobId: string,
	mode: "retry" | "rerun",
): Promise<
	| { ok: true; job: ReturnType<typeof serializeJob>; httpStatus: 201 }
	| { ok: false; error: string; httpStatus: 400 | 404 | 500 }
> {
	const old = await prisma.ingestionJob.findUnique({ where: { id: sourceJobId } })
	if (!old) {
		return { ok: false, error: "Job not found", httpStatus: 404 }
	}

	if (mode === "retry") {
		if (old.status !== "FAILED" && old.status !== "CANCELLED") {
			return {
				ok: false,
				error: `Only failed or cancelled jobs can be retried (status is ${old.status})`,
				httpStatus: 400,
			}
		}
	} else {
		if (old.status !== "COMPLETED") {
			return {
				ok: false,
				error: `Only completed jobs can be re-run (status is ${old.status})`,
				httpStatus: 400,
			}
		}
	}

	const queueName = TYPE_TO_QUEUE[old.type]
	if (!queueName) {
		return { ok: false, error: "This job type cannot be re-queued", httpStatus: 400 }
	}

	const plan = await planRetryFromJob(old)
	if (!plan.ok) {
		return { ok: false, error: plan.error, httpStatus: 400 }
	}
	if (plan.queue !== queueName) {
		return { ok: false, error: "Internal re-queue routing mismatch", httpStatus: 500 }
	}

	const rawMeta = asMetaRecord(old.metadata)
	const {
		retriedFromJobId: _retriedFrom,
		retriedAt: _retriedAt,
		requeuedFromJobId: _requeuedFrom,
		...prevMeta
	}: Record<string, unknown> = rawMeta
	const cleanMeta = {
		...jobMetadataForRetry(prevMeta),
		...(mode === "rerun" ? { requeuedFromJobId: sourceJobId } : {}),
	}

	const newJob = await prisma.ingestionJob.create({
		data: {
			type: old.type,
			languageId: old.languageId,
			metadata: cleanMeta as Prisma.InputJsonValue,
		},
	})

	await sendIngestJob(queueName, { ...plan.payload, jobId: newJob.id })

	if (mode === "retry") {
		await prisma.ingestionJob.delete({ where: { id: sourceJobId } })
	}

	return { ok: true, job: serializeJob(newJob), httpStatus: 201 }
}

function serializeJob(j: {
	id: string
	type: string
	languageId: string
	status: string
	totalItems: number
	processedItems: number
	errorCount: number
	startedAt: Date | null
	completedAt: Date | null
	createdAt: Date
	metadata: unknown
}) {
	return {
		id: j.id,
		type: j.type,
		languageId: j.languageId,
		status: j.status,
		totalItems: j.totalItems,
		processedItems: j.processedItems,
		errorCount: j.errorCount,
		progress: j.totalItems > 0 ? Math.round((j.processedItems / j.totalItems) * 100) : 0,
		startedAt: j.startedAt instanceof Date ? j.startedAt.toISOString() : j.startedAt,
		completedAt: j.completedAt instanceof Date ? j.completedAt.toISOString() : j.completedAt,
		createdAt: j.createdAt instanceof Date ? j.createdAt.toISOString() : j.createdAt,
		metadata: j.metadata,
	}
}

export const adminJobsRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)

	// List ingestion jobs with pagination
	.get(
		"/",
		zValidator(
			"query",
			z.object({
				status: z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]).optional(),
				type: z
					.enum([
						"KAIKKI_WORDS",
						"FREQUENCY_LIST",
						"TATOEBA_SENTENCES",
						"WORD_FORMS",
						"AUDIO_FILES",
						"FIXED_EXPRESSIONS",
						"CLOZE_QUALITY_ASSESSMENT",
						"CLOZE_GENERATION",
						"COMMON_WORDS_TOP",
						"HERMIT_DAVE_COMMON_LEMMAS",
						"COMMON_CURRICULUM_KAIKKI",
						"VOCAB_UNITS_LLM",
						"VOCAB_CLEANUP",
						"WORDS_GLOSS_CLEANUP",
						"CURRICULUM_TESTABILITY_TRIM",
					])
					.optional(),
				limit: z.coerce.number().min(1).max(100).default(20),
				offset: z.coerce.number().min(0).default(0),
			}),
		),
		async (c) => {
			const { status, type, limit, offset } = c.req.valid("query")

			const where = {
				...(status && { status }),
				...(type && { type }),
			}

			const [jobs, total] = await Promise.all([
				prisma.ingestionJob.findMany({
					where,
					orderBy: [{ createdAt: "desc" }, { id: "desc" }],
					take: limit,
					skip: offset,
				}),
				prisma.ingestionJob.count({ where }),
			])

			return c.json({
				jobs: jobs.map(serializeJob),
				total,
			})
		},
	)

	// Get a specific job
	.get("/:id", async (c) => {
		const { id } = c.req.param()

		const job = await prisma.ingestionJob.findUnique({ where: { id } })

		if (!job) {
			return c.json({ error: "Job not found" }, 404)
		}

		return c.json(serializeJob(job))
	})

	// Create a new ingestion job (file upload)
	.post(
		"/",
		zValidator(
			"form",
			z.object({
				type: z.enum(["KAIKKI_WORDS", "FREQUENCY_LIST", "TATOEBA_SENTENCES"]),
				languageId: z.string().uuid(),
				source: z.string().optional(),
			}),
		),
		async (c) => {
			const { type, languageId, source } = c.req.valid("form")

			// Validate language exists
			const language = await prisma.language.findUnique({ where: { id: languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			// Get the uploaded file
			const body = await c.req.parseBody()
			const file = body.file
			if (!file || typeof file === "string") {
				return c.json({ error: "No file uploaded" }, 400)
			}

			// Save file to disk
			await mkdir(UPLOAD_DIR, { recursive: true })
			const filename = `${Date.now()}-${language.code}-${type.toLowerCase()}`
			const filePath = path.join(UPLOAD_DIR, filename)
			const arrayBuffer = await file.arrayBuffer()
			await writeFile(filePath, Buffer.from(arrayBuffer))

			// Create ingestion job record
			const job = await prisma.ingestionJob.create({
				data: {
					type,
					languageId,
					metadata: {
						originalFilename: file.name,
						filePath,
						source: source ?? file.name,
						languageCode: language.code,
						languageName: language.name,
					},
				},
			})

			const queueName = TYPE_TO_QUEUE[type]
			if (queueName) {
				const langCode3 = language.code3 ?? language.code
				const payload =
					type === "FREQUENCY_LIST"
						? {
								jobId: job.id,
								filePath,
								languageId,
								source: source ?? file.name,
								format: "tsv" as const,
							}
						: {
								jobId: job.id,
								filePath,
								languageId,
								langCode: langCode3,
								source: source ?? file.name,
							}
				await sendIngestJob(queueName, payload)
			}

			return c.json(serializeJob(job), 201)
		},
	)

	// Cancel a pending/running job
	.post("/:id/cancel", async (c) => {
		const { id } = c.req.param()

		const job = await prisma.ingestionJob.findUnique({ where: { id } })
		if (!job) {
			return c.json({ error: "Job not found" }, 404)
		}

		if (job.status !== "PENDING" && job.status !== "RUNNING") {
			return c.json({ error: `Cannot cancel job with status ${job.status}` }, 400)
		}

		const updated = await prisma.ingestionJob.update({
			where: { id },
			data: { status: "CANCELLED", completedAt: new Date() },
		})

		return c.json(serializeJob(updated))
	})

	/** Mark RUNNING/PENDING as COMPLETED (assume DB already has data), optional pipeline chain. */
	.post("/:id/skip-and-chain", async (c) => {
		const { id } = c.req.param()
		const out = await skipIngestionJobAndContinuePipeline(id)
		if (!out.ok) {
			return c.json({ error: out.error }, out.status as 400 | 404)
		}
		const job = await prisma.ingestionJob.findUnique({ where: { id } })
		if (!job) {
			return c.json({ error: "Job not found" }, 404)
		}
		return c.json(serializeJob(job))
	})

	// Re-queue a failed or cancelled job (new row + pg-boss message; replaces the old row)
	.post("/:id/retry", async (c) => {
		const { id: sourceJobId } = c.req.param()
		const out = await requeueIngestionJobFromSource(sourceJobId, "retry")
		if (!out.ok) {
			return c.json({ error: out.error }, out.httpStatus)
		}
		return c.json(out.job, out.httpStatus)
	})

	// Re-queue a completed job (new row + pg-boss message; keeps the completed row for history)
	.post("/:id/rerun", async (c) => {
		const { id: sourceJobId } = c.req.param()
		const out = await requeueIngestionJobFromSource(sourceJobId, "rerun")
		if (!out.ok) {
			return c.json({ error: out.error }, out.httpStatus)
		}
		return c.json(out.job, out.httpStatus)
	})

	// Generate fixed-expression rules for a language via LLM (no file upload needed)
	.post(
		"/fixed-expressions",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
			}),
		),
		async (c) => {
			const { languageId } = c.req.valid("json")

			const language = await prisma.language.findUnique({ where: { id: languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const job = await prisma.ingestionJob.create({
				data: {
					type: "FIXED_EXPRESSIONS",
					languageId,
					metadata: {
						languageCode: language.code,
						languageName: language.name,
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.FIXED_EXPRESSIONS, {
				jobId: job.id,
				languageId,
			})

			return c.json(serializeJob(job), 201)
		},
	)

	/** AI step 1: enqueue `COMMON_WORDS_TOP` (review lemmas, then `POST …/common-curriculum-kaikki/from-common-words` or LLM vocab). */
	.post(
		"/ai-vocab-pipeline",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				commonWordLimit: z.number().int().min(10).max(5000).optional(),
				unitCount: z.number().int().min(50).max(10_000).optional(),
				glossLanguageName: z.string().min(1).optional(),
				glossLanguageCode: z.string().min(1).optional(),
			}),
		),
		async (c) => {
			const body = c.req.valid("json")
			const language = await prisma.language.findUnique({ where: { id: body.languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const started = await enqueueAiVocabPipeline(body.languageId, {
				commonWordLimit: body.commonWordLimit,
				unitCount: body.unitCount,
				glossLanguageName: body.glossLanguageName,
				glossLanguageCode: body.glossLanguageCode,
			})
			if (!started) {
				return c.json({ error: "Failed to enqueue AI vocabulary pipeline" }, 500)
			}

			const job = await prisma.ingestionJob.findUnique({ where: { id: started.jobId } })
			if (!job) {
				return c.json({ error: "Job row missing after enqueue" }, 500)
			}
			return c.json(serializeJob(job), 201)
		},
	)

	.post(
		"/common-words-top",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				limit: z.number().int().min(10).max(5000).optional(),
				unitCount: z.number().int().min(50).max(10_000).optional(),
				glossLanguageName: z.string().min(1).optional(),
				glossLanguageCode: z.string().min(1).optional(),
				chainPipeline: z.boolean().optional(),
			}),
		),
		async (c) => {
			const body = c.req.valid("json")
			const language = await prisma.language.findUnique({ where: { id: body.languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const limit = body.limit ?? 300
			const unitCount = body.unitCount ?? 2000
			const glossLanguageName = body.glossLanguageName ?? "English"
			const glossLanguageCode = body.glossLanguageCode ?? "en"
			const chainPipeline = body.chainPipeline === true

			const job = await prisma.ingestionJob.create({
				data: {
					type: "COMMON_WORDS_TOP",
					languageId: body.languageId,
					metadata: {
						limit,
						unitCount,
						glossLanguageName,
						glossLanguageCode,
						chainPipeline,
						languageCode: language.code,
						languageName: language.name,
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.COMMON_WORDS_TOP, {
				jobId: job.id,
				languageId: body.languageId,
				limit,
				unitCount,
				glossLanguageName,
				glossLanguageCode,
				chainPipeline,
			})

			return c.json(serializeJob(job), 201)
		},
	)

	.post(
		"/common-curriculum-kaikki/from-common-words",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				commonWordsJobId: z.string().uuid().optional(),
			}),
		),
		async (c) => {
			const body = c.req.valid("json")
			const language = await prisma.language.findUnique({ where: { id: body.languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			try {
				const out = await enqueueCommonCurriculumKaikkiFromCommonWords(
					body.languageId,
					body.commonWordsJobId,
				)
				const jobCreated = await prisma.ingestionJob.findUnique({ where: { id: out.jobId } })
				if (!jobCreated) {
					return c.json({ error: "Job row missing after enqueue" }, 500)
				}
				return c.json(serializeJob(jobCreated), 201)
			} catch (e) {
				return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
			}
		},
	)

	.post(
		"/vocab-units-llm/from-common-words",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				commonWordsJobId: z.string().uuid().optional(),
			}),
		),
		async (c) => {
			const body = c.req.valid("json")
			const language = await prisma.language.findUnique({ where: { id: body.languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			try {
				const out = await enqueueVocabUnitsLlmFromCommonWords(
					body.languageId,
					body.commonWordsJobId,
				)
				const job = await prisma.ingestionJob.findUnique({ where: { id: out.jobId } })
				if (!job) {
					return c.json({ error: "Job row missing after enqueue" }, 500)
				}
				return c.json(serializeJob(job), 201)
			} catch (e) {
				return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
			}
		},
	)

	.post(
		"/vocab-units-llm",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				requiredWords: z.array(z.string().min(1)).min(1),
				unitCount: z.number().int().min(50).max(10_000),
				glossLanguageName: z.string().min(1).optional(),
				glossLanguageCode: z.string().min(1).optional(),
			}),
		),
		async (c) => {
			const body = c.req.valid("json")
			const language = await prisma.language.findUnique({ where: { id: body.languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const glossLanguageName = body.glossLanguageName ?? "English"
			const glossLanguageCode = body.glossLanguageCode ?? "en"

			const job = await prisma.ingestionJob.create({
				data: {
					type: "VOCAB_UNITS_LLM",
					languageId: body.languageId,
					metadata: {
						requiredWords: body.requiredWords,
						unitCount: body.unitCount,
						glossLanguageName,
						glossLanguageCode,
						languageCode: language.code,
						languageName: language.name,
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.VOCAB_UNITS_LLM, {
				jobId: job.id,
				languageId: body.languageId,
				requiredWords: body.requiredWords,
				unitCount: body.unitCount,
				glossLanguageName,
				glossLanguageCode,
			})

			return c.json(serializeJob(job), 201)
		},
	)

	.post(
		"/vocab-cleanup",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				dryRun: z.boolean().optional(),
				senseOffset: z.number().int().min(1).max(10_000).optional(),
			}),
		),
		async (c) => {
			const body = c.req.valid("json")
			const language = await prisma.language.findUnique({ where: { id: body.languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const dryRun = body.dryRun === true
			const job = await prisma.ingestionJob.create({
				data: {
					type: "VOCAB_CLEANUP",
					languageId: body.languageId,
					metadata: {
						dryRun,
						languageCode: language.code,
						languageName: language.name,
						...(body.senseOffset !== undefined ? { senseOffset: body.senseOffset } : {}),
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.VOCAB_CLEANUP, {
				jobId: job.id,
				languageId: body.languageId,
				dryRun,
				...(body.senseOffset !== undefined ? { senseOffset: body.senseOffset } : {}),
			})

			return c.json(serializeJob(job), 201)
		},
	)

	.post(
		"/words-gloss-cleanup",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
			}),
		),
		async (c) => {
			const body = c.req.valid("json")
			const language = await prisma.language.findUnique({ where: { id: body.languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const job = await prisma.ingestionJob.create({
				data: {
					type: "WORDS_GLOSS_CLEANUP",
					languageId: body.languageId,
					metadata: {
						languageCode: language.code,
						languageName: language.name,
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.WORDS_GLOSS_CLEANUP, {
				jobId: job.id,
				languageId: body.languageId,
			})

			return c.json(serializeJob(job), 201)
		},
	)

	.post(
		"/curriculum-testability-trim",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				dryRun: z.boolean().optional(),
				batchSize: z.number().int().min(10).max(200).optional(),
			}),
		),
		async (c) => {
			const body = c.req.valid("json")
			const language = await prisma.language.findUnique({ where: { id: body.languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const dryRun = body.dryRun === true
			const job = await prisma.ingestionJob.create({
				data: {
					type: "CURRICULUM_TESTABILITY_TRIM",
					languageId: body.languageId,
					metadata: {
						dryRun,
						languageCode: language.code,
						languageName: language.name,
						...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.CURRICULUM_TESTABILITY_TRIM, {
				jobId: job.id,
				languageId: body.languageId,
				dryRun,
				...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
			})

			return c.json(serializeJob(job), 201)
		},
	)

	// Assess cloze quality for the top-1000 words of a language via LLM (no file upload needed)
	.post(
		"/cloze-quality-assessment",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				maxSentencesPerWord: z.number().int().min(1).max(500).optional(),
			}),
		),
		async (c) => {
			const { languageId, maxSentencesPerWord } = c.req.valid("json")

			const language = await prisma.language.findUnique({ where: { id: languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const job = await prisma.ingestionJob.create({
				data: {
					type: "CLOZE_QUALITY_ASSESSMENT",
					languageId,
					metadata: {
						languageCode: language.code,
						languageName: language.name,
						...(maxSentencesPerWord !== undefined ? { maxSentencesPerWord } : {}),
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.CLOZE_QUALITY, {
				jobId: job.id,
				languageId,
				...(maxSentencesPerWord !== undefined ? { maxSentencesPerWord } : {}),
			})

			return c.json(serializeJob(job), 201)
		},
	)

	// Generate first-class AI cloze items from AI curriculum units (no file upload needed)
	.post(
		"/cloze-generation",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				unitsLimit: z.number().int().min(1).max(10000).optional(),
				candidatesPerUnit: z.number().int().min(5).max(20).default(10),
				selectedPerUnit: z.number().int().min(1).max(10).default(5),
				resetExisting: z.boolean().default(false),
			}),
		),
		async (c) => {
			const { languageId, unitsLimit, candidatesPerUnit, selectedPerUnit, resetExisting } =
				c.req.valid("json")

			const language = await prisma.language.findUnique({ where: { id: languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const job = await prisma.ingestionJob.create({
				data: {
					type: "CLOZE_GENERATION",
					languageId,
					metadata: {
						languageCode: language.code,
						languageName: language.name,
						...(unitsLimit !== undefined ? { unitsLimit } : {}),
						candidatesPerUnit,
						selectedPerUnit,
						resetExisting,
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.CLOZE_GENERATION, {
				jobId: job.id,
				languageId,
				...(unitsLimit !== undefined ? { unitsLimit } : {}),
				candidatesPerUnit,
				selectedPerUnit,
				resetExisting,
			})

			return c.json(serializeJob(job), 201)
		},
	)

	.post(
		"/cloze-generation-prompt-preview",
		zValidator(
			"json",
			z.object({
				languageId: z.string().uuid(),
				lemma: z.string().min(1).max(200),
				pos: adminPartOfSpeechSchema,
				unitType: z.enum(["WORD", "PARTICLE", "FIXED_EXPR", "SPLIT"]),
				gloss: z.string().max(500).optional().default(""),
				rank: z.number().int().min(0).max(1_000_000).optional().default(100),
				tags: z.array(z.string()).max(20).optional().default([]),
				form: z.record(z.string(), z.unknown()).nullable().optional(),
				candidatesPerUnit: z.number().int().min(5).max(20).optional().default(10),
				selectedPerUnit: z.number().int().min(1).max(10).optional().default(5),
				runValidator: z.boolean().optional().default(false),
			}),
		),
		async (c) => {
			const body = c.req.valid("json")

			const language = await prisma.language.findUnique({ where: { id: body.languageId } })
			if (!language) {
				return c.json({ error: "Language not found" }, 404)
			}

			const aiConfig = await getAiConfig()
			if (!aiConfig) {
				return c.json(
					{ error: "AI is not configured. Set provider, model, and API key in admin settings." },
					503,
				)
			}

			try {
				const model = createModel(aiConfig)
				const preview = await runClozeGenerationPromptPreview({
					model,
					languageName: language.name,
					lemma: body.lemma.trim(),
					pos: body.pos,
					unitType: body.unitType,
					gloss: body.gloss,
					rank: body.rank,
					tags: body.tags,
					form: body.form ?? null,
					candidatesPerUnit: body.candidatesPerUnit,
					selectedPerUnit: body.selectedPerUnit,
					runValidator: body.runValidator,
				})
				return c.json({
					languageCode: language.code,
					languageName: language.name,
					unitJson: preview.unitJson,
					systemPrompt: preview.systemPrompt,
					userPrompt: preview.userPrompt,
					rawLlmCandidates: preview.rawLlmCandidates,
					unitRejection: preview.unitRejection,
					candidatePreviewRows: preview.candidatePreviewRows,
					usableCandidates: preview.usableCandidates,
					selectedCandidates: preview.selectedCandidates,
					validator: preview.validator,
					summary: {
						returned: preview.rawLlmCandidates.length,
						usable: preview.usableCandidates.length,
						selected: preview.selectedCandidates.length,
					},
				})
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				return c.json({ error: message }, 500)
			}
		},
	)
