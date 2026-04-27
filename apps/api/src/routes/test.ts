import { zValidator } from "@hono/zod-validator"
import { Prisma, type TestSession, type VocabMode, prisma } from "@nwords/db"
import type { BuildModeActiveBandRow, BuildStrategyKind, VocabBuildSettings } from "@nwords/shared"
import {
	FRUSTRATION_WORD_MIN_TESTS,
	KNOWN_CONFIDENCE_THRESHOLD,
	KNOWN_MIN_TESTS,
	checkFixedExpression,
	collectFirstNUniqueEffectiveRanks,
	computeBuildModeActiveBandRows,
	computeHeatmapGridMetrics,
	isIntroCandidate,
	isVerifiedKnownInBand,
	isWorkingSetMember,
	rollBuildStrategy,
	updateConfidence,
} from "@nwords/shared"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { prismaWhereWordHasResolvableClozeMaterial } from "../lib/cloze-sentence-pool"
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
 * word near a **target rank** derived from those bounds.
 *
 * **Pick policy** (frequency ranks are noisy): first question targets ~`ASSESSMENT_START_RANK`.
 * Later questions use the midpoint of `[low, high]` but **cap forward jumps** to at most
 * `ASSESSMENT_MAX_FORWARD_RANK_STEP` above the last tested word's rank so we don't leap into
 * unrealistically high ranks after a single correct answer.
 *
 * Stopping: when range < 50 ranks OR 30 questions answered.
 */
const ASSESSMENT_MAX_QUESTIONS = 30
const ASSESSMENT_CONVERGE_THRESHOLD = 50
const ASSESSMENT_INITIAL_LOW = 1
const ASSESSMENT_INITIAL_HIGH = 10000
/** First probe when there are no answers yet (avoid starting at mid 5000). */
const ASSESSMENT_START_RANK = 300
/** Max increase in target rank vs the last word tested (curbs oversized forward steps). */
const ASSESSMENT_MAX_FORWARD_RANK_STEP = 200

export type DevSelectionPanelTab =
	| "territory"
	| "new"
	| "shaky"
	| "mood"
	| "band"
	| "intros"
	| "working"

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
		| "reinforce"
		| "introduce"
		| "band_walk"
		| "build_strategy"
	panelTab: DevSelectionPanelTab | null
	summary: string
	/** BUILD bucket pass only: which bucket was rolled first. */
	primaryBucket?: "new" | "shaky" | "mood"
	/** BUILD bucket pass only: order buckets are tried this question. */
	bucketOrder?: ("new" | "shaky" | "mood")[]
	/** BUILD: rolled strategy order for this question (after primary). */
	strategyOrder?: BuildStrategyKind[]
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

/** True while any ordered column lemma has not yet been answered in this session (first-pass gate). */
function columnFocusPendingFirstPass(ordered: string[], testedInSession: Set<string>): boolean {
	return ordered.length > 0 && ordered.some((id) => !testedInSession.has(id))
}

/** Per-word shuffle attempts before moving to the next lemma in column order. */
const COLUMN_WORD_CLOZE_MAX_ATTEMPTS = 16

/**
 * Build column focus: walk **column order**, only untested-this-session lemmas; for each word retry
 * `resolveClozeWithHint` (shuffle variance) before advancing. Avoids blocking the whole column when the
 * first id never resolves while later column words do.
 */
async function tryPickColumnFocusOrderedWithRetries(
	ordered: string[],
	testedInSession: Set<string>,
	langs: { nativeLanguageId: string; targetLanguageId: string },
): Promise<(Awaited<ReturnType<typeof resolveClozeWithHint>> & { ok: true }) | null> {
	for (const wordId of ordered) {
		if (testedInSession.has(wordId)) continue
		for (let attempt = 0; attempt < COLUMN_WORD_CLOZE_MAX_ATTEMPTS; attempt++) {
			const resolved = await resolveClozeWithHint({
				wordId,
				nativeLanguageId: langs.nativeLanguageId,
				targetLanguageId: langs.targetLanguageId,
			})
			if (resolved.ok) return resolved
		}
	}
	return null
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
							? "intros"
							: kind === "reinforce"
								? "working"
								: kind === "introduce"
									? "intros"
									: kind === "band_walk"
										? "band"
										: kind === "assessment_binary_search"
											? "band"
											: null
	return { vocabMode, kind, panelTab, summary }
}

