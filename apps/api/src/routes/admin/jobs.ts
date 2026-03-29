import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { getBoss } from "../../lib/boss.ts"
import { INGEST_QUEUE } from "../../lib/ingestion-queues.ts"
import { adminMiddleware } from "../../middleware/admin.ts"
import { authMiddleware } from "../../middleware/auth.ts"

const UPLOAD_DIR = path.join(process.cwd(), "uploads")

const TYPE_TO_QUEUE: Record<string, string> = {
	KAIKKI_WORDS: INGEST_QUEUE.KAIKKI,
	FREQUENCY_LIST: INGEST_QUEUE.FREQUENCY,
	TATOEBA_SENTENCES: INGEST_QUEUE.TATOEBA,
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
		default:
			return { ok: false, error: "This job type cannot be retried from the admin UI" }
	}
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
					.enum(["KAIKKI_WORDS", "FREQUENCY_LIST", "TATOEBA_SENTENCES", "AUDIO_FILES"])
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
					orderBy: { createdAt: "desc" },
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

			// Enqueue the job with pg-boss
			const queueName = TYPE_TO_QUEUE[type]
			if (queueName) {
				const boss = await getBoss()
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
				await boss.send(queueName, payload)
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

	// Re-queue a failed or cancelled job (new row + pg-boss message)
	.post("/:id/retry", async (c) => {
		const { id: sourceJobId } = c.req.param()

		const old = await prisma.ingestionJob.findUnique({ where: { id: sourceJobId } })
		if (!old) {
			return c.json({ error: "Job not found" }, 404)
		}

		if (old.status !== "FAILED" && old.status !== "CANCELLED") {
			return c.json(
				{
					error: `Only failed or cancelled jobs can be retried (status is ${old.status})`,
				},
				400,
			)
		}

		const queueName = TYPE_TO_QUEUE[old.type]
		if (!queueName) {
			return c.json({ error: "This job type cannot be retried" }, 400)
		}

		const plan = await planRetryFromJob(old)
		if (!plan.ok) {
			return c.json({ error: plan.error }, 400)
		}
		if (plan.queue !== queueName) {
			return c.json({ error: "Internal retry routing mismatch" }, 500)
		}

		const prevMeta = asMetaRecord(old.metadata)
		const newJob = await prisma.ingestionJob.create({
			data: {
				type: old.type,
				languageId: old.languageId,
				metadata: {
					...prevMeta,
					retriedFromJobId: old.id,
					retriedAt: new Date().toISOString(),
				} satisfies Record<string, unknown>,
			},
		})

		const boss = await getBoss()
		await boss.send(queueName, { ...plan.payload, jobId: newJob.id })

		return c.json(serializeJob(newJob), 201)
	})
