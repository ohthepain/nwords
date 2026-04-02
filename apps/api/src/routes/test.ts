import { zValidator } from "@hono/zod-validator"
import { type TestSession, type VocabMode, prisma } from "@nwords/db"
import {
	FRUSTRATION_WORD_MIN_TESTS,
	KNOWN_CONFIDENCE_THRESHOLD,
	KNOWN_MIN_TESTS,
	updateConfidence,
} from "@nwords/shared"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { computeSynonymFeedback } from "../lib/cloze-synonym-feedback"
import {
	pickRandomWordIdForCloze,
	pickWordNearRank,
	resolveClozeWithHint,
} from "../lib/parallel-hint"
import { lookupUserAnswerPos } from "../lib/pos-lookup"
import type { AuthUser } from "../middleware/auth"
import { type OptionalAuthEnv, optionalAuth } from "../middleware/auth"

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

/**
 * Assessment mode: binary search to find the user's assumed rank.
 *
 * The search range narrows each question. We look at previous answers in
 * this session to compute the current binary search bounds, then pick a
 * word near the midpoint.
 *
 * Stopping: when range < 50 ranks OR 30 questions answered.
 */
const ASSESSMENT_MAX_QUESTIONS = 30
const ASSESSMENT_CONVERGE_THRESHOLD = 50
const ASSESSMENT_INITIAL_LOW = 1
const ASSESSMENT_INITIAL_HIGH = 10000

/** BUILD mode bucket weights (see docs/design/vocab-architecture.md). New 45%, shaky 40%, mood 15%. */
const BUILD_WEIGHT_NEW = 45
const BUILD_WEIGHT_SHAKY = 40
const BUILD_MOOD_MIN_STREAK_WRONG = 2
const BUILD_CANDIDATE_CAP = 45
const BUILD_SESSION_EXCLUSION_SPREAD = 28
/** New-territory picks stay near the first gap (same band as graph, rank-ordered). */
const BUILD_NEW_SPREAD = 8
/** Every Nth build-mode question targets the lowest rank not yet verified known (frontier). */
const BUILD_FRONTIER_EVERY = 10

/**
 * Lemma ids in the practice vocab graph band: same filters and rank order as GET /progress/heatmap,
 * truncated to the first min(total in range, ceil(baseline × 1.2)) rows — matches
 * apps/web/src/components/vocab-graph.tsx `heatmapTargetCellCount` + `cells.slice(0, targetCells)`.
 *
 * Build mode must use this ordinal cap, not `rank <= ceil(baseline × 1.2)` alone; sparse rank
 * numbering can put higher numeric ranks outside the heatmap slice while still below that bound.
 */
async function buildModeGraphVisibleWordIds(
	languageId: string,
	assumedRank: number,
	vocabSize: number,
): Promise<string[]> {
	const baseline = Math.max(assumedRank, vocabSize, 50)
	const targetCellCount = Math.ceil(baseline * 1.2)
	const heatmapWhere = {
		languageId,
		rank: { gte: 1, lte: 10_000 },
		isOffensive: false,
		isAbbreviation: false,
	}
	const total = await prisma.word.count({ where: heatmapWhere })
	const n = Math.min(total, targetCellCount)
	if (n <= 0) return []
	const rows = await prisma.word.findMany({
		where: heatmapWhere,
		orderBy: { rank: "asc" },
		take: n,
		select: { id: true },
	})
	return rows.map((r) => r.id)
}

function rollBuildBucket(eligibleMood: boolean): "new" | "shaky" | "mood" {
	const r = Math.random() * 100
	if (eligibleMood) {
		if (r < BUILD_WEIGHT_NEW) return "new"
		if (r < BUILD_WEIGHT_NEW + BUILD_WEIGHT_SHAKY) return "shaky"
		return "mood"
	}
	const den = BUILD_WEIGHT_NEW + BUILD_WEIGHT_SHAKY
	const newCut = (BUILD_WEIGHT_NEW / den) * 100
	return r < newCut ? "new" : "shaky"
}

function tailConsecutiveWrongs(answersOrderedChronological: { correct: boolean }[]): number {
	let n = 0
	for (let i = answersOrderedChronological.length - 1; i >= 0; i--) {
		if (!answersOrderedChronological[i].correct) n++
		else break
	}
	return n
}