/** Replay assessment answers to recover binary-search bounds (same rules as `handleAssessmentNext`). */
async function replayAssessmentLowHighForSession(
	testSessionId: string,
): Promise<{ low: number; high: number; answerCount: number }> {
	const answers = await prisma.testAnswer.findMany({
		where: { testSessionId },
		orderBy: { answeredAt: "asc" },
		select: { wordId: true, correct: true },
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
	return { low, high, answerCount: answers.length }
}

function computeAssessmentPickTargetRank(
	low: number,
	high: number,
	answerCount: number,
	lastTestedEffectiveRank: number | null,
): { targetRank: number; naiveMid: number } {
	const naiveMid = Math.floor((low + high) / 2)
	if (answerCount === 0) {
		return {
			naiveMid,
			targetRank: Math.max(low, Math.min(high, ASSESSMENT_START_RANK)),
		}
	}
	let targetRank = naiveMid
	if (
		lastTestedEffectiveRank != null &&
		lastTestedEffectiveRank > 0 &&
		naiveMid > lastTestedEffectiveRank + ASSESSMENT_MAX_FORWARD_RANK_STEP
	) {
		targetRank = lastTestedEffectiveRank + ASSESSMENT_MAX_FORWARD_RANK_STEP
	}
	targetRank = Math.max(low, Math.min(high, targetRank))
	return { targetRank, naiveMid }
}

async function lastAnsweredEffectiveRank(
	testSessionId: string,
): Promise<{ rank: number; wordId: string } | null> {
	const last = await prisma.testAnswer.findFirst({
		where: { testSessionId },
		orderBy: { answeredAt: "desc" },
		select: { wordId: true },
	})
	if (!last) return null
	const w = await prisma.word.findUnique({
		where: { id: last.wordId },
		select: { effectiveRank: true },
	})
	const r = w?.effectiveRank
	if (typeof r !== "number" || r <= 0) return null
	return { rank: r, wordId: last.wordId }
}

/** Dev panel: qualitative description; actual next card is a random strategy roll in `handleBuildNext`. */
function buildNextPickPreview(args: {
	nextBuildQuestionNumber: number
	build: VocabBuildSettings
	columnFocusActive?: boolean
	workingSetThin: boolean
}): Pick<DevSelection, "kind" | "panelTab" | "summary"> & {
	strategyPercents: { reinforce: number; introduce: number; bandWalk: number }
} {
	const { nextBuildQuestionNumber: q, build: b, columnFocusActive, workingSetThin } = args
	if (columnFocusActive) {
		const sel = devSelection(
			"BUILD",
			"column_focus",
			`Q${q}: column focus — heatmap column list until each lemma is tested once this session (overrides strategy roll)`,
		)
		return {
			kind: sel.kind,
			panelTab: sel.panelTab,
			summary: sel.summary,
			strategyPercents: {
				reinforce: b.pReinforceWorkingSet,
				introduce: b.pIntroduce,
				bandWalk: b.pBandWalk,
			},
		}
	}
	let r = b.pReinforceWorkingSet
	let i = b.pIntroduce
	let w = b.pBandWalk
	if (workingSetThin) {
		const boost = Math.min(30, Math.floor((r + w) * 0.35))
		i += boost
		const takeR = Math.min(Math.floor(boost / 2), Math.max(0, r - 5))
		const takeW = boost - takeR
		r = Math.max(5, r - takeR)
		w = Math.max(5, w - takeW)
	}
	const thinNote = workingSetThin
		? " Working set below configured target — intro weighs more heavily on the next roll (same rule as `rollBuildStrategy`)."
		: ""
	return {
		kind: "build_strategy",
		panelTab: null,
		summary: `Q${q}: one random strategy then ordered fallbacks — reinforce working set ~${r}%, introduce ~${i}%, band walk ~${w}% (column-major active band).${thinNote}`,
		strategyPercents: { reinforce: r, introduce: i, bandWalk: w },
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
type GraphVisibleRankRow = { id: string; effectiveRank: number }

async function buildModeGraphVisibleRankRows(
	languageId: string,
	assumedRank: number,
	vocabSize: number,
): Promise<GraphVisibleRankRow[]> {
	const baseline = Math.max(assumedRank, vocabSize, 50)
	const targetCellCount = Math.ceil(baseline * 1.2)
	const heatmapWhere = {
		languageId,
		effectiveRank: { gte: 1, lte: 10_000 },
		isOffensive: false,
		isAbbreviation: false,
		isTestable: true,
	}
	const total = await prisma.word.count({ where: heatmapWhere })
	const n = Math.min(total, targetCellCount)
	if (n <= 0) return []
	return collectFirstNUniqueEffectiveRanks(n, (skip, take) =>
		prisma.word.findMany({
			where: heatmapWhere,
			orderBy: [{ effectiveRank: "asc" }, { id: "asc" }],
			skip,
			take,
			select: { id: true, effectiveRank: true },
		}),
	)
}

function pickSpreadFromOrdered(
	orderedIds: string[],
	testedInSession: Set<string>,
	tried: Set<string>,
	spreadCap: number,
	biasTowardHead: boolean,
): string | null {
	let pool = orderedIds.filter((id) => !tried.has(id) && !testedInSession.has(id))
	if (pool.length === 0) pool = orderedIds.filter((id) => !tried.has(id))
	if (pool.length === 0) return null
	const spread = Math.min(Math.max(1, spreadCap), pool.length)
	const idx = biasTowardHead
		? Math.min(spread - 1, Math.floor(Math.random() * Math.random() * spread))
		: Math.floor(Math.random() * spread)
	return pool[idx]
}

async function loadBuildActiveBandContext(args: {
	userId: string
	languageId: string
	assumedRank: number
	vocabSize: number
	graphRows: GraphVisibleRankRow[]
	frontierBandMax: number
}): Promise<{
	bandRows: BuildModeActiveBandRow[]
	clozableWordIds: Set<string>
}> {
	const { userId, languageId, assumedRank, vocabSize, graphRows, frontierBandMax } = args
	const met = computeHeatmapGridMetrics(graphRows.length, assumedRank, vocabSize)
	const dc = met?.displayCount ?? 0
	const headIds = graphRows.slice(0, dc).map((r) => r.id)
	const knowledgeRows =
		headIds.length > 0
			? await prisma.userWordKnowledge.findMany({
					where: { userId, wordId: { in: headIds } },
					select: { wordId: true, confidence: true, timesTested: true },
				})
			: []
	const knowledgeByWordId = new Map(
		knowledgeRows.map((k) => [k.wordId, { confidence: k.confidence, timesTested: k.timesTested }]),
	)
	const bandRows =
		computeBuildModeActiveBandRows({
			graphRows,
			assumedRank,
			vocabSize,
			frontierBandMax,
			knowledgeByWordId,
		}) ?? []
	const bandIds = bandRows.map((r) => r.wordId)
	const clozable =
		bandIds.length > 0
			? await prisma.word.findMany({
					where: {
						languageId,
						id: { in: bandIds },
						...prismaWhereWordHasResolvableClozeMaterial(languageId),
					},
					select: { id: true },
				})
			: []
	return {
		bandRows,
		clozableWordIds: new Set(clozable.map((w) => w.id)),
	}
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

	const { low, high, answerCount } = await replayAssessmentLowHighForSession(session.id)

	// Check convergence
	if (high - low < ASSESSMENT_CONVERGE_THRESHOLD) {
		return c.json({
			done: true,
			message: "Assessment complete — level found.",
			wordsTestedCount: session.wordsTestedCount,
			assumedRank: Math.floor((low + high) / 2),
		})
	}

	const lastAnswered = answerCount > 0 ? await lastAnsweredEffectiveRank(session.id) : null
	const { targetRank, naiveMid } = computeAssessmentPickTargetRank(
		low,
		high,
		answerCount,
		lastAnswered?.rank ?? null,
	)
	const assessmentDevSummary =
		answerCount === 0
			? `Assessment: first probe near rank ${targetRank} (bounds ${low}–${high})`
			: targetRank !== naiveMid
				? `Assessment: target rank ${targetRank}, max +${ASSESSMENT_MAX_FORWARD_RANK_STEP} from last tested (mid ${naiveMid}, bounds ${low}–${high})`
				: `Assessment: target rank ${targetRank} (bounds ${low}–${high})`

	// Try to find a word near the target rank
	const tried = new Set<string>(lastAnswered ? [lastAnswered.wordId] : [])
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
			devSelection: devSelection("ASSESSMENT", "assessment_binary_search", assessmentDevSummary),
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
					isTestable: true,
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
		orderBy: { answeredAt: "asc" },
		select: { wordId: true },
	})
	const testedInSession = new Set(sessionAnswers.map((a) => a.wordId))
	const lastAnsweredWordId = sessionAnswers.at(-1)?.wordId

	// Prefer words not yet tested in this session; avoid the immediately preceding word when possible
	const candidates = frustrationWords.filter(
		(w) => !testedInSession.has(w.wordId) && w.wordId !== lastAnsweredWordId,
	)
	const pool =
		candidates.length > 0
			? candidates
			: frustrationWords.filter((w) => w.wordId !== lastAnsweredWordId).length > 0
				? frustrationWords.filter((w) => w.wordId !== lastAnsweredWordId)
				: frustrationWords

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

type NewWordsBandIntroOfferJson = {
	kind: "working_set_thin" | "intro_backlog"
	wordIds: string[]
	words: { wordId: string; lemma: string; rank: number }[]
	practiceWordIds: string[]
	workingSetCount: number
	workingSetTarget: number
	/** Clozable `timesTested===0` lemmas still in the active band when this offer was built. */
	introBacklogCount: number
}

/** Clozable intro lemmas (band order) for the New words chunk dialog; `null` if nothing to offer. */
async function buildNewWordsBandIntroOfferJson(args: {
	languageId: string
	introIdsOrdered: string[]
	chunkSize: number
	workingSetCount: number
	workingSetTarget: number
	kind: "working_set_thin" | "intro_backlog"
}): Promise<NewWordsBandIntroOfferJson | null> {
	const { languageId, introIdsOrdered, chunkSize, workingSetCount, workingSetTarget, kind } = args
	if (introIdsOrdered.length === 0 || chunkSize < 1) return null
	const slice = introIdsOrdered.slice(0, chunkSize)
	const rows = await prisma.word.findMany({
		where: { languageId, id: { in: slice } },
		select: { id: true, lemma: true, effectiveRank: true },
	})
	const byId = new Map(rows.map((w) => [w.id, w]))
	const words: { wordId: string; lemma: string; rank: number }[] = []
	for (const id of slice) {
		const w = byId.get(id)
		if (w) words.push({ wordId: w.id, lemma: w.lemma, rank: w.effectiveRank })
	}
	if (words.length === 0) return null
	const wordIds = words.map((w) => w.wordId)
	return {
		kind,
		wordIds,
		words,
		practiceWordIds: wordIds,
		workingSetCount,
		workingSetTarget,
		introBacklogCount: introIdsOrdered.length,
	}
}

/**
 * BUILD mode (signed-in): heatmap-aligned **active band**, then random **strategy** among reinforce /
 * introduce / band-walk. Column focus (if any) runs first until each listed lemma has one session
 * answer.
 */
async function handleBuildNext(
	// biome-ignore lint/suspicious/noExplicitAny: Hono context type is complex and varies by route
	c: Context<any>,
	session: TestSession,
	langs: { nativeLanguageId: string; targetLanguageId: string },
	vocabMode: VocabMode,
) {
	if (!session.userId) {
		return c.json(
			{
				error: "build_requires_auth",
				message:
					"Build vocabulary requires a signed-in account. Try Assessment mode, or sign in to use Build.",
			},
			403,
		)
	}
	const userId = session.userId

	const [profile, sessionAnswers, knownVerifiedCount] = await Promise.all([
		prisma.userLanguageProfile.findUnique({
			where: {
				userId_languageId: {
					userId,
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
				userId,
				confidence: { gte: KNOWN_CONFIDENCE_THRESHOLD },
				timesTested: { gte: KNOWN_MIN_TESTS },
				word: {
					is: { languageId: langs.targetLanguageId, isAbbreviation: false, isTestable: true },
				},
			},
		}),
	])

	const assumedRank = profile?.assumedRank ?? 0
	const vocabSize = assumedRank + knownVerifiedCount

	const testedInSession = new Set(sessionAnswers.map((a) => a.wordId))
	const lastAnsweredWordId = sessionAnswers.at(-1)?.wordId
	const columnOrdered = parseColumnFocusWordIds(session.columnFocusWordIds)
	const pendingCol = columnFocusPendingFirstPass(columnOrdered, testedInSession)
	if (pendingCol) {
		const resolved = await tryPickColumnFocusOrderedWithRetries(
			columnOrdered,
			testedInSession,
			langs,
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
					"column_focus",
					`Column focus: ${columnOrdered.length}-word heatmap column order — each listed lemma at least once this session before the active-band strategy roll (ordered walk, per-word shuffle retries)`,
				),
			})
		}
		return c.json(
			{
				error: "no_question_available",
				message:
					"Column practice is locked on this list until each word has been checked once. The next unseen word could not be built as a cloze yet — try “Next” again, or fix sentence/hint coverage for that lemma.",
			},
			404,
		)
	}

	const graphVisibleRows = await buildModeGraphVisibleRankRows(
		langs.targetLanguageId,
		assumedRank,
		vocabSize,
	)
	if (graphVisibleRows.length === 0) {
		return c.json(
			{
				error: "no_question_available",
				message:
					"No vocabulary in the graph range for your level. Complete an assessment or try another mode.",
			},
			404,
		)
	}
	const build = await resolveVocabBuildSettings()
	const { bandRows, clozableWordIds } = await loadBuildActiveBandContext({
		userId,
		languageId: langs.targetLanguageId,
		assumedRank,
		vocabSize,
		graphRows: graphVisibleRows,
		frontierBandMax: build.frontierBandMax,
	})
	if (bandRows.length === 0) {
		return c.json(
			{
				error: "no_question_available",
				message:
					"No active vocabulary band past your conquered heatmap columns. Complete more territory or try another mode.",
			},
			404,
		)
	}

	const byRank = (a: BuildModeActiveBandRow, b: BuildModeActiveBandRow) =>
		a.effectiveRank !== b.effectiveRank
			? a.effectiveRank - b.effectiveRank
			: a.wordId.localeCompare(b.wordId)

	const workingIds = bandRows
		.filter(
			(r) => clozableWordIds.has(r.wordId) && isWorkingSetMember(r, build.confidenceCriterion),
		)
		.sort(byRank)
		.map((r) => r.wordId)

	const introIds = bandRows
		.filter((r) => clozableWordIds.has(r.wordId) && isIntroCandidate(r))
		.sort(byRank)
		.map((r) => r.wordId)

	const bandWalkIds = bandRows
		.filter(
			(r) => clozableWordIds.has(r.wordId) && !isVerifiedKnownInBand(r.confidence, r.timesTested),
		)
		.sort(byRank)
		.map((r) => r.wordId)

	const workingSetThin = workingIds.length < build.workingSetSize
	const introBacklog = introIds.length
	/**
	 * Offer the batched “new lemmas” dialog only when the reinforce working set is below target — i.e. the
	 * learner needs fresh band material. A large queue of untested intros alone does not trigger it.
	 */
	const gateBandIntrosToChunk = introBacklog > 0 && workingSetThin
	const newWordsBandIntroOffer = gateBandIntrosToChunk
		? await buildNewWordsBandIntroOfferJson({
				languageId: langs.targetLanguageId,
				introIdsOrdered: introIds,
				chunkSize: build.newWordsIntroChunkSize,
				workingSetCount: workingIds.length,
				workingSetTarget: build.workingSetSize,
				kind: "working_set_thin",
			})
		: null
	const maybeBandIntro = newWordsBandIntroOffer ? { newWordsBandIntroOffer } : {}
	/** Only gate when the offer JSON built; otherwise Build can still pick intros (avoid no-question deadlock). */
	const skipAutoIntro = Boolean(newWordsBandIntroOffer)
	const introIdSet = new Set(introIds)
	const bandWalkIdsGated = skipAutoIntro
		? bandWalkIds.filter((id) => !introIdSet.has(id))
		: bandWalkIds
	const primary = rollBuildStrategy(build, workingSetThin)
	const strategyOrder: BuildStrategyKind[] = [
		primary,
		...(["reinforce", "introduce", "band_walk"] as const).filter((s) => s !== primary),
	]

	const SPREAD_REINFORCE = 14
	const SPREAD_INTRO = 12
	const SPREAD_WALK = 22

	const tried = new Set<string>(lastAnsweredWordId ? [lastAnsweredWordId] : [])
	const orderLabel = strategyOrder.join(" → ")

	for (let pass = 0; pass < 40; pass++) {
		for (const strat of strategyOrder) {
			const ordered =
				strat === "reinforce"
					? workingIds
					: strat === "introduce"
						? skipAutoIntro
							? []
							: introIds
						: bandWalkIdsGated
			const spread =
				strat === "reinforce"
					? SPREAD_REINFORCE
					: strat === "introduce"
						? SPREAD_INTRO
						: SPREAD_WALK
			const biasHead = strat !== "band_walk"
			const wordId = pickSpreadFromOrdered(ordered, testedInSession, tried, spread, biasHead)
			if (!wordId) continue
			tried.add(wordId)
			const resolved = await resolveClozeWithHint({
				wordId,
				nativeLanguageId: langs.nativeLanguageId,
				targetLanguageId: langs.targetLanguageId,
			})
			if (!resolved.ok) continue

			const stratSummary =
				strat === "reinforce"
					? `Reinforce working set: ${workingIds.length} clozable lemmas (tested, below confidence ${build.confidenceCriterion}, not verified-known). Rolled order: ${orderLabel}. Band size ${bandRows.length}.`
					: strat === "introduce"
						? skipAutoIntro
							? `Introduce skipped: working set below target — new band intros are offered via New words chunk first. Rolled order: ${orderLabel}.`
							: `Introduce: ${introIds.length} clozable lemmas with timesTested===0 in active band. Rolled order: ${orderLabel}.`
						: skipAutoIntro
							? `Band walk (no timesTested===0): ${bandWalkIdsGated.length} clozable tested-but-not-verified lemmas; untested band lemmas deferred to New words chunk. Rolled order: ${orderLabel}.`
							: `Band walk: ${bandWalkIds.length} clozable non-verified lemmas in active band. Rolled order: ${orderLabel}.`

			const baseSel = devSelection(vocabMode, strat, stratSummary)
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
				devSelection: { ...baseSel, strategyOrder },
				...maybeBandIntro,
			})
		}
	}

	const clozableBandRows = bandRows.filter(
		(r) => clozableWordIds.has(r.wordId) && (!skipAutoIntro || !introIdSet.has(r.wordId)),
	)
	const clozableBandIds = clozableBandRows.map((r) => r.wordId)
	const ranks = clozableBandRows.map((r) => r.effectiveRank)
	if (clozableBandIds.length > 0 && ranks.length > 0) {
		const low = Math.min(...ranks)
		const high = Math.max(...ranks)
		const triedFb = new Set(tried)
		for (let i = 0; i < 24; i++) {
			const wordId = await pickRandomWordIdForCloze(
				langs.targetLanguageId,
				[...triedFb],
				{ min: low, max: high },
				{ restrictToWordIds: clozableBandIds, excludeVerifiedKnownForUserId: userId },
			)
			if (!wordId) break
			triedFb.add(wordId)
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
					"Fallback: random clozable lemma in active band (rank window from band) after strategy passes failed",
				),
				...maybeBandIntro,
			})
		}
	}

	return c.json(
		{
			error: "no_question_available",
			message:
				"No build-mode cloze available in your active heatmap band. Add test sentences / hints for nearby lemmas, or try Frustration mode.",
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

		if (body.vocabMode === "BUILD") {
			return c.json(
				{
					error: "build_requires_auth",
					message:
						"Build vocabulary requires signing in. Choose Assessment or another mode, or create an account.",
				},
				403,
			)
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
							word: { languageId: langs.targetLanguageId, isAbbreviation: false, isTestable: true },
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

		const vocabModeEarly = session.vocabMode ?? "BUILD"
		if (vocabModeEarly === "ASSESSMENT") {
			const { low, high, answerCount } = await replayAssessmentLowHighForSession(session.id)
			const lastAnsweredPeek = answerCount > 0 ? await lastAnsweredEffectiveRank(session.id) : null
			const { targetRank } = computeAssessmentPickTargetRank(
				low,
				high,
				answerCount,
				lastAnsweredPeek?.rank ?? null,
			)
			const peekWordIdRaw = c.req.query("peekWordId")?.trim()
			const peekWordId =
				peekWordIdRaw &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					peekWordIdRaw,
				)
					? peekWordIdRaw
					: undefined
			const assessWordSelect = {
				id: true,
				lemma: true,
				effectiveRank: true,
				testSentenceIds: true,
			} as const
			const peekWordRow = peekWordId
				? await prisma.word.findUnique({
						where: { id: peekWordId, languageId: langs.targetLanguageId },
						select: assessWordSelect,
					})
				: null
			const current =
				peekWordRow != null
					? {
							wordId: peekWordRow.id,
							lemma: peekWordRow.lemma,
							rank: peekWordRow.effectiveRank,
							testedInSession: false,
							hasSentences: peekWordRow.testSentenceIds.length > 0,
							confidence: 0,
							timesTested: 0,
							streak: 0,
							lastTestedAt: null as string | null,
						}
					: null
			return c.json({
				vocabMode: "ASSESSMENT" as const,
				questionNumber: answerCount + 1,
				activeBand: [],
				workingSet: [],
				intros: [],
				current,
				generatedAt: new Date().toISOString(),
				bandLemmaCount: 0,
				clozableInBand: 0,
				workingSetCount: 0,
				workingSetThin: false,
				introChunkGateActive: false,
				devNextPickAfterSubmit: null,
				assessmentDev: { low, high, targetRank },
			})
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
						is: { languageId: langs.targetLanguageId, isAbbreviation: false, isTestable: true },
					},
				},
			}),
		])

		const assumedRank = profile?.assumedRank ?? 0
		const vocabSize = assumedRank + knownVerifiedCount
		const graphVisibleRows = await buildModeGraphVisibleRankRows(
			langs.targetLanguageId,
			assumedRank,
			vocabSize,
		)
		const build = await resolveVocabBuildSettings()
		const { bandRows, clozableWordIds } = await loadBuildActiveBandContext({
			userId: sessionUserId,
			languageId: langs.targetLanguageId,
			assumedRank,
			vocabSize,
			graphRows: graphVisibleRows,
			frontierBandMax: build.frontierBandMax,
		})

		const byRank = (a: BuildModeActiveBandRow, b: BuildModeActiveBandRow) =>
			a.effectiveRank !== b.effectiveRank
				? a.effectiveRank - b.effectiveRank
				: a.wordId.localeCompare(b.wordId)

		const workingIds = bandRows
			.filter(
				(r) => clozableWordIds.has(r.wordId) && isWorkingSetMember(r, build.confidenceCriterion),
			)
			.sort(byRank)
			.map((r) => r.wordId)

		const introIds = bandRows
			.filter((r) => clozableWordIds.has(r.wordId) && isIntroCandidate(r))
			.sort(byRank)
			.map((r) => r.wordId)

		const workingSetThinPreview = workingIds.length < build.workingSetSize
		const introBacklogPreview = introIds.length
		const introChunkGateActivePreview = introBacklogPreview > 0 && workingSetThinPreview

		const wordSelect = {
			id: true,
			lemma: true,
			effectiveRank: true,
			testSentenceIds: true,
		} as const

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

		const nextQ = sessionAnswers.length + 1
		const vocabMode = session.vocabMode ?? "BUILD"

		const columnOrderedUpcoming = parseColumnFocusWordIds(session.columnFocusWordIds)
		const testedForColumnPreview = new Set(testedInSession)
		if (peekWordId) testedForColumnPreview.add(peekWordId)
		const columnFocusActiveAfterSubmit = columnFocusPendingFirstPass(
			columnOrderedUpcoming,
			testedForColumnPreview,
		)

		const nextQAfterSubmit = sessionAnswers.length + 2
		const nextAfterCorrect =
			vocabMode === "BUILD"
				? buildNextPickPreview({
						nextBuildQuestionNumber: nextQAfterSubmit,
						build,
						columnFocusActive: columnFocusActiveAfterSubmit,
						workingSetThin: workingSetThinPreview,
					})
				: null
		const nextAfterWrong =
			vocabMode === "BUILD"
				? buildNextPickPreview({
						nextBuildQuestionNumber: nextQAfterSubmit,
						build,
						columnFocusActive: columnFocusActiveAfterSubmit,
						workingSetThin: workingSetThinPreview,
					})
				: null

		const bandWordIds = [...new Set(bandRows.map((r) => r.wordId))]
		const [wordsForBand, peekWordRow] = await Promise.all([
			bandWordIds.length > 0
				? prisma.word.findMany({
						where: { languageId: langs.targetLanguageId, id: { in: bandWordIds } },
						select: wordSelect,
					})
				: Promise.resolve(
						[] as Array<{
							id: string
							lemma: string
							effectiveRank: number
							testSentenceIds: string[]
						}>,
					),
			peekWordId
				? prisma.word.findUnique({
						where: { id: peekWordId },
						select: wordSelect,
					})
				: Promise.resolve(null),
		])

		const wordById = new Map(wordsForBand.map((w) => [w.id, w]))

		const allWordIds = [...new Set([...bandWordIds, ...(peekWordRow ? [peekWordRow.id] : [])])]

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
			const conf = k?.confidence
			return {
				wordId: w.id,
				lemma: w.lemma,
				rank: w.effectiveRank,
				testedInSession: testedForPanel.has(w.id),
				hasSentences: w.testSentenceIds.length > 0,
				confidence: typeof conf === "number" ? conf : 0,
				timesTested: k?.timesTested ?? 0,
				streak: k?.streak ?? 0,
				lastTestedAt: k?.lastTestedAt?.toISOString() ?? null,
			}
		}

		const activeBandPreview = bandRows
			.filter((r) => clozableWordIds.has(r.wordId))
			.slice(0, 40)
			.map((r) => wordById.get(r.wordId))
			.filter((w): w is NonNullable<typeof w> => !!w)
			.map(mapWord)

		const mapIdsToWords = (ids: string[], cap: number): UpcomingWord[] => {
			const out: UpcomingWord[] = []
			for (const id of ids) {
				if (out.length >= cap) break
				const w = wordById.get(id)
				if (w) out.push(mapWord(w))
			}
			return out
		}

		return c.json({
			vocabMode,
			questionNumber: nextQ,
			activeBand: activeBandPreview,
			workingSet: mapIdsToWords(workingIds, 20),
			intros: mapIdsToWords(introIds, 20),
			current: peekWordRow ? mapWord(peekWordRow) : null,
			generatedAt: new Date().toISOString(),
			bandLemmaCount: bandRows.length,
			clozableInBand: clozableWordIds.size,
			workingSetCount: workingIds.length,
			workingSetThin: workingSetThinPreview,
			introChunkGateActive: introChunkGateActivePreview,
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
