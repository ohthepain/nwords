import { zValidator } from "@hono/zod-validator"
import { prisma, type TestSession } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { pickRandomWordIdForCloze, resolveClozeWithHint } from "../lib/parallel-hint"
import type { AuthUser } from "../middleware/auth"
import { optionalAuth, type OptionalAuthEnv } from "../middleware/auth"

async function getSessionIfAllowed(
	sessionId: string,
	user: AuthUser | undefined,
	options: { requireActive?: boolean },
): Promise<TestSession | null> {
	const session = await prisma.testSession.findFirst({
		where: {
			id: sessionId,
			...(options.requireActive ? { endedAt: null } : {}),
		},
	})
	if (!session) return null
	if (session.userId) {
		if (!user || user.id !== session.userId) return null
	}
	return session
}

async function resolveClozeLanguageIds(
	session: TestSession,
): Promise<{ nativeLanguageId: string; targetLanguageId: string } | null> {
	if (session.nativeLanguageId && session.targetLanguageId) {
		return {
			nativeLanguageId: session.nativeLanguageId,
			targetLanguageId: session.targetLanguageId,
		}
	}
	if (session.userId) {
		const dbUser = await prisma.user.findUnique({
			where: { id: session.userId },
			select: { nativeLanguageId: true, targetLanguageId: true },
		})
		if (!dbUser?.nativeLanguageId || !dbUser.targetLanguageId) return null
		return { nativeLanguageId: dbUser.nativeLanguageId, targetLanguageId: dbUser.targetLanguageId }
	}
	return null
}