function pickPreferFreshFromOrderedIds(
	orderedIds: string[],
	testedInSession: Set<string>,
	tried: Set<string>,
	options?: { spreadCap?: number; biasTowardHead?: boolean },
): string | null {
	const slice = orderedIds.slice(0, BUILD_CANDIDATE_CAP)
	let pool = slice.filter((id) => !tried.has(id) && !testedInSession.has(id))
	if (pool.length === 0) pool = slice.filter((id) => !tried.has(id))
	if (pool.length === 0) return null
	const cap = options?.spreadCap ?? BUILD_SESSION_EXCLUSION_SPREAD
	const spread = Math.min(cap, pool.length)
	const idx = options?.biasTowardHead
		? Math.min(spread - 1, Math.floor(Math.random() * Math.random() * spread))
		: Math.floor(Math.random() * spread)
	return pool[idx]
}

// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
async function handleAssessmentNext(
	c: Context<any>,
	session: TestSession,
	langs: { nativeLanguageId: string; targetLanguageId: string },
) {
	// Check stopping condition
	if (session.wordsTestedCount >= ASSESSMENT_MAX_QUESTIONS) {
		return c.json({
			done: true,
			message: "Assessment complete — max questions reached.",
			wordsTestedCount: session.wordsTestedCount,
		})
	}

	// Reconstruct binary search bounds from session answers
	const answers = await prisma.testAnswer.findMany({
		where: { testSessionId: session.id },
		orderBy: { answeredAt: "asc" },
		include: {
			// We need the word's rank
		},
	})

	// Fetch ranks for answered words
	const answeredWordIds = answers.map((a) => a.wordId)
	const answeredWords = await prisma.word.findMany({
		where: { id: { in: answeredWordIds } },
		select: { id: true, rank: true },
	})
	const rankMap = new Map(answeredWords.map((w) => [w.id, w.rank]))

	// Binary search: correct answers push low bound up, wrong answers push high bound down
	let low = ASSESSMENT_INITIAL_LOW
	let high = ASSESSMENT_INITIAL_HIGH

	for (const ans of answers) {
		const rank = rankMap.get(ans.wordId)
		if (rank === undefined) continue
		if (ans.correct) {
			// User knows this rank — search higher
			low = Math.max(low, rank + 1)
		} else {
			// User doesn't know this rank — search lower
			high = Math.min(high, rank - 1)
		}
	}

	// Check convergence
	if (high - low < ASSESSMENT_CONVERGE_THRESHOLD) {
		return c.json({
			done: true,
			message: "Assessment complete — level found.",
			wordsTestedCount: session.wordsTestedCount,
			assumedRank: Math.floor((low + high) / 2),
		})
	}

	const targetRank = Math.floor((low + high) / 2)

	// Try to find a word near the midpoint
	const tried = new Set<string>()
	const maxTries = 12

	for (let i = 0; i < maxTries; i++) {
		const pick = await pickWordNearRank(langs.targetLanguageId, targetRank, [...tried])
		if (!pick) break
		tried.add(pick.wordId)

		const resolved = await resolveClozeWithHint({
			wordId: pick.wordId,
			nativeLanguageId: langs.nativeLanguageId,
			targetLanguageId: langs.targetLanguageId,
		})

		if (!resolved.ok) continue

		return c.json({
			wordId: resolved.wordId,
			lemma: resolved.lemma,
			rank: resolved.rank,
			targetSentenceId: resolved.targetSentenceId,
			promptText: resolved.promptText,
			targetSentenceText: resolved.targetSentenceText,
			hintText: resolved.hintText,
			hintSentenceId: resolved.hintSentenceId,
			hintSource: resolved.hintSource,
			inlineHint: resolved.inlineHint,
			answerType: "TRANSLATION_TYPED" as const,
			sessionMode: session.mode,
			vocabMode: "ASSESSMENT" as const,
			assessmentProgress: {
				low,
				high,
				targetRank,
				questionsRemaining: ASSESSMENT_MAX_QUESTIONS - session.wordsTestedCount,
			},
		})
	}

	return c.json(
		{
			error: "no_question_available",
			message: "Could not find a testable word near the target rank.",
		},
		404,
	)
}

