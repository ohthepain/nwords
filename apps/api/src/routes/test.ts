import { zValidator } from "@hono/zod-validator"
import { Prisma, type TestSession, type VocabMode, prisma } from "@nwords/db"
import type { VocabBuildSettings } from "@nwords/shared"
import {
	FRUSTRATION_WORD_MIN_TESTS,
	KNOWN_CONFIDENCE_THRESHOLD,
	KNOWN_MIN_TESTS,
	checkFixedExpression,
	collectFirstNUniqueEffectiveRanks,
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
import { resolveVocabBuildSettings } from "../lib/vocab-build-settings"
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

export type DevSelectionPanelTab = "territory" | "new" | "shaky" | "mood"

export type DevSelection = {
	vocabMode: VocabMode
	kind:
		| "territory_opening"
		| "territory_revisit"
		| "weighted_buckets"
		| "new"
		| "shaky"
		| "mood"
		| "column_focus"
		| "fallback"
		| "guest_random"
		| "forced_sentence"
		| "assessment_binary_search"
		| "frustration"
		| "new_words"
	panelTab: DevSelectionPanelTab | null
	summary: string
	/** BUILD bucket pass only: which bucket was rolled first. */
	primaryBucket?: "new" | "shaky" | "mood"
	/** BUILD bucket pass only: order buckets are tried this question. */
	bucketOrder?: ("new" | "shaky" | "mood")[]
}

const COLUMN_FOCUS_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseColumnFocusWordIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return []
	const out: string[] = []
	for (const x of raw) {
		if (typeof x !== "string" || !COLUMN_FOCUS_UUID_RE.test(x)) continue
		out.push(x)
	}
	return out
}

function devSelection(
	vocabMode: VocabMode,
	kind: DevSelection["kind"],
	summary: string,
): DevSelection {
	const panelTab: DevSelectionPanelTab | null =
		kind === "territory_opening" || kind === "territory_revisit"
			? "territory"
			: kind === "new"
				? "new"
				: kind === "shaky"
					? "shaky"
					: kind === "mood"
						? "mood"
						: kind === "column_focus"
							? "new"
							: null
	return { vocabMode, kind, panelTab, summary }
}

/** Mirrors the deterministic branch order in `handleBuildNext` (before weighted buckets). */
function buildNextPickPreview(args: {
	nextBuildQuestionNumber: number
	territoryCount: number
	eligibleMood: boolean
	build: VocabBuildSettings
}): Pick<DevSelection, "kind" | "panelTab" | "summary"> & {
	bucketWeights: { new: number; shaky: number; mood: number } | null
} {
	const { nextBuildQuestionNumber: q, territoryCount, eligibleMood, build: b } = args
	const hasTerritory = territoryCount > 0

	if (b.territoryOpening > 0 && q > 1 && q <= b.territoryOpening && hasTerritory) {
		const sel = devSelection(
			"BUILD",
			"territory_opening",
			`Q${q}: territory opening (questions 2–${b.territoryOpening}; active before new)`,
		)
		return { kind: sel.kind, panelTab: sel.panelTab, summary: sel.summary, bucketWeights: null }
	}

	if (
		b.territoryOpening > 0 &&
		q > b.territoryOpening &&
		hasTerritory &&
		b.territoryRevisitEvery > 0 &&
		q % b.territoryRevisitEvery === 0
	) {
		const sel = devSelection(
			"BUILD",
			"territory_revisit",
			`Q${q}: territory revisit (every ${b.territoryRevisitEvery} after Q${b.territoryOpening})`,
		)
		return { kind: sel.kind, panelTab: sel.panelTab, summary: sel.summary, bucketWeights: null }
	}

	const wMood = eligibleMood ? Math.max(0, 100 - b.weightNew - b.weightShaky) : 0
	const summary = eligibleMood
		? `Q${q}: weighted buckets — primary order rolls new ${b.weightNew}%, shaky ${b.weightShaky}%, mood ${wMood}%, then tries fallbacks in that order`
		: `Q${q}: weighted buckets — rolls new vs shaky (${b.weightNew}% / ${b.weightShaky}%), then alternates`

	const den = b.weightNew + b.weightShaky
	const newPct = den > 0 ? Math.round((b.weightNew / den) * 100) : 50
	const shakyPct = den > 0 ? Math.round((b.weightShaky / den) * 100) : 50

	return {
		kind: "weighted_buckets",
		panelTab: null,
		summary,
		bucketWeights: eligibleMood
			? { new: b.weightNew, shaky: b.weightShaky, mood: wMood }
			: {
					new: newPct,
					shaky: shakyPct,
					mood: 0,
				},
	}
}

