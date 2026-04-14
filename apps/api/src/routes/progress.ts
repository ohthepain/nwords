import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { dedupeByEffectiveRank, getCefrLevel } from "@nwords/shared"
import { Hono } from "hono"
import { z } from "zod"
import { authMiddleware } from "../middleware/auth"

export const progressRoute = new Hono()
	.use("*", authMiddleware)

	// Get current scores and CEFR level
	.get("/current", async (c) => {
		const user = c.get("user")

		const latestScore = await prisma.scoreHistory.findFirst({
			where: { userId: user.id },
			orderBy: { recordedAt: "desc" },
		})

		if (!latestScore) {
			return c.json({
				actualScore: 0,
				targetScore: 0,
				cefrLevel: null,
				wordsToVerify: 0,
			})
		}

		return c.json({
			actualScore: latestScore.actualScore,
			targetScore: latestScore.targetScore,
			cefrLevel: getCefrLevel(latestScore.actualScore),
			wordsToVerify: latestScore.targetScore - latestScore.actualScore,
		})
	})

	// Get score history over time
	.get(
		"/history",
		zValidator(
			"query",
			z.object({
				days: z.coerce.number().min(1).max(365).default(30),
			}),
		),
		async (c) => {
			const user = c.get("user")
			const { days } = c.req.valid("query")

			const since = new Date()
			since.setDate(since.getDate() - days)

			const scores = await prisma.scoreHistory.findMany({
				where: {
					userId: user.id,
					recordedAt: { gte: since },
				},
				orderBy: { recordedAt: "asc" },
			})

			return c.json({
				scores: scores.map((s) => ({
					actualScore: s.actualScore,
					targetScore: s.targetScore,
					cefrLevel: s.cefrLevel,
					recordedAt: s.recordedAt.toISOString(),
				})),
			})
		},
	)

	// Get vocabulary knowledge summary for a user
	.get("/knowledge-summary", async (c) => {
		const user = c.get("user")

		const dbUser = await prisma.user.findUnique({
			where: { id: user.id },
			select: { targetLanguageId: true },
		})

		if (!dbUser?.targetLanguageId) {
			return c.json({ error: "No target language set" }, 400)
		}

		const [knownCount, totalTested, uncertainWords, profile] = await Promise.all([
			// Derived "known": high confidence + enough tests
			prisma.userWordKnowledge.count({
				where: {
					userId: user.id,
					confidence: { gte: 0.95 },
					timesTested: { gte: 3 },
				},
			}),
			prisma.userWordKnowledge.count({
				where: { userId: user.id },
			}),
			prisma.userWordKnowledge.count({
				where: {
					userId: user.id,
					confidence: { gte: 0.3, lte: 0.7 },
				},
			}),
			prisma.userLanguageProfile.findUnique({
				where: {
					userId_languageId: {
						userId: user.id,
						languageId: dbUser.targetLanguageId,
					},
				},
			}),
		])

		const assumedRank = profile?.assumedRank ?? 0

		return c.json({
			vocabSize: assumedRank + knownCount,
			knownWords: knownCount,
			assumedRank,
			totalTested,
			uncertainWords,
			targetLanguageId: dbUser.targetLanguageId,
		})
	})

	// Get the heatmap data — knowledge state for words ranked 1-10000
	.get(
		"/heatmap",
		zValidator(
			"query",
			z.object({
				from: z.coerce.number().min(1).default(1),
				to: z.coerce.number().min(1).max(10000).default(1000),
				languageId: z.string().uuid().optional(),
				/** When `"1"`, cells include `knowledgeDebug` (extra `UserWordKnowledge` fields) for admin tooling. */
				dev: z.enum(["1"]).optional(),
			}),
		),
		async (c) => {
			const user = c.get("user")
			const { from, to, languageId: languageIdParam, dev } = c.req.valid("query")
			const includeDev = dev === "1"

			const dbUser = await prisma.user.findUnique({
				where: { id: user.id },
				select: { targetLanguageId: true },
			})

			const languageId = languageIdParam ?? dbUser?.targetLanguageId
			if (!languageId) {
				return c.json({ error: "No target language set" }, 400)
			}

			// Get words in the rank range (one row per frequency slot — same lemma may exist on multiple POS rows)
			const wordsRaw = await prisma.word.findMany({
				where: {
					languageId,
					effectiveRank: { gte: from, lte: to },
					isOffensive: false,
					isAbbreviation: false,
				},
				orderBy: [{ effectiveRank: "asc" }, { id: "asc" }],
				select: { id: true, effectiveRank: true, lemma: true },
			})
			const words = dedupeByEffectiveRank(wordsRaw)

			// Get user knowledge for these words
			const wordIds = words.map((w) => w.id)
			const knowledge = await prisma.userWordKnowledge.findMany({
				where: {
					userId: user.id,
					wordId: { in: wordIds },
				},
				select: includeDev
					? {
							id: true,
							wordId: true,
							confidence: true,
							timesTested: true,
							timesCorrect: true,
							lastTestedAt: true,
							lastCorrect: true,
							streak: true,
							createdAt: true,
							updatedAt: true,
						}
					: {
							wordId: true,
							confidence: true,
							timesTested: true,
							timesCorrect: true,
						},
			})

			const knowledgeMap = new Map(knowledge.map((k) => [k.wordId, k]))

			// Get assumed rank to mark words below it as "assumed known"
			const [profile, knownWordsInLanguage] = await Promise.all([
				prisma.userLanguageProfile.findUnique({
					where: {
						userId_languageId: {
							userId: user.id,
							languageId,
						},
					},
				}),
				prisma.userWordKnowledge.count({
					where: {
						userId: user.id,
						confidence: { gte: 0.95 },
						timesTested: { gte: 3 },
						word: { is: { languageId, isAbbreviation: false } },
					},
				}),
			])
			const assumedRank = profile?.assumedRank ?? 0
			const vocabSize = assumedRank + knownWordsInLanguage

			const cells = words.map((w) => {
				const k = knowledgeMap.get(w.id)
				const isKnown = k && k.confidence >= 0.95 && k.timesTested >= 3
				const isAssumedKnown = w.effectiveRank <= assumedRank

				let status: string
				if (isKnown || isAssumedKnown) {
					status = "known"
				} else if (k) {
					status = "learning"
				} else {
					status = "untested"
				}

				const base = {
					wordId: w.id,
					rank: w.effectiveRank,
					lemma: w.lemma,
					status,
					confidence: k?.confidence ?? (isAssumedKnown ? 1.0 : null),
					timesTested: k?.timesTested ?? 0,
					timesCorrect: k?.timesCorrect ?? 0,
				}
				if (!includeDev) return base
				if (!k) {
					return { ...base, knowledgeDebug: null }
				}
				const dk = k as typeof k & {
					id: string
					lastTestedAt: Date | null
					lastCorrect: boolean
					streak: number
					createdAt: Date
					updatedAt: Date
				}
				return {
					...base,
					knowledgeDebug: {
						rowId: dk.id,
						lastTestedAt: dk.lastTestedAt?.toISOString() ?? null,
						lastCorrect: dk.lastCorrect,
						streak: dk.streak,
						createdAt: dk.createdAt.toISOString(),
						updatedAt: dk.updatedAt.toISOString(),
					},
				}
			})

			return c.json({
				from,
				to,
				languageId,
				assumedRank,
				knownWords: knownWordsInLanguage,
				vocabSize,
				cells,
			})
		},
	)
