import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { prisma } from "@nwords/db"
import { authMiddleware } from "../../middleware/auth.ts"
import { adminMiddleware } from "../../middleware/admin.ts"

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
				jobs: jobs.map((j) => ({
					id: j.id,
					type: j.type,
					languageId: j.languageId,
					status: j.status,
					totalItems: j.totalItems,
					processedItems: j.processedItems,
					errorCount: j.errorCount,
					progress: j.totalItems > 0 ? Math.round((j.processedItems / j.totalItems) * 100) : 0,
					startedAt: j.startedAt?.toISOString() ?? null,
					completedAt: j.completedAt?.toISOString() ?? null,
					createdAt: j.createdAt.toISOString(),
					metadata: j.metadata,
				})),
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

		return c.json({
			id: job.id,
			type: job.type,
			languageId: job.languageId,
			status: job.status,
			totalItems: job.totalItems,
			processedItems: job.processedItems,
			errorCount: job.errorCount,
			progress: job.totalItems > 0 ? Math.round((job.processedItems / job.totalItems) * 100) : 0,
			startedAt: job.startedAt?.toISOString() ?? null,
			completedAt: job.completedAt?.toISOString() ?? null,
			createdAt: job.createdAt.toISOString(),
			metadata: job.metadata,
		})
	})