/**
 * Lemma ids in the practice vocab graph band: same filters and rank order as GET /progress/heatmap,
 * truncated to the first min(total in range, ceil(baseline × 1.2)) rows — matches
 * apps/web/src/components/vocab-graph.tsx `heatmapTargetCellCount` + `cells.slice(0, targetCells)`.
 *
 * Build mode must use this ordinal cap, not `rank <= ceil(baseline × 1.2)` alone; sparse rank
 * numbering can put higher numeric ranks outside the heatmap slice while still below that bound.
 *
 * Uses one word id per `effectiveRank` (same lemma can exist on multiple POS rows at the same rank).
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
		effectiveRank: { gte: 1, lte: 10_000 },
		isOffensive: false,
		isAbbreviation: false,
	}
	const total = await prisma.word.count({ where: heatmapWhere })
	const n = Math.min(total, targetCellCount)
	if (n <= 0) return []
	const rows = await collectFirstNUniqueEffectiveRanks(n, (skip, take) =>
		prisma.word.findMany({
			where: heatmapWhere,
			orderBy: [{ effectiveRank: "asc" }, { id: "asc" }],
			skip,
			take,
			select: { id: true, effectiveRank: true },
		}),
	)
	return rows.map((r) => r.id)
}

function rollBuildBucket(eligibleMood: boolean, b: VocabBuildSettings): "new" | "shaky" | "mood" {
	const r = Math.random() * 100
	if (eligibleMood) {
		if (r < b.weightNew) return "new"
		if (r < b.weightNew + b.weightShaky) return "shaky"
		return "mood"
	}
	const den = b.weightNew + b.weightShaky
	if (den <= 0) return "new"
	const newCut = (b.weightNew / den) * 100
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
	b: VocabBuildSettings,
	options?: { spreadCap?: number; biasTowardHead?: boolean; sliceCap?: number },
): string | null {
	const sliceCap = options?.sliceCap ?? b.candidateCap
	const slice = orderedIds.slice(0, sliceCap)
	let pool = slice.filter((id) => !tried.has(id) && !testedInSession.has(id))
	if (pool.length === 0) pool = slice.filter((id) => !tried.has(id))
	if (pool.length === 0) return null
	const cap = options?.spreadCap ?? b.sessionExclusionSpread
	const spread = Math.min(cap, pool.length)
	const idx = options?.biasTowardHead
		? Math.min(spread - 1, Math.floor(Math.random() * Math.random() * spread))
		: Math.floor(Math.random() * spread)
	return pool[idx]
}

function territoryMisses(row: {
	userKnowledge: { timesTested: number; timesCorrect: number }[]
}): number {
	const k = row.userKnowledge[0]
	if (!k) return 0
	return Math.max(0, k.timesTested - k.timesCorrect)
}

function sortBuildTerritoryRows<
	T extends {
		id: string
		effectiveRank: number
		userKnowledge: { timesTested: number; timesCorrect: number }[]
	},
>(rows: T[]): T[] {
	return [...rows].sort((a, b) => {
		if (a.effectiveRank !== b.effectiveRank) return a.effectiveRank - b.effectiveRank
		return territoryMisses(a) - territoryMisses(b)
	})
}

/**
 * Territory candidates: rank-ordered within “active” (has a knowledge row, not verified known) then
 * within “frontier-only” (no row yet), so consolidation is preferred over new introductions.
 */
function territoryIdsPreferActive<
	T extends {
		id: string
		effectiveRank: number
		userKnowledge: { timesTested: number; timesCorrect: number }[]
	},
>(
	territoryRowsSorted: T[],
	heavyMissThreshold: number,
): { orderedIds: string[]; winnableIds: string[] } {
	const active = territoryRowsSorted.filter((r) => r.userKnowledge.length > 0)
	const frontierOnly = territoryRowsSorted.filter((r) => r.userKnowledge.length === 0)
	const merged = [...active, ...frontierOnly]
	const orderedIds = merged.map((r) => r.id)
	const winnable = merged.filter((r) => territoryMisses(r) < heavyMissThreshold).map((r) => r.id)
	return {
		orderedIds,
		winnableIds: winnable.length > 0 ? winnable : orderedIds,
	}
}

