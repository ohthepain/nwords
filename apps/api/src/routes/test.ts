import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { prisma } from "@nwords/db"
import { authMiddleware } from "../middleware/auth.ts"

export const testRoute = new Hono()
	.use("*", authMiddleware)

	// Start a new test session
	.post(
		"/sessions",
		zValidator(
			"json",
			z.object({
				mode: z.enum(["MULTIPLE_CHOICE", "TRANSLATION", "VOICE", "MIXED"]),
			}),
		),
		async (c) => {
			const user = c.get("user")
			const { mode } = c.req.valid("json")

			const dbUser = await prisma.user.findUnique({
				where: { id: user.id },
				select: { targetLanguageId: true },
			})

			if (!dbUser?.targetLanguageId) {
				return c.json({ error: "No target language set" }, 400)
			}

			const session = await prisma.testSession.create({
				data: {
					userId: user.id,
					mode,
				},
			})

			return c.json({ sessionId: session.id, mode }, 201)
		},
	)

	// Get an active test session
	.get("/sessions/:id", async (c) => {
		const user = c.get("user")
		const { id } = c.req.param()

		const session = await prisma.testSession.findFirst({
			where: { id, userId: user.id },
			include: {
				answers: {
					orderBy: { answeredAt: "desc" },
					take: 10,
				},
			},
		})

		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}

		return c.json({
			id: session.id,
			mode: session.mode,
			startedAt: session.startedAt.toISOString(),
			endedAt: session.endedAt?.toISOString() ?? null,
			wordsTestedCount: session.wordsTestedCount,
			wordsCorrectCount: session.wordsCorrectCount,
			recentAnswers: session.answers.map((a) => ({
				id: a.id,
				wordId: a.wordId,
				correct: a.correct,
				wasTypo: a.wasTypo,
				answerType: a.answerType,
				answeredAt: a.answeredAt.toISOString(),
			})),
		})
	})

	// Submit an answer
	.post(
		"/sessions/:id/answer",
		zValidator(
			"json",
			z.object({
				wordId: z.string().uuid(),
				sentenceId: z.string().uuid().optional(),
				answerType: z.enum(["MULTIPLE_CHOICE", "TRANSLATION_TYPED", "VOICE_TRANSCRIPTION"]),
				userAnswer: z.string().optional(),
				correct: z.boolean(),
				wasTypo: z.boolean().default(false),
				timeTakenMs: z.number().int().positive().optional(),
			}),
		),
		async (c) => {
			const user = c.get("user")
			const { id } = c.req.param()
			const body = c.req.valid("json")

			// Verify session belongs to user and is active
			const session = await prisma.testSession.findFirst({
				where: { id, userId: user.id, endedAt: null },
			})

			if (!session) {
				return c.json({ error: "Session not found or already ended" }, 404)
			}

			// Create the answer and update session counts in a transaction
			const [answer] = await prisma.$transaction([
				prisma.testAnswer.create({
					data: {
						testSessionId: id,
						wordId: body.wordId,
						sentenceId: body.sentenceId,
						answerType: body.answerType,
						userAnswer: body.userAnswer,
						correct: body.correct,
						wasTypo: body.wasTypo,
						timeTakenMs: body.timeTakenMs,
					},
				}),
				prisma.testSession.update({
					where: { id },
					data: {
						wordsTestedCount: { increment: 1 },
						...(body.correct && { wordsCorrectCount: { increment: 1 } }),
					},
				}),
			])

			// Update user word knowledge
			await prisma.userWordKnowledge.upsert({
				where: {
					userId_wordId: {
						userId: user.id,
						wordId: body.wordId,
					},
				},
				create: {
					userId: user.id,
					wordId: body.wordId,
					known: body.correct,
					probability: body.correct ? 0.8 : 0.2,
					timesTested: 1,
					timesCorrect: body.correct ? 1 : 0,
					lastTestedAt: new Date(),
				},
				update: {
					timesTested: { increment: 1 },
					...(body.correct && { timesCorrect: { increment: 1 } }),
					lastTestedAt: new Date(),
					// Bayesian-ish probability update
					probability: body.correct
						? { multiply: 1.0 } // Will be recalculated below
						: { multiply: 1.0 },
				},
			})

			// Recalculate probability based on accuracy
			const knowledge = await prisma.userWordKnowledge.findUnique({
				where: {
					userId_wordId: {
						userId: user.id,
						wordId: body.wordId,
					},
				},
			})

			if (knowledge && knowledge.timesTested > 0) {
				const accuracy = knowledge.timesCorrect / knowledge.timesTested
				const newProbability = Math.max(0.05, Math.min(0.95, accuracy))
				const isKnown = newProbability >= 0.95 && knowledge.timesTested >= 3

				await prisma.userWordKnowledge.update({
					where: { id: knowledge.id },
					data: {
						probability: newProbability,
						known: isKnown,
					},
				})
			}

			return c.json({
				answerId: answer.id,
				correct: body.correct,
			})
		},
	)

	// End a test session
	.post("/sessions/:id/end", async (c) => {
		const user = c.get("user")
		const { id } = c.req.param()

		const session = await prisma.testSession.findFirst({
			where: { id, userId: user.id, endedAt: null },
		})

		if (!session) {
			return c.json({ error: "Session not found or already ended" }, 404)
		}

		const ended = await prisma.testSession.update({
			where: { id },
			data: { endedAt: new Date() },
		})

		// Record a score snapshot
		const knownCount = await prisma.userWordKnowledge.count({
			where: { userId: user.id, known: true },
		})
		const targetCount = await prisma.userWordKnowledge.count({
			where: { userId: user.id, probability: { gte: 0.5 } },
		})

		await prisma.scoreHistory.create({
			data: {
				userId: user.id,
				actualScore: knownCount,
				targetScore: targetCount,
				cefrLevel: null, // Will be set by the scorer
			},
		})

		return c.json({
			id: ended.id,
			wordsTestedCount: ended.wordsTestedCount,
			wordsCorrectCount: ended.wordsCorrectCount,
			endedAt: ended.endedAt?.toISOString(),
			newScore: {
				actualScore: knownCount,
				targetScore: targetCount,
			},
		})
	})

	// Get recent test sessions
	.get("/sessions", async (c) => {
		const user = c.get("user")

		const sessions = await prisma.testSession.findMany({
			where: { userId: user.id },
			orderBy: { startedAt: "desc" },
			take: 20,
		})

		return c.json({
			sessions: sessions.map((s) => ({
				id: s.id,
				mode: s.mode,
				startedAt: s.startedAt.toISOString(),
				endedAt: s.endedAt?.toISOString() ?? null,
				wordsTestedCount: s.wordsTestedCount,
				wordsCorrectCount: s.wordsCorrectCount,
			})),
		})
	})