/**
 * Frustration mode: pick from words with high test count and low confidence.
 */
// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
async function handleFrustrationNext(
	c: Context<any>,
	session: TestSession,
	langs: { nativeLanguageId: string; targetLanguageId: string },
) {
	if (!session.userId) {
		return c.json({ error: "Frustration mode requires a signed-in user." }, 400)
	}

	// Get the user's frustration words, sorted by frustration score
	const frustrationWords = await prisma.userWordKnowledge.findMany({
		where: {
			userId: session.userId,
			timesTested: { gte: FRUSTRATION_WORD_MIN_TESTS },
			confidence: { lt: 0.5 },
			word: {
				is: {
					languageId: langs.targetLanguageId,
					isAbbreviation: false,
					testSentenceIds: { isEmpty: false },
				},
			},
		},
		orderBy: [{ lastTestedAt: "asc" }, { confidence: "asc" }],
		take: 20,
		select: { wordId: true },
	})

	if (frustrationWords.length === 0) {
		return c.json(
			{
				error: "no_frustration_words",
				message: "No frustration words found. Keep building vocabulary first.",
			},
			404,
		)
	}

	// Get already-tested words in this session to avoid immediate repeats
	const sessionAnswers = await prisma.testAnswer.findMany({
		where: { testSessionId: session.id },
		select: { wordId: true },
	})
	const testedInSession = new Set(sessionAnswers.map((a) => a.wordId))

	// Prefer words not yet tested in this session
	const candidates = frustrationWords.filter((w) => !testedInSession.has(w.wordId))
	const pool = candidates.length > 0 ? candidates : frustrationWords

	// Pick randomly from pool for variety
	const pick = pool[Math.floor(Math.random() * Math.min(pool.length, 10))]

	const resolved = await resolveClozeWithHint({
		wordId: pick.wordId,
		nativeLanguageId: langs.nativeLanguageId,
		targetLanguageId: langs.targetLanguageId,
	})

	if (!resolved.ok) {
		return c.json(
			{
				error: "no_question_available",
				message: "Could not build a cloze for this frustration word.",
			},
			404,
		)
	}

	return c.json({
		wordId: resolved.wordId,
		lemma: resolved.lemma,
		rank: resolved.rank,
		targetSentenceId: resolved.targetSentenceId,
		promptText: resolved.promptText,
		targetSentenceText: resolved.targetSentenceText,
		hintText: resolved.hintText,
		hintSentenceId: resolved.hintSentenceId,
		hintSource: resolved.hintSource,
		inlineHint: resolved.inlineHint,
		answerType: "TRANSLATION_TYPED" as const,
		sessionMode: session.mode,
		vocabMode: "FRUSTRATION" as const,
	})
}

/**
 * BUILD mode: fill gaps in the vocab graph band (first min(corpus, ≈1.2× baseline) lemmas by rank).
 * New territory = first untested words above assumed rank in that band. Shaky = low-rank
 * (common) words first, then lowest confidence — includes holes below the assumed line.
 * Every 10th question, prefer the lowest rank not yet verified known (frontier) to grow territory.
 * Guests keep the legacy rank-window random walk (no profile / knowledge).
 */
// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
async function handleBuildGuestNext(
	c: Context<any>,
	session: TestSession,
	langs: { nativeLanguageId: string; targetLanguageId: string },
	vocabMode: VocabMode,
) {
	const tested = session.wordsTestedCount
	const rankMin = 1
	const rankMax = Math.min(100 + tested * 50, 10000)
	const rankRange = { min: rankMin, max: rankMax }

	const tried = new Set<string>()
	const maxTries = 24

	for (let i = 0; i < maxTries; i++) {
		const wordId = await pickRandomWordIdForCloze(langs.targetLanguageId, [...tried], rankRange)
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
			rank: resolved.rank,
			targetSentenceId: resolved.targetSentenceId,
			promptText: resolved.promptText,
			targetSentenceText: resolved.targetSentenceText,
			hintText: resolved.hintText,
			hintSentenceId: resolved.hintSentenceId,
			hintSource: resolved.hintSource,
			inlineHint: resolved.inlineHint,
			answerType: "TRANSLATION_TYPED" as const,
			sessionMode: session.mode,
			vocabMode,
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
}

// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
async function handleBuildNext(
	c: Context<any>,
	session: TestSession,
	langs: { nativeLanguageId: string; targetLanguageId: string },
	vocabMode: VocabMode,
) {
	if (!session.userId) {
		return handleBuildGuestNext(c, session, langs, vocabMode)
	}

	const [profile, sessionAnswers, knownVerifiedCount] = await Promise.all([
		prisma.userLanguageProfile.findUnique({
			where: {
				userId_languageId: {
					userId: session.userId,
					languageId: langs.targetLanguageId,
				},
			},
		}),
		prisma.testAnswer.findMany({
			where: { testSessionId: session.id },
			orderBy: { answeredAt: "asc" },
			select: { wordId: true, correct: true },
		}),
		prisma.userWordKnowledge.count({
			where: {
				userId: session.userId,
				confidence: { gte: KNOWN_CONFIDENCE_THRESHOLD },
				timesTested: { gte: KNOWN_MIN_TESTS },
				word: {
					is: { languageId: langs.targetLanguageId, isAbbreviation: false },
				},
			},
		}),
	])

	const assumedRank = profile?.assumedRank ?? 0
	const vocabSize = assumedRank + knownVerifiedCount
	const graphVisibleWordIds = await buildModeGraphVisibleWordIds(
		langs.targetLanguageId,
		assumedRank,
		vocabSize,
	)
	if (graphVisibleWordIds.length === 0) {
		return c.json(
			{
				error: "no_question_available",
				message:
					"No vocabulary in the graph range for your level. Complete an assessment or try another mode.",
			},
			404,
		)
	}
	const rankAboveFloor = Math.max(0, assumedRank)

	const testedInSession = new Set(sessionAnswers.map((a) => a.wordId))
	const eligibleMood = tailConsecutiveWrongs(sessionAnswers) >= BUILD_MOOD_MIN_STREAK_WRONG

	const [newWords, shakyKnowledge, moodKnowledge] = await Promise.all([
		prisma.word.findMany({
			where: {
				languageId: langs.targetLanguageId,
				id: { in: graphVisibleWordIds },
				rank: { gt: rankAboveFloor },
				isOffensive: false,
				isAbbreviation: false,
				testSentenceIds: { isEmpty: false },
				NOT: {
					userKnowledge: {
						some: { userId: session.userId },
					},
				},
			},
			orderBy: { rank: "asc" },
			take: BUILD_CANDIDATE_CAP,
			select: { id: true },
		}),
		prisma.userWordKnowledge.findMany({
			where: {
				userId: session.userId,
				NOT: {
					AND: [
						{ confidence: { gte: KNOWN_CONFIDENCE_THRESHOLD } },
						{ timesTested: { gte: KNOWN_MIN_TESTS } },
					],
				},
				word: {
					is: {
						languageId: langs.targetLanguageId,
						id: { in: graphVisibleWordIds },
						rank: { gte: 1 },
						isOffensive: false,
						isAbbreviation: false,
						testSentenceIds: { isEmpty: false },
					},
				},
			},
			orderBy: [{ lastTestedAt: "asc" }, { confidence: "asc" }],
			take: BUILD_CANDIDATE_CAP,
			select: { wordId: true },
		}),
		eligibleMood
			? prisma.userWordKnowledge.findMany({
					where: {
						userId: session.userId,
						confidence: { gte: KNOWN_CONFIDENCE_THRESHOLD },
						timesTested: { gte: KNOWN_MIN_TESTS },
						word: {
							is: {
								languageId: langs.targetLanguageId,
								id: { in: graphVisibleWordIds },
								rank: { gte: 1 },
								isOffensive: false,
								isAbbreviation: false,
								testSentenceIds: { isEmpty: false },
							},
						},
					},
					take: BUILD_CANDIDATE_CAP,
					select: { wordId: true },
				})
			: Promise.resolve([] as { wordId: string }[]),
	])

	const newIds = newWords.map((w) => w.id)
	const shakyIds = shakyKnowledge.map((k) => k.wordId)
	const moodIds = moodKnowledge.map((k) => k.wordId)

	const nextBuildQuestionNumber = sessionAnswers.length + 1
	if (nextBuildQuestionNumber % BUILD_FRONTIER_EVERY === 0) {
		const frontierWord = await prisma.word.findFirst({
			where: {
				languageId: langs.targetLanguageId,
				id: { in: graphVisibleWordIds },
				rank: { gt: rankAboveFloor },
				isOffensive: false,
				isAbbreviation: false,
				testSentenceIds: { isEmpty: false },
				NOT: {
					userKnowledge: {
						some: {
							userId: session.userId,
							confidence: { gte: KNOWN_CONFIDENCE_THRESHOLD },
							timesTested: { gte: KNOWN_MIN_TESTS },
						},
					},
				},
			},
			orderBy: { rank: "asc" },
			select: { id: true },
		})
		if (frontierWord) {
			const resolved = await resolveClozeWithHint({
				wordId: frontierWord.id,
				nativeLanguageId: langs.nativeLanguageId,
				targetLanguageId: langs.targetLanguageId,
			})
			if (resolved.ok) {
				return c.json({
					wordId: resolved.wordId,
					lemma: resolved.lemma,
					rank: resolved.rank,
					targetSentenceId: resolved.targetSentenceId,
					promptText: resolved.promptText,
					targetSentenceText: resolved.targetSentenceText,
					hintText: resolved.hintText,
					hintSentenceId: resolved.hintSentenceId,
					hintSource: resolved.hintSource,
					inlineHint: resolved.inlineHint,
					answerType: "TRANSLATION_TYPED" as const,
					sessionMode: session.mode,
					vocabMode,
				})
			}
		}
	}

	const primaryBucket = rollBuildBucket(eligibleMood)
	const bucketOrder: ("new" | "shaky" | "mood")[] =
		primaryBucket === "new"
			? ["new", "shaky", ...(eligibleMood ? (["mood"] as const) : [])]
			: primaryBucket === "shaky"
				? ["shaky", "new", ...(eligibleMood ? (["mood"] as const) : [])]
				: ["mood", "shaky", "new"]

	const tried = new Set<string>()
	const maxTries = 28

	for (let i = 0; i < maxTries; i++) {
		for (const bucket of bucketOrder) {
			let wordId: string | null = null
			if (bucket === "new") {
				wordId = pickPreferFreshFromOrderedIds(newIds, testedInSession, tried, {
					spreadCap: BUILD_NEW_SPREAD,
					biasTowardHead: true,
				})
			} else if (bucket === "shaky") {
				wordId = pickPreferFreshFromOrderedIds(shakyIds, testedInSession, tried)
			} else if (bucket === "mood" && eligibleMood) {
				wordId = pickPreferFreshFromOrderedIds(moodIds, testedInSession, tried)
			}
			if (!wordId) continue
			tried.add(wordId)

			// #region agent log
			fetch("http://127.0.0.1:7794/ingest/99baccff-1168-49a3-aecb-775311639d96", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a3d0a4" },
				body: JSON.stringify({
					sessionId: "a3d0a4",
					location: "test.ts:handleBuildNext",
					message: "build_pick_word",
					data: { bucket, wordId },
					timestamp: Date.now(),
					hypothesisId: "H3",
				}),
			}).catch(() => {})
			// #endregion

			const resolved = await resolveClozeWithHint({
				wordId,
				nativeLanguageId: langs.nativeLanguageId,
				targetLanguageId: langs.targetLanguageId,
			})

			if (!resolved.ok) continue

			return c.json({
				wordId: resolved.wordId,
				lemma: resolved.lemma,
				rank: resolved.rank,
				targetSentenceId: resolved.targetSentenceId,
				promptText: resolved.promptText,
				targetSentenceText: resolved.targetSentenceText,
				hintText: resolved.hintText,
				hintSentenceId: resolved.hintSentenceId,
				hintSource: resolved.hintSource,
				inlineHint: resolved.inlineHint,
				answerType: "TRANSLATION_TYPED" as const,
				sessionMode: session.mode,
				vocabMode,
			})
		}
	}

	// Last resort: random cloze above assumed rank, still limited to the graph-visible lemma set.
	const triedFallback = new Set(tried)
	const low = rankAboveFloor + 1
	if (low <= 10_000) {
		for (let i = 0; i < 20; i++) {
			const wordId = await pickRandomWordIdForCloze(
				langs.targetLanguageId,
				[...triedFallback],
				{ min: low, max: 10_000 },
				{ restrictToWordIds: graphVisibleWordIds },
			)
			if (!wordId) break
			triedFallback.add(wordId)

			const resolved = await resolveClozeWithHint({
				wordId,
				nativeLanguageId: langs.nativeLanguageId,
				targetLanguageId: langs.targetLanguageId,
			})

			if (!resolved.ok) continue

			return c.json({
				wordId: resolved.wordId,
				lemma: resolved.lemma,
				rank: resolved.rank,
				targetSentenceId: resolved.targetSentenceId,
				promptText: resolved.promptText,
				targetSentenceText: resolved.targetSentenceText,
				hintText: resolved.hintText,
				hintSentenceId: resolved.hintSentenceId,
				hintSource: resolved.hintSource,
				inlineHint: resolved.inlineHint,
				answerType: "TRANSLATION_TYPED" as const,
				sessionMode: session.mode,
				vocabMode,
			})
		}
	}

	return c.json(
		{
			error: "no_question_available",
			message:
				"No build-mode cloze available above your assumed rank. Try Frustration mode or complete an assessment.",
		},
		404,
	)
}