/** Several attempts: territory list is rank-ordered but some lemmas may fail cloze resolution. */
async function tryResolveBuildTerritoryPick(
	orderedIds: string[],
	testedInSession: Set<string>,
	spreadCap: number,
	langs: { nativeLanguageId: string; targetLanguageId: string },
	b: VocabBuildSettings,
) {
	const localTried = new Set<string>()
	for (let a = 0; a < 16; a++) {
		const wordId = pickPreferFreshFromOrderedIds(orderedIds, testedInSession, localTried, b, {
			spreadCap,
			biasTowardHead: true,
		})
		if (!wordId) return null
		localTried.add(wordId)
		const resolved = await resolveClozeWithHint({
			wordId,
			nativeLanguageId: langs.nativeLanguageId,
			targetLanguageId: langs.targetLanguageId,
		})
		if (resolved.ok) return resolved
	}
	return null
}

async function handleAssessmentNext(
	// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
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
		select: { id: true, effectiveRank: true },
	})
	const rankMap = new Map(answeredWords.map((w) => [w.id, w.effectiveRank]))

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
			devSelection: devSelection(
				"ASSESSMENT",
				"assessment_binary_search",
				`Assessment: binary search midpoint rank ${targetRank} (bounds ${low}–${high})`,
			),
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
async function handleFrustrationNext(
	// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
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
		devSelection: devSelection(
			"FRUSTRATION",
			"frustration",
			"Frustration: high test count, low confidence, stale last tested",
		),
	})
}

/**
 * NEWWORDS: only the session’s ordered `columnFocusWordIds` list (heatmap column, etc.).
 * Prefers lemmas not yet answered this session, then cycles by **least-recently answered in this
 * session** (column order tiebreak) so repeats do not stick on the list head. Same cloze stack as Build.
 */
async function handleNewWordsNext(
	// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
	c: Context<any>,
	session: TestSession,
	langs: { nativeLanguageId: string; targetLanguageId: string },
) {
	const sessionAnswers = await prisma.testAnswer.findMany({
		where: { testSessionId: session.id },
		orderBy: { answeredAt: "asc" },
		select: { wordId: true, answeredAt: true },
	})
	const testedInSession = new Set(sessionAnswers.map((a) => a.wordId))
	const ordered = parseColumnFocusWordIds(session.columnFocusWordIds)
	if (ordered.length === 0) {
		return c.json(
			{
				error: "no_question_available",
				message:
					"This New words session has no word list. End it and start again from the Build heatmap.",
			},
			404,
		)
	}

	const untested = ordered.filter((id) => !testedInSession.has(id))
	const tested = ordered.filter((id) => testedInSession.has(id))
	const lastAnswerAtByWord = new Map<string, number>()
	for (const a of sessionAnswers) {
		lastAnswerAtByWord.set(a.wordId, a.answeredAt.getTime())
	}
	const testedRetryOrder = [...tested].sort((a, b) => {
		const ta = lastAnswerAtByWord.get(a) ?? 0
		const tb = lastAnswerAtByWord.get(b) ?? 0
		if (ta !== tb) return ta - tb
		return ordered.indexOf(a) - ordered.indexOf(b)
	})
	const tryOrder = [...untested, ...testedRetryOrder]

	for (const wordId of tryOrder) {
		const resolved = await resolveClozeWithHint({
			wordId,
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
				vocabMode: "NEWWORDS" as const,
				devSelection: devSelection(
					"NEWWORDS",
					"new_words",
					`New words: ${ordered.length}-word list; untested first, then retries least-recently-answered-this-session`,
				),
			})
		}
	}

	return c.json(
		{
			error: "no_question_available",
			message:
				"Could not build a cloze for any word in this New words list (each needs a usable hint). Try Build mode instead, or add parallel / dictionary coverage for these lemmas.",
		},
		404,
	)
}

/**
 * BUILD mode: fill gaps in the vocab graph band (first min(corpus, ≈1.2× baseline) lemmas by rank).
 * Two bands: a **frontier** (no knowledge row yet, rank > assumedRank, capped) for introductions, and
 * an **active** band (in-flight learning: not verified known). Territory opening/revisit prefers
 * active rows over brand-new lemmas. Shaky picks are rank-ordered within the band. Guests keep the
 * legacy rank-window random walk (no profile / knowledge).
 */
