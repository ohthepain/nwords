import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { checkSynonymWithLlm } from "../../lib/ai"
import { lookupUserAnswerWords } from "../../lib/pos-lookup"
import { upsertWordSynonymPair } from "../../lib/word-synonym-pair"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

const statusSchema = z.enum([
	"PENDING",
	"REMOVE_CANDIDATE",
	"SENTENCE_REMOVED",
	"CLUE_CORRECTED",
	"DISMISSED",
	"GOOD_SYNONYM",
	"BAD_SYNONYM",
	"EXCLUDED_FROM_TESTS",
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
					...(status
						? { status }
						: { status: { notIn: ["DISMISSED", "EXCLUDED_FROM_TESTS"] } }),
				},
				orderBy: { createdAt: "desc" },
				take: limit,
				include: {
					nativeLanguage: { select: { id: true, name: true, code: true } },
					targetLanguage: { select: { id: true, name: true, code: true } },
					word: { select: { positionAdjust: true, isTestable: true } },
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
					wordIsTestable: r.word.isTestable,
					positionAdjust: r.word.positionAdjust,
					targetSentenceId: r.targetSentenceId,
					hintSentenceId: r.hintSentenceId,
					targetSentenceText: r.targetSentenceText,
					promptText: r.promptText,
					hintText: r.hintText,
					hintSource: r.hintSource,
					inlineHint: r.inlineHint,
					userGuess: r.userGuess,
					adminCorrectClue: r.adminCorrectClue,
					adminNote: r.adminNote,
				})),
			})
		},
	)

	.post(
		"/:id/exclude-from-vocab-tests",
		zValidator(
			"json",
			z.object({ adminNote: z.string().max(2000).optional() }).default({}),
		),
		async (c) => {
			const { id } = c.req.param()
			const body = c.req.valid("json")

			const report = await prisma.clozeIssueReport.findUnique({ where: { id } })
			if (!report) {
				return c.json({ error: "Report not found" }, 404)
			}

			const tag = "Excluded lemma from vocabulary tests (isTestable=false)."
			const noteParts = [report.adminNote?.trim(), body.adminNote?.trim()]
			if (report.status !== "EXCLUDED_FROM_TESTS") {
				noteParts.push(tag)
			}
			const mergedNote = noteParts.filter(Boolean).join("\n")

			await prisma.$transaction([
				prisma.word.update({
					where: { id: report.wordId },
					data: { isTestable: false },
				}),
				prisma.clozeIssueReport.update({
					where: { id },
					data: {
						status: "EXCLUDED_FROM_TESTS",
						...(mergedNote ? { adminNote: mergedNote } : {}),
					},
				}),
			])

			return c.json({ ok: true, wordId: report.wordId, status: "EXCLUDED_FROM_TESTS" as const })
		},
	)

	.post(
		"/:id/synonym",
		zValidator("json", z.object({ quality: z.enum(["GOOD", "BAD"]) })),
		async (c) => {
			const { id } = c.req.param()
			const { quality } = c.req.valid("json")

			const report = await prisma.clozeIssueReport.findUnique({ where: { id } })
			if (!report) {
				return c.json({ error: "Report not found" }, 404)
			}

			const guessRaw = report.userGuess?.trim()
			if (!guessRaw) {
				return c.json({ error: "Report has no user guess to map to a word" }, 400)
			}

			const candidates = await lookupUserAnswerWords(guessRaw, report.targetLanguageId)
			if (candidates.length === 0) {
				return c.json(
					{
						error: "Could not resolve the guess to a dictionary word in the target language",
					},
					400,
				)
			}

			const guessWord = candidates[0]
			if (guessWord.id === report.wordId) {
				return c.json({ error: "Guess resolves to the same word as the cloze target" }, 400)
			}

			await upsertWordSynonymPair(report.targetLanguageId, guessWord.id, report.wordId, quality)

			const nextStatus = quality === "GOOD" ? "GOOD_SYNONYM" : "BAD_SYNONYM"
			await prisma.clozeIssueReport.update({
				where: { id },
				data: { status: nextStatus },
			})

			return c.json({
				ok: true,
				quality,
				status: nextStatus,
				guessLemma: guessWord.lemma,
				targetLemma: report.wordLemma,
			})
		},
	)

	.post("/:id/check-synonym", async (c) => {
		const { id } = c.req.param()
		const report = await prisma.clozeIssueReport.findUnique({
			where: { id },
			include: {
				targetLanguage: { select: { code: true } },
				nativeLanguage: { select: { code: true } },
			},
		})
		if (!report) return c.json({ error: "Report not found" }, 404)
		if (!report.userGuess?.trim()) return c.json({ error: "Report has no user guess" }, 400)

		try {
			const verdict = await checkSynonymWithLlm({
				wordLemma: report.wordLemma,
				userGuess: report.userGuess.trim(),
				targetSentenceText: report.targetSentenceText,
				promptText: report.promptText,
				targetLanguageCode: report.targetLanguage.code,
				nativeLanguageCode: report.nativeLanguage.code,
			})
			return c.json({ verdict })
		} catch (e) {
			const msg = e instanceof Error ? e.message : "LLM check failed"
			return c.json({ error: msg }, 500)
		}
	})

	.patch(
		"/:id",
		zValidator(
			"json",
			z.object({
				status: statusSchema,
				adminCorrectClue: z.string().optional(),
				adminNote: z.string().optional(),
				userGuess: z.string().optional(),
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
					...(body.userGuess !== undefined ? { userGuess: body.userGuess } : {}),
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
					userGuess: updated.userGuess,
					adminCorrectClue: updated.adminCorrectClue,
					adminNote: updated.adminNote,
				},
			})
		},
	)

	.delete("/:id", async (c) => {
		const { id } = c.req.param()

		const report = await prisma.clozeIssueReport.findUnique({ where: { id } })
		if (!report) {
			return c.json({ error: "Report not found" }, 404)
		}
		if (report.status !== "DISMISSED") {
			return c.json({ error: "Only dismissed reports can be deleted" }, 400)
		}

		await prisma.clozeIssueReport.delete({ where: { id } })
		return c.json({ ok: true })
	})