/**
 * Compute the assessed rank from an assessment session's answers.
 * Replays the binary search to find where the user's knowledge boundary is.
 */
async function computeAssessedRank(sessionId: string): Promise<number> {
	const answers = await prisma.testAnswer.findMany({
		where: { testSessionId: sessionId },
		orderBy: { answeredAt: "asc" },
	})

	const answeredWordIds = answers.map((a) => a.wordId)
	const answeredWords = await prisma.word.findMany({
		where: { id: { in: answeredWordIds } },
		select: { id: true, rank: true },
	})
	const rankMap = new Map(answeredWords.map((w) => [w.id, w.rank]))

	let low = ASSESSMENT_INITIAL_LOW
	let high = ASSESSMENT_INITIAL_HIGH

	for (const ans of answers) {
		const rank = rankMap.get(ans.wordId)
		if (rank === undefined) continue
		if (ans.correct) {
			low = Math.max(low, rank + 1)
		} else {
			high = Math.min(high, rank - 1)
		}
	}

	return Math.floor((low + high) / 2)
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
				vocabMode: z.enum(["ASSESSMENT", "BUILD", "FRUSTRATION"]).default("BUILD"),
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
							vocabMode: body.vocabMode,
							nativeLanguageId,
							targetLanguageId,
						},
					})

					return c.json(
						{ sessionId: session.id, mode: body.mode, vocabMode: session.vocabMode },
						201,
					)
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
						vocabMode: body.vocabMode,
					},
				})

				return c.json({ sessionId: session.id, mode: body.mode, vocabMode: session.vocabMode }, 201)
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
					vocabMode: body.vocabMode,
					nativeLanguageId,
					targetLanguageId,
				},
			})

			return c.json({ sessionId: session.id, mode: body.mode, vocabMode: session.vocabMode }, 201)
		},
	)

	// Next cloze item — word selection depends on vocabMode
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
					message:
						"Set native and target language in settings (or restart guest practice with a valid pair).",
				},
				400,
			)
		}

		const vocabMode = session.vocabMode ?? "BUILD"

		// ── Word selection by mode ──────────────────────────────

		if (vocabMode === "ASSESSMENT") {
			return await handleAssessmentNext(c, session, langs)
		}

		if (vocabMode === "FRUSTRATION") {
			return await handleFrustrationNext(c, session, langs)
		}

		return handleBuildNext(c, session, langs, vocabMode)
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

			let confidenceUpdate: { confidence: number; previousConfidence: number | null } | undefined

			if (session.userId && user?.id === session.userId) {
				const now = new Date()
				const vocabMode = session.vocabMode as VocabMode

				// Fetch existing knowledge (null if first encounter with this word)
				const existing = await prisma.userWordKnowledge.findUnique({
					where: {
						userId_wordId: { userId: user.id, wordId: body.wordId },
					},
				})

				const result = updateConfidence(vocabMode, body.correct, {
					confidence: existing?.confidence ?? 0.5,
					timesTested: existing?.timesTested ?? 0,
					lastTestedAt: existing?.lastTestedAt ?? null,
					streak: existing?.streak ?? 0,
					now,
				})

				confidenceUpdate = {
					confidence: result.confidence,
					previousConfidence: existing ? existing.confidence : null,
				}

				if (existing) {
					await prisma.userWordKnowledge.update({
						where: { id: existing.id },
						data: {
							confidence: result.confidence,
							timesTested: { increment: 1 },
							...(body.correct && { timesCorrect: { increment: 1 } }),
							lastTestedAt: now,
							lastCorrect: result.lastCorrect,
							streak: result.streak,
						},
					})
				} else {
					await prisma.userWordKnowledge.create({
						data: {
							userId: user.id,
							wordId: body.wordId,
							confidence: result.confidence,
							timesTested: 1,
							timesCorrect: body.correct ? 1 : 0,
							lastTestedAt: now,
							lastCorrect: result.lastCorrect,
							streak: result.streak,
						},
					})
				}
			}

			// ── Synonym feedback, then POS mismatch (wrong answers only; synonym first) ──
			let synonymFeedback: { kind: "good" | "bad"; message: string } | undefined
			let posMismatch: { guessPos: string; targetPos: string; message: string } | undefined

			if (!body.correct && body.userAnswer) {
				const langs = await resolveClozeLanguageIds(session)
				if (langs) {
					const nativeLang = await prisma.language.findUnique({
						where: { id: langs.nativeLanguageId },
						select: { code: true },
					})
					synonymFeedback = await computeSynonymFeedback({
						userAnswer: body.userAnswer,
						targetWordId: body.wordId,
						targetLanguageId: langs.targetLanguageId,
						nativeLanguageCode: nativeLang?.code ?? "en",
					})

					if (!synonymFeedback) {
						const targetWord = await prisma.word.findUnique({
							where: { id: body.wordId },
							select: { pos: true },
						})

						if (targetWord) {
							const guessResults = await lookupUserAnswerPos(
								body.userAnswer,
								langs.targetLanguageId,
							)

							// Only report a mismatch when ALL matched POS values differ
							// from the target.  If any match, the user plausibly meant the
							// right POS (e.g. "run" is both a noun and a verb).
							const allDifferent =
								guessResults.length > 0 && guessResults.every((g) => g.pos !== targetWord.pos)

							if (allDifferent) {
								const guessPos = guessResults[0].pos // most frequent

								const msg = await prisma.posMismatchMessage.findUnique({
									where: {
										languageId_guessPos_targetPos: {
											languageId: langs.nativeLanguageId,
											guessPos,
											targetPos: targetWord.pos,
										},
									},
									select: { message: true },
								})

								if (msg) {
									posMismatch = {
										guessPos,
										targetPos: targetWord.pos,
										message: msg.message,
									}
								}
							}
						}
					}
				}
			}

			return c.json({
				answerId: answer.id,
				correct: body.correct,
				...confidenceUpdate,
				...(synonymFeedback && { synonymFeedback }),
				...(posMismatch && { posMismatch }),
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
			const langs = await resolveClozeLanguageIds(session)

			// For assessment sessions, compute and save the assumed rank
			if (session.vocabMode === "ASSESSMENT" && langs?.targetLanguageId) {
				const assessedRank = await computeAssessedRank(session.id)

				if (assessedRank > 0) {
					await prisma.userLanguageProfile.upsert({
						where: {
							userId_languageId: {
								userId: user.id,
								languageId: langs.targetLanguageId,
							},
						},
						create: {
							userId: user.id,
							languageId: langs.targetLanguageId,
							assumedRank: assessedRank,
						},
						update: {
							assumedRank: assessedRank,
						},
					})
				}
			}

			const [knownCount, learningCount, profile] = await Promise.all([
				prisma.userWordKnowledge.count({
					where: {
						userId: user.id,
						confidence: { gte: 0.95 },
						timesTested: { gte: 3 },
					},
				}),
				prisma.userWordKnowledge.count({
					where: { userId: user.id, confidence: { gte: 0.5 } },
				}),
				langs?.targetLanguageId
					? prisma.userLanguageProfile.findUnique({
							where: {
								userId_languageId: {
									userId: user.id,
									languageId: langs.targetLanguageId,
								},
							},
						})
					: null,
			])

			const assumedRank = profile?.assumedRank ?? 0
			const vocabSize = assumedRank + knownCount

			await prisma.scoreHistory.create({
				data: {
					userId: user.id,
					actualScore: vocabSize,
					targetScore: assumedRank + learningCount,
					cefrLevel: null,
				},
			})

			return c.json({
				id: ended.id,
				vocabMode: ended.vocabMode,
				wordsTestedCount: ended.wordsTestedCount,
				wordsCorrectCount: ended.wordsCorrectCount,
				endedAt: ended.endedAt?.toISOString(),
				newScore: {
					vocabSize,
					knownWords: knownCount,
					assumedRank,
					learningWords: learningCount,
				},
			})
		}

		return c.json({
			id: ended.id,
			vocabMode: ended.vocabMode,
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

	/** Report a bad cloze (training / debugging). Works for guests; attaches reporter when signed in. */
	.post(
		"/cloze-reports",
		zValidator(
			"json",
			z.object({
				nativeLanguageId: z.string().uuid(),
				targetLanguageId: z.string().uuid(),
				wordId: z.string().uuid(),
				wordLemma: z.string().min(1),
				targetSentenceId: z.string().uuid(),
				targetSentenceText: z.string().min(1),
				promptText: z.string().min(1),
				hintText: z.string().min(1),
				hintSentenceId: z.string().uuid().nullable().optional(),
				hintSource: z.enum(["parallel", "definition"]),
				inlineHint: z.string().nullable().optional(),
				userGuess: z.string().optional(),
			}),
		),
		async (c) => {
			const user = c.get("user")
			const b = c.req.valid("json")

			const [nativeLang, targetLang, word] = await Promise.all([
				prisma.language.findUnique({ where: { id: b.nativeLanguageId } }),
				prisma.language.findUnique({ where: { id: b.targetLanguageId } }),
				prisma.word.findFirst({
					where: { id: b.wordId, languageId: b.targetLanguageId },
				}),
			])

			if (!nativeLang || !targetLang) {
				return c.json({ error: "Language not found" }, 404)
			}
			if (!word) {
				return c.json({ error: "Word not found for target language" }, 404)
			}

			const report = await prisma.clozeIssueReport.create({
				data: {
					reporterUserId: user?.id ?? null,
					nativeLanguageId: b.nativeLanguageId,
					targetLanguageId: b.targetLanguageId,
					wordId: b.wordId,
					targetSentenceId: b.targetSentenceId,
					hintSentenceId: b.hintSentenceId ?? null,
					targetSentenceText: b.targetSentenceText,
					promptText: b.promptText,
					hintText: b.hintText,
					hintSource: b.hintSource,
					inlineHint: b.inlineHint ?? null,
					wordLemma: b.wordLemma,
					userGuess: b.userGuess?.trim() ? b.userGuess.trim() : null,
				},
			})

			return c.json({ id: report.id }, 201)
		},
	)

	/** Withdraw a cloze report (reporter only when logged in; guest reports by id). */
	.delete("/cloze-reports/:id", async (c) => {
		const user = c.get("user")
		const id = c.req.param("id")

		const report = await prisma.clozeIssueReport.findUnique({
			where: { id },
			select: { id: true, reporterUserId: true },
		})
		if (!report) {
			return c.json({ error: "Report not found" }, 404)
		}

		if (report.reporterUserId) {
			if (!user || user.id !== report.reporterUserId) {
				return c.json({ error: "You can only withdraw your own report" }, 403)
			}
		}

		await prisma.clozeIssueReport.delete({ where: { id } })
		return c.body(null, 204)
	})