async function handleBuildGuestNext(
	// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
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
			devSelection: devSelection(
				vocabMode,
				"guest_random",
				"Guest build: random cloze in expanding rank window (no profile buckets)",
			),
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

async function handleBuildNext(
	// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
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
	const build = await resolveVocabBuildSettings()

	const testedInSession = new Set(sessionAnswers.map((a) => a.wordId))
	const eligibleMood = tailConsecutiveWrongs(sessionAnswers) >= build.moodMinStreakWrong

	const [newWords, shakyKnowledge, moodKnowledge, territoryRowsRaw] = await Promise.all([
		prisma.word.findMany({
			where: {
				languageId: langs.targetLanguageId,
				id: { in: graphVisibleWordIds },
				effectiveRank: { gt: rankAboveFloor },
				isOffensive: false,
				isAbbreviation: false,
				testSentenceIds: { isEmpty: false },
				NOT: {
					userKnowledge: {
						some: { userId: session.userId },
					},
				},
			},
			orderBy: { effectiveRank: "asc" },
			take: build.frontierBandMax,
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
						effectiveRank: { gte: 1 },
						isOffensive: false,
						isAbbreviation: false,
						testSentenceIds: { isEmpty: false },
					},
				},
			},
			orderBy: [{ word: { effectiveRank: "asc" } }, { lastTestedAt: "asc" }, { confidence: "asc" }],
			take: build.candidateCap,
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
								effectiveRank: { gte: 1 },
								isOffensive: false,
								isAbbreviation: false,
								testSentenceIds: { isEmpty: false },
							},
						},
					},
					take: build.candidateCap,
					select: { wordId: true },
				})
			: Promise.resolve([] as { wordId: string }[]),
		prisma.word.findMany({
			where: {
				languageId: langs.targetLanguageId,
				id: { in: graphVisibleWordIds },
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
			orderBy: { effectiveRank: "asc" },
			take: Math.min(graphVisibleWordIds.length, 120),
			select: {
				id: true,
				effectiveRank: true,
				userKnowledge: {
					where: { userId: session.userId },
					select: { timesTested: true, timesCorrect: true },
				},
			},
		}),
	])

	const newIds = newWords.map((w) => w.id)
	const shakyIds = shakyKnowledge.map((k) => k.wordId)
	const moodIds = moodKnowledge.map((k) => k.wordId)

	const territoryRows = sortBuildTerritoryRows(territoryRowsRaw)
	const { orderedIds: territoryPreferActiveIds, winnableIds: territoryPreferActiveWinnableIds } =
		territoryIdsPreferActive(territoryRows, build.heavyMissThreshold)

	const nextBuildQuestionNumber = sessionAnswers.length + 1

	if (
		build.territoryOpening > 0 &&
		nextBuildQuestionNumber > 1 &&
		nextBuildQuestionNumber <= build.territoryOpening &&
		territoryPreferActiveIds.length > 0
	) {
		const resolved = await tryResolveBuildTerritoryPick(
			territoryPreferActiveWinnableIds,
			testedInSession,
			3,
			langs,
			build,
		)
		if (resolved) {
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
				devSelection: devSelection(
					vocabMode,
					"territory_opening",
					`Territory opening: Q${nextBuildQuestionNumber} of first ${build.territoryOpening} — active (in-flight) before new introductions`,
				),
			})
		}
	}

	if (
		build.territoryOpening > 0 &&
		nextBuildQuestionNumber > build.territoryOpening &&
		territoryPreferActiveIds.length > 0 &&
		build.territoryRevisitEvery > 0 &&
		nextBuildQuestionNumber % build.territoryRevisitEvery === 0
	) {
		const resolved = await tryResolveBuildTerritoryPick(
			territoryPreferActiveIds,
			testedInSession,
			build.territoryHeadSpread,
			langs,
			build,
		)
		if (resolved) {
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
				devSelection: devSelection(
					vocabMode,
					"territory_revisit",
					`Territory revisit: every ${build.territoryRevisitEvery} questions after Q${build.territoryOpening} — active before new`,
				),
			})
		}
	}

	const primaryBucket = rollBuildBucket(eligibleMood, build)
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
				wordId = pickPreferFreshFromOrderedIds(newIds, testedInSession, tried, build, {
					spreadCap: build.newSpread,
					biasTowardHead: true,
					sliceCap: build.frontierBandMax,
				})
			} else if (bucket === "shaky") {
				wordId = pickPreferFreshFromOrderedIds(shakyIds, testedInSession, tried, build, {
					spreadCap: build.newSpread + 2,
					biasTowardHead: true,
				})
			} else if (bucket === "mood" && eligibleMood) {
				wordId = pickPreferFreshFromOrderedIds(moodIds, testedInSession, tried, build)
			}
			if (!wordId) continue
			tried.add(wordId)

			const resolved = await resolveClozeWithHint({
				wordId,
				nativeLanguageId: langs.nativeLanguageId,
				targetLanguageId: langs.targetLanguageId,
			})

			if (!resolved.ok) continue

			const bucketKind = bucket
			const orderLabel = bucketOrder.join(" → ")
			const bucketSummary =
				bucket === "new"
					? `Frontier band (no knowledge row yet, rank > assumed, capped). Rolled primary: ${primaryBucket}. Try order: ${orderLabel}`
					: bucket === "shaky"
						? `Shaky bucket (in band, not verified known). Rolled primary: ${primaryBucket}. Try order: ${orderLabel}`
						: `Mood bucket (verified known; eligible after ${build.moodMinStreakWrong}+ consecutive wrong). Rolled primary: ${primaryBucket}. Try order: ${orderLabel}`

			const baseSel = devSelection(vocabMode, bucketKind, bucketSummary)
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
				devSelection: {
					...baseSel,
					primaryBucket,
					bucketOrder,
				},
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
				devSelection: devSelection(
					vocabMode,
					"fallback",
					"Fallback: random in-band cloze above assumed rank after bucket attempts failed",
				),
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
		select: { id: true, effectiveRank: true },
	})
	const rankMap = new Map(answeredWords.map((w) => [w.id, w.effectiveRank]))

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

