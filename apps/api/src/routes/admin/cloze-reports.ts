import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

const statusSchema = z.enum([
	"PENDING",
	"REMOVE_CANDIDATE",
	"SENTENCE_REMOVED",
	"CLUE_CORRECTED",
	"DISMISSED",
])

export const adminClozeReportsRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)

	.get(
		"/",
		zValidator(
			"query",
			z.object({
				targetLanguageId: z.string().uuid().optional(),
				status: statusSchema.optional(),
				limit: z.coerce.number().int().min(1).max(200).optional().default(50),
			}),
		),
		async (c) => {
			const { targetLanguageId, status, limit } = c.req.valid("query")

			const reports = await prisma.clozeIssueReport.findMany({
				where: {
					...(targetLanguageId ? { targetLanguageId } : {}),
					...(status ? { status } : {}),
				},
				orderBy: { createdAt: "desc" },
				take: limit,
				include: {
					nativeLanguage: { select: { id: true, name: true, code: true } },
					targetLanguage: { select: { id: true, name: true, code: true } },
				},
			})

			return c.json({
				reports: reports.map((r) => ({
					id: r.id,
					createdAt: r.createdAt.toISOString(),
					updatedAt: r.updatedAt.toISOString(),
					status: r.status,
					nativeLanguage: r.nativeLanguage,
					targetLanguage: r.targetLanguage,
					wordId: r.wordId,
					wordLemma: r.wordLemma,
					targetSentenceId: r.targetSentenceId,
					hintSentenceId: r.hintSentenceId,
					targetSentenceText: r.targetSentenceText,
					promptText: r.promptText,
					hintText: r.hintText,
					hintSource: r.hintSource,
					inlineHint: r.inlineHint,
					adminCorrectClue: r.adminCorrectClue,
					adminNote: r.adminNote,
				})),
			})
		},
	)

	.patch(
		"/:id",
		zValidator(
			"json",
			z.object({
				status: statusSchema,
				adminCorrectClue: z.string().optional(),
				adminNote: z.string().optional(),
			}),
		),
		async (c) => {
			const { id } = c.req.param()
			const body = c.req.valid("json")

			const prev = await prisma.clozeIssueReport.findUnique({ where: { id } })
			if (!prev) {
				return c.json({ error: "Report not found" }, 404)
			}

			const updated = await prisma.clozeIssueReport.update({
				where: { id },
				data: {
					status: body.status,
					...(body.adminCorrectClue !== undefined
						? { adminCorrectClue: body.adminCorrectClue }
						: {}),
					...(body.adminNote !== undefined ? { adminNote: body.adminNote } : {}),
				},
				include: {
					nativeLanguage: { select: { id: true, name: true, code: true } },
					targetLanguage: { select: { id: true, name: true, code: true } },
				},
			})

			// When a report is handled by sentence removal, flag the target sentence
			// so it is excluded from cloze tests at runtime.
			if (body.status === "SENTENCE_REMOVED" && prev.targetSentenceId) {
				await prisma.sentence.update({
					where: { id: prev.targetSentenceId },
					data: { markedForRemoval: true },
				})
			}

			// If the admin reverts from SENTENCE_REMOVED, un-flag the sentence —
			// but only if no other SENTENCE_REMOVED report references the same sentence.
			if (
				prev.status === "SENTENCE_REMOVED" &&
				body.status !== "SENTENCE_REMOVED" &&
				prev.targetSentenceId
			) {
				const otherRemoval = await prisma.clozeIssueReport.findFirst({
					where: {
						targetSentenceId: prev.targetSentenceId,
						status: "SENTENCE_REMOVED",
						id: { not: id },
					},
				})
				if (!otherRemoval) {
					await prisma.sentence.update({
						where: { id: prev.targetSentenceId },
						data: { markedForRemoval: false },
					})
				}
			}

			return c.json({
				report: {
					id: updated.id,
					createdAt: updated.createdAt.toISOString(),
					updatedAt: updated.updatedAt.toISOString(),
					status: updated.status,
					nativeLanguage: updated.nativeLanguage,
					targetLanguage: updated.targetLanguage,
					wordId: updated.wordId,
					wordLemma: updated.wordLemma,
					targetSentenceId: updated.targetSentenceId,
					hintSentenceId: updated.hintSentenceId,
					targetSentenceText: updated.targetSentenceText,
					promptText: updated.promptText,
					hintText: updated.hintText,
					hintSource: updated.hintSource,
					inlineHint: updated.inlineHint,
					adminCorrectClue: updated.adminCorrectClue,
					adminNote: updated.adminNote,
				},
			})
		},
	)