export const testRoute = new Hono<OptionalAuthEnv>()
	.use("*", optionalAuth)

	// Start a new test session
	.post(
		"/sessions",
		zValidator(
			"json",
			z.object({
				mode: z.enum(["MULTIPLE_CHOICE", "TRANSLATION", "VOICE", "MIXED"]),
				nativeLanguageId: z.string().uuid().optional(),
				targetLanguageId: z.string().uuid().optional(),
			}),
		),
		async (c) => {
			const user = c.get("user")
			const body = c.req.valid("json")

			if (user) {
				const { nativeLanguageId, targetLanguageId } = body
				const hasPair = !!(nativeLanguageId && targetLanguageId)
				const hasOne = !!(nativeLanguageId || targetLanguageId)
				if (hasOne && !hasPair) {
					return c.json(
						{ error: "Provide both nativeLanguageId and targetLanguageId for a practice pair." },
						400,
					)
				}

				if (hasPair) {
					if (nativeLanguageId === targetLanguageId) {
						return c.json({ error: "Native and target languages must be different" }, 400)
					}

					const [nativeLang, targetLang] = await Promise.all([
						prisma.language.findUnique({ where: { id: nativeLanguageId } }),
						prisma.language.findUnique({ where: { id: targetLanguageId } }),
					])

					if (!nativeLang) {
						return c.json({ error: "Native language not found" }, 404)
					}
					if (!targetLang?.enabled) {
						return c.json({ error: "Target language is not available" }, 400)
					}

					const session = await prisma.testSession.create({
						data: {
							userId: user.id,
							mode: body.mode,
							nativeLanguageId,
							targetLanguageId,
						},
					})

					return c.json({ sessionId: session.id, mode: body.mode }, 201)
				}

				const dbUser = await prisma.user.findUnique({
					where: { id: user.id },
					select: { nativeLanguageId: true, targetLanguageId: true },
				})

				if (!dbUser?.nativeLanguageId || !dbUser.targetLanguageId) {
					return c.json(
						{
							error: "languages_required",
							message:
								"Set native and target language in settings, or pass nativeLanguageId and targetLanguageId.",
						},
						400,
					)
				}

				const session = await prisma.testSession.create({
					data: {
						userId: user.id,
						mode: body.mode,
					},
				})

				return c.json({ sessionId: session.id, mode: body.mode }, 201)
			}

			const { nativeLanguageId, targetLanguageId } = body
			if (!nativeLanguageId || !targetLanguageId) {
				return c.json(
					{
						error: "guest_languages_required",
						message: "Sign in or provide nativeLanguageId and targetLanguageId.",
					},
					400,
				)
			}

			if (nativeLanguageId === targetLanguageId) {
				return c.json({ error: "Native and target languages must be different" }, 400)
			}

			const [nativeLang, targetLang] = await Promise.all([
				prisma.language.findUnique({ where: { id: nativeLanguageId } }),
				prisma.language.findUnique({ where: { id: targetLanguageId } }),
			])

			if (!nativeLang) {
				return c.json({ error: "Native language not found" }, 404)
			}
			if (!targetLang?.enabled) {
				return c.json({ error: "Target language is not available" }, 400)
			}

			const session = await prisma.testSession.create({
				data: {
					mode: body.mode,
					nativeLanguageId,
					targetLanguageId,
				},
			})

			return c.json({ sessionId: session.id, mode: body.mode }, 201)
		},
	)

	// Next cloze item with native-language hint (or definition fallback)
	.get("/sessions/:id/next", async (c) => {
		const user = c.get("user")
		const { id: sessionId } = c.req.param()

		const session = await getSessionIfAllowed(sessionId, user, { requireActive: true })

		if (!session) {
			return c.json({ error: "Session not found or already ended" }, 404)
		}

		if (session.mode !== "TRANSLATION" && session.mode !== "MIXED") {
			return c.json(
				{
					error: "unsupported_session_mode",
					message: "Next cloze is only available for TRANSLATION or MIXED sessions.",
				},
				400,
			)
		}

		const langs = await resolveClozeLanguageIds(session)

		if (!langs) {
			return c.json(
				{
					error: "languages_required",
					message: "Set native and target language in settings (or restart guest practice with a valid pair).",
				},
				400,
			)
		}

		const tried = new Set<string>()
		const maxTries = 24

		for (let i = 0; i < maxTries; i++) {
			const wordId = await pickRandomWordIdForCloze(langs.targetLanguageId, [...tried])
			if (!wordId) break
			tried.add(wordId)

			const resolved = await resolveClozeWithHint({
				wordId,
				nativeLanguageId: langs.nativeLanguageId,
				targetLanguageId: langs.targetLanguageId,
			})

			if (!resolved.ok) continue

			return c.json({
				wordId: resolved.wordId,
				lemma: resolved.lemma,
				targetSentenceId: resolved.targetSentenceId,
				promptText: resolved.promptText,
				targetSentenceText: resolved.targetSentenceText,
				hintText: resolved.hintText,
				hintSentenceId: resolved.hintSentenceId,
				hintSource: resolved.hintSource,
				inlineHint: resolved.inlineHint,
				answerType: "TRANSLATION_TYPED" as const,
				sessionMode: session.mode,
			})
		}

		return c.json(
			{
				error: "no_question_available",
				message:
					"No cloze item with a hint could be built. Add parallel translations (Tatoeba links) or ensure words have dictionary glosses.",
			},
			404,
		)
	})

	// Get an active test session
	.get("/sessions/:id", async (c) => {
		const user = c.get("user")
		const { id } = c.req.param()

		const session = await getSessionIfAllowed(id, user, {})

		if (!session) {
			return c.json({ error: "Session not found" }, 404)
		}

		const full = await prisma.testSession.findFirst({
			where: { id },
			include: {
				answers: {
					orderBy: { answeredAt: "desc" },
					take: 10,
				},
			},
		})

		if (!full) {
			return c.json({ error: "Session not found" }, 404)
		}

		return c.json({
			id: full.id,
			mode: full.mode,
			startedAt: full.startedAt.toISOString(),
			endedAt: full.endedAt?.toISOString() ?? null,
			wordsTestedCount: full.wordsTestedCount,
			wordsCorrectCount: full.wordsCorrectCount,
			recentAnswers: full.answers.map((a) => ({
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

			const session = await getSessionIfAllowed(id, user, { requireActive: true })

			if (!session) {
				return c.json({ error: "Session not found or already ended" }, 404)
			}

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

			if (session.userId && user?.id === session.userId) {
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
						probability: body.correct ? { multiply: 1.0 } : { multiply: 1.0 },
					},
				})

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

		const session = await getSessionIfAllowed(id, user, { requireActive: true })

		if (!session) {
			return c.json({ error: "Session not found or already ended" }, 404)
		}

		const ended = await prisma.testSession.update({
			where: { id },
			data: { endedAt: new Date() },
		})

		if (session.userId && user?.id === session.userId) {
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
					cefrLevel: null,
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
		}

		return c.json({
			id: ended.id,
			wordsTestedCount: ended.wordsTestedCount,
			wordsCorrectCount: ended.wordsCorrectCount,
			endedAt: ended.endedAt?.toISOString(),
			newScore: null,
		})
	})

	// Get recent test sessions
	.get("/sessions", async (c) => {
		const user = c.get("user")

		if (!user) {
			return c.json({ error: "Unauthorized" }, 401)
		}

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