const startTestSessionBodySchema = z
	.object({
		mode: z.enum(["MULTIPLE_CHOICE", "TRANSLATION", "VOICE", "MIXED"]),
		vocabMode: z.enum(["ASSESSMENT", "BUILD", "FRUSTRATION", "NEWWORDS"]).default("BUILD"),
		nativeLanguageId: z.string().uuid().optional(),
		targetLanguageId: z.string().uuid().optional(),
		columnFocusWordIds: z.array(z.string().uuid()).max(200).optional(),
	})
	.refine((d) => d.vocabMode !== "NEWWORDS" || (d.columnFocusWordIds?.length ?? 0) > 0, {
		message: "NEWWORDS sessions require a non-empty columnFocusWordIds list",
		path: ["columnFocusWordIds"],
	})

export const testRoute = new Hono<OptionalAuthEnv>()
	.use("*", optionalAuth)
	// Start a new test session
	.post("/sessions", zValidator("json", startTestSessionBodySchema), async (c) => {
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
						...(body.columnFocusWordIds?.length
							? { columnFocusWordIds: body.columnFocusWordIds }
							: {}),
					},
				})

				return c.json({ sessionId: session.id, mode: body.mode, vocabMode: session.vocabMode }, 201)
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
					...(body.columnFocusWordIds?.length
						? { columnFocusWordIds: body.columnFocusWordIds }
						: {}),
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
				...(body.columnFocusWordIds?.length ? { columnFocusWordIds: body.columnFocusWordIds } : {}),
			},
		})

		return c.json({ sessionId: session.id, mode: body.mode, vocabMode: session.vocabMode }, 201)
	})

	/** Set or clear optional word-queue JSON on this session (signed-in owner only). */
	.patch(
		"/sessions/:id/column-focus",
		zValidator(
			"json",
			z.union([
				z.object({ wordIds: z.array(z.string().uuid()).min(1).max(200) }),
				z.object({ clear: z.literal(true) }),
			]),
		),
		async (c) => {
			const user = c.get("user")
			if (!user) return c.json({ error: "Unauthorized" }, 401)

			const sessionId = c.req.param("id")
			const session = await getSessionIfAllowed(sessionId, user, { requireActive: true })
			if (!session?.userId || session.userId !== user.id) {
				return c.json({ error: "Session not found or already ended" }, 404)
			}

			const body = c.req.valid("json")
			if ("clear" in body) {
				await prisma.testSession.update({
					where: { id: sessionId },
					data: { columnFocusWordIds: Prisma.JsonNull },
				})
			} else {
				await prisma.testSession.update({
					where: { id: sessionId },
					data: { columnFocusWordIds: body.wordIds },
				})
			}

			return c.body(null, 204)
		},
	)

	// Next cloze item — word selection depends on vocabMode
	.get("/sessions/:id/next", async (c) => {
		const user = c.get("user")
		const { id: sessionId } = c.req.param()
		const forceSentenceId = c.req.query("sentenceId")?.trim() || undefined
		const forceWordId = c.req.query("wordId")?.trim() || undefined

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

		// ── Force a specific sentence / word (admin testing) ──────────
		if (forceSentenceId) {
			const targetWordId =
				forceWordId ??
				(
					await prisma.sentenceWord.findFirst({
						where: {
							sentenceId: forceSentenceId,
							word: { languageId: langs.targetLanguageId, isAbbreviation: false },
						},
						orderBy: { position: "asc" },
						select: { wordId: true },
					})
				)?.wordId
			if (!targetWordId) {
				return c.json(
					{ error: "no_question_available", message: "No testable word found for this sentence." },
					404,
				)
			}
			const resolved = await resolveClozeWithHint({
				wordId: targetWordId,
				nativeLanguageId: langs.nativeLanguageId,
				targetLanguageId: langs.targetLanguageId,
				forceSentenceId,
			})
			if (!resolved.ok) {
				return c.json(
					{ error: "no_question_available", message: "Could not build a cloze for this sentence." },
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
				devSelection: devSelection(
					session.vocabMode ?? "BUILD",
					"forced_sentence",
					forceWordId
						? "Forced word/sentence (admin): explicit wordId"
						: "Forced sentence (admin): first testable word in sentence",
				),
			})
		}

		const vocabMode = session.vocabMode ?? "BUILD"

		// ── Word selection by mode ──────────────────────────────

		if (vocabMode === "ASSESSMENT") {
			return await handleAssessmentNext(c, session, langs)
		}

		if (vocabMode === "FRUSTRATION") {
			return await handleFrustrationNext(c, session, langs)
		}

		if (vocabMode === "NEWWORDS") {
			return await handleNewWordsNext(c, session, langs)
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

			let confidenceUpdate:
				| {
						confidence: number
						previousConfidence: number | null
						timesTested: number
						timesCorrect: number
				  }
				| undefined

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

				const nextTimesTested = (existing?.timesTested ?? 0) + 1
				const nextTimesCorrect = (existing?.timesCorrect ?? 0) + (body.correct ? 1 : 0)

				confidenceUpdate = {
					confidence: result.confidence,
					previousConfidence: existing ? existing.confidence : null,
					timesTested: nextTimesTested,
					timesCorrect: nextTimesCorrect,
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

			// ── Synonym → POS mismatch → fixed-expression (wrong answers only; first match wins) ──
			let synonymFeedback: { kind: "good" | "bad"; message: string } | undefined
			let posMismatch: { guessPos: string; targetPos: string; message: string } | undefined
			let fixedExpressionFeedback: { message: string } | undefined

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
						// ── POS mismatch ──
						const targetWord = await prisma.word.findUnique({
							where: { id: body.wordId },
							select: { pos: true, lemma: true },
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

						// ── Fixed-expression check (fall through if no POS mismatch) ──
						if (!posMismatch && body.sentenceId && targetWord) {
							const dbRules = await prisma.fixedExpressionRule.findMany({
								where: { languageId: langs.targetLanguageId },
							})
							if (dbRules.length > 0) {
								const rules = dbRules.map((r) => ({
									trigger: r.trigger,
									required: r.required,
									invalid: r.invalid,
									messageId: "fixed_expression" as const,
									params: { expression: r.expression, meaning: r.meaning },
								}))
								const sentence = await prisma.sentence.findUnique({
									where: { id: body.sentenceId },
									select: { text: true },
								})
								if (sentence) {
									const msg = checkFixedExpression(
										sentence.text,
										targetWord.lemma,
										body.userAnswer,
										rules,
										nativeLang?.code ?? "en",
									)
									if (msg) {
										fixedExpressionFeedback = { message: msg }
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
				...(fixedExpressionFeedback && { fixedExpressionFeedback }),
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

	/** Dev-mode: peek at candidate word pools for the current BUILD session. */
	.get("/sessions/:id/upcoming", async (c) => {
		const user = c.get("user")
		if (!user) return c.json({ error: "Unauthorized" }, 401)

		const sessionId = c.req.param("id")
		const session = await getSessionIfAllowed(sessionId, user, { requireActive: true })
		if (!session || !session.userId) {
			return c.json({ error: "Session not found or already ended" }, 404)
		}

		const sessionUserId = session.userId

		const langs = await resolveClozeLanguageIds(session)
		if (!langs) {
			return c.json({ error: "Missing language pair" }, 400)
		}

		const [profile, sessionAnswers, knownVerifiedCount] = await Promise.all([
			prisma.userLanguageProfile.findUnique({
				where: {
					userId_languageId: {
						userId: sessionUserId,
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
					userId: sessionUserId,
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
		const rankAboveFloor = Math.max(0, assumedRank)
		const build = await resolveVocabBuildSettings()
		const testedInSession = new Set(sessionAnswers.map((a) => a.wordId))
		const peekWordIdRaw = c.req.query("peekWordId")?.trim()
		const peekWordId =
			peekWordIdRaw &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				peekWordIdRaw,
			)
				? peekWordIdRaw
				: undefined
		const testedForPanel = new Set(testedInSession)
		if (peekWordId) testedForPanel.add(peekWordId)

		const answersChrono = sessionAnswers.map((a) => ({ correct: a.correct }))
		const consecutiveWrongStreak = tailConsecutiveWrongs(answersChrono)
		const eligibleMoodNow = consecutiveWrongStreak >= build.moodMinStreakWrong

		const wordSelect = {
			id: true,
			lemma: true,
			effectiveRank: true,
			testSentenceIds: true,
		} as const

		const [newWords, shakyKnowledge, territoryRowsRaw, peekWordRow, moodKnowledge] =
			await Promise.all([
				// "new" / frontier band: matches `handleBuildNext` (rank > assumedRank, no row, capped).
				prisma.word.findMany({
					where: {
						languageId: langs.targetLanguageId,
						id: { in: graphVisibleWordIds },
						effectiveRank: { gt: rankAboveFloor },
						isOffensive: false,
						isAbbreviation: false,
						testSentenceIds: { isEmpty: false },
						NOT: {
							userKnowledge: {
								some: { userId: sessionUserId },
							},
						},
					},
					orderBy: { effectiveRank: "asc" },
					take: build.frontierBandMax,
					select: wordSelect,
				}),
				prisma.userWordKnowledge.findMany({
					where: {
						userId: sessionUserId,
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
								effectiveRank: { gte: 1 },
								isOffensive: false,
								isAbbreviation: false,
								testSentenceIds: { isEmpty: false },
							},
						},
					},
					orderBy: [
						{ word: { effectiveRank: "asc" } },
						{ lastTestedAt: "asc" },
						{ confidence: "asc" },
					],
					take: build.candidateCap,
					select: {
						wordId: true,
						confidence: true,
						timesTested: true,
						word: { select: wordSelect },
					},
				}),
				prisma.word.findMany({
					where: {
						languageId: langs.targetLanguageId,
						id: { in: graphVisibleWordIds },
						isOffensive: false,
						isAbbreviation: false,
						testSentenceIds: { isEmpty: false },
						NOT: {
							userKnowledge: {
								some: {
									userId: sessionUserId,
									confidence: { gte: KNOWN_CONFIDENCE_THRESHOLD },
									timesTested: { gte: KNOWN_MIN_TESTS },
								},
							},
						},
					},
					orderBy: { effectiveRank: "asc" },
					take: Math.min(graphVisibleWordIds.length, 120),
					select: {
						...wordSelect,
						userKnowledge: {
							where: { userId: sessionUserId },
							select: { timesTested: true, timesCorrect: true },
						},
					},
				}),
				// Always resolve the current/peeked word so we can surface it in the dev panel
				// when the filter queries above exclude it (e.g. cloze resolution edge cases).
				peekWordId
					? prisma.word.findUnique({
							where: { id: peekWordId },
							select: wordSelect,
						})
					: Promise.resolve(null),
				eligibleMoodNow
					? prisma.userWordKnowledge.findMany({
							where: {
								userId: sessionUserId,
								confidence: { gte: KNOWN_CONFIDENCE_THRESHOLD },
								timesTested: { gte: KNOWN_MIN_TESTS },
								word: {
									is: {
										languageId: langs.targetLanguageId,
										id: { in: graphVisibleWordIds },
										effectiveRank: { gte: 1 },
										isOffensive: false,
										isAbbreviation: false,
										testSentenceIds: { isEmpty: false },
									},
								},
							},
							orderBy: [{ lastTestedAt: "asc" }, { confidence: "asc" }],
							take: build.candidateCap,
							select: {
								wordId: true,
								confidence: true,
								timesTested: true,
								word: { select: wordSelect },
							},
						})
					: Promise.resolve(
							[] as {
								wordId: string
								confidence: number
								timesTested: number
								word: {
									id: string
									lemma: string
									effectiveRank: number
									testSentenceIds: string[]
								}
							}[],
						),
			])

		// Deduplicate: raw territory overlaps "shaky" and frontier "new". Subtract those so each
		// tab is distinct — remainder is usually not-yet-known with no row at rank ≤ assumedRank
		// (outside the frontier band filter) or other edge cases.
		const shakyWordIds = new Set(shakyKnowledge.map((k) => k.wordId))
		const newWordIds = new Set(newWords.map((w) => w.id))
		const territoryRows = sortBuildTerritoryRows(
			territoryRowsRaw.filter((w) => !shakyWordIds.has(w.id) && !newWordIds.has(w.id)),
		)
		const territoryRowsSortedForPreview = sortBuildTerritoryRows(territoryRowsRaw)
		const territoryCountForPreview = territoryIdsPreferActive(
			territoryRowsSortedForPreview,
			build.heavyMissThreshold,
		).orderedIds.length
		const nextQ = sessionAnswers.length + 1
		const vocabMode = session.vocabMode ?? "BUILD"

		const eligibleMoodAfterCorrect =
			tailConsecutiveWrongs([...answersChrono, { correct: true }]) >= build.moodMinStreakWrong
		const eligibleMoodAfterWrong =
			tailConsecutiveWrongs([...answersChrono, { correct: false }]) >= build.moodMinStreakWrong

		const nextQAfterSubmit = sessionAnswers.length + 2
		const nextAfterCorrect =
			vocabMode === "BUILD"
				? buildNextPickPreview({
						nextBuildQuestionNumber: nextQAfterSubmit,
						territoryCount: territoryCountForPreview,
						eligibleMood: eligibleMoodAfterCorrect,
						build,
					})
				: null
		const nextAfterWrong =
			vocabMode === "BUILD"
				? buildNextPickPreview({
						nextBuildQuestionNumber: nextQAfterSubmit,
						territoryCount: territoryCountForPreview,
						eligibleMood: eligibleMoodAfterWrong,
						build,
					})
				: null

		// Collect all candidate word IDs to batch-fetch knowledge
		const allWordIds = [
			...new Set([
				...territoryRows.map((r) => r.id),
				...newWords.map((w) => w.id),
				...shakyKnowledge.map((k) => k.wordId),
				...moodKnowledge.map((k) => k.wordId),
				...(peekWordRow ? [peekWordRow.id] : []),
			]),
		]

		const knowledgeRows =
			allWordIds.length > 0
				? await prisma.userWordKnowledge.findMany({
						where: { userId: sessionUserId, wordId: { in: allWordIds } },
						select: {
							wordId: true,
							confidence: true,
							timesTested: true,
							streak: true,
							lastTestedAt: true,
						},
					})
				: []

		const knowledgeByWordId = new Map(knowledgeRows.map((k) => [k.wordId, k]))

		type UpcomingWord = {
			wordId: string
			lemma: string
			rank: number
			testedInSession: boolean
			hasSentences: boolean
			confidence: number
			timesTested: number
			streak: number
			lastTestedAt: string | null
		}

		const mapWord = (w: {
			id: string
			lemma: string
			effectiveRank: number
			testSentenceIds: string[]
		}): UpcomingWord => {
			const k = knowledgeByWordId.get(w.id)
			return {
				wordId: w.id,
				lemma: w.lemma,
				rank: w.effectiveRank,
				testedInSession: testedForPanel.has(w.id),
				hasSentences: w.testSentenceIds.length > 0,
				confidence: k?.confidence ?? 0,
				timesTested: k?.timesTested ?? 0,
				streak: k?.streak ?? 0,
				lastTestedAt: k?.lastTestedAt?.toISOString() ?? null,
			}
		}

		return c.json({
			vocabMode,
			questionNumber: nextQ,
			territory: territoryRows.slice(0, 20).map(mapWord),
			new: newWords.slice(0, 20).map(mapWord),
			shaky: shakyKnowledge.slice(0, 20).map((k) => mapWord(k.word)),
			mood: moodKnowledge.slice(0, 20).map((k) => mapWord(k.word)),
			current: peekWordRow ? mapWord(peekWordRow) : null,
			generatedAt: new Date().toISOString(),
			consecutiveWrongStreak,
			eligibleMoodNow,
			devNextPickAfterSubmit:
				vocabMode === "BUILD" && nextAfterCorrect && nextAfterWrong
					? {
							questionNumber: nextQAfterSubmit,
							ifLastAnswerCorrect: nextAfterCorrect,
							ifLastAnswerWrong: nextAfterWrong,
							previewsDiffer: JSON.stringify(nextAfterCorrect) !== JSON.stringify(nextAfterWrong),
						}
					: null,
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
