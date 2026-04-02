import { type Prisma, prisma } from "@nwords/db"

/** Same rules as `sentence-link` tokenization (for gloss ↔ parallel alignment). */
const SCORE_SPLIT = /[^\p{L}\p{N}]+/gu

function tokensForScoring(text: string): string[] {
	return text
		.toLowerCase()
		.split(SCORE_SPLIT)
		.filter((t) => t.length > 0)
}

/** Match word-token runs; same segmentation as `SentenceWord.position` from sentence linking. */
const WORD_RUN = /[\p{L}\p{N}]+/gu

/**
 * When picking a token **in the window**, skip high-frequency glue words so sense-based
 * scoring can prefer a content word if parallel token counts are misaligned. Do **not**
 * include prepositions like `before`/`after` — they are often the actual cloze answer
 * (e.g. Swedish *före* ↔ English *before*).
 */
const INLINE_HINT_STOPWORDS_EN = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"if",
	"so",
	"as",
	"at",
	"by",
	"for",
	"in",
	"is",
	"of",
	"on",
	"to",
	"no",
	"be",
	"do",
	"am",
	"are",
	"was",
	"were",
	"been",
	"being",
	"has",
	"had",
	"having",
	"does",
	"did",
	"doing",
	"done",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"must",
	"shall",
	"can",
	"there",
	"here",
	"then",
	"than",
	"too",
	"very",
	"just",
	"all",
	"any",
	"both",
	"each",
	"few",
	"more",
	"most",
	"some",
	"such",
	"only",
	"own",
	"into",
	"from",
	"with",
	"about",
	"against",
	"between",
	"through",
	"during",
	"above",
	"below",
	"under",
	"again",
	"once",
	"not",
	"nor",
	"yet",
	"ever",
	"even",
	"also",
])

/** For index-aligned fallback only: articles (never useful as the sole hint). */
const INLINE_HINT_ALIGNMENT_JUNK = new Set(["a", "an", "the"])

export type HintSource = "parallel" | "definition"

export type ClozeResolution =
	| {
			ok: true
			wordId: string
			lemma: string
			rank: number
			targetSentenceId: string
			targetSentenceText: string
			promptText: string
			hintText: string
			hintSentenceId: string | null
			hintSource: HintSource
			blankTokenIndex: number
			/** Target word translated to native language via English-gloss pivot (best-effort). */
			inlineHint: string | null
	  }
	| { ok: false; reason: "no_test_sentences" | "no_blank_position" | "no_hint_available" }

/** Tokens derived from Kaikki/Wiktionary gloss strings (often English) for sense alignment. */
function definitionSenseTokens(definitions: unknown): Set<string> {
	const out = new Set<string>()
	if (!Array.isArray(definitions)) return out
	for (const item of definitions) {
		if (typeof item !== "string" || !item.trim()) continue
		for (const tok of tokensForScoring(item)) {
			if (tok.length > 1) out.add(tok)
		}
	}
	return out
}

/** Prefer parallels whose English text overlaps the word sense in `definitions` (helps homograph Tatoeba links). */
function scoreParallelForSense(parallelText: string, senseTokens: Set<string>): number {
	if (senseTokens.size === 0) return 0
	const pTok = tokensForScoring(parallelText)
	const parallel = new Set(pTok)
	let score = 0
	for (const s of senseTokens) {
		if (parallel.has(s)) score += 3
	}
	// Stem-like substring matches: "fold" vs "folding", "bay" vs "bays"
	for (const s of senseTokens) {
		if (s.length < 4) continue
		for (const p of parallel) {
			if (p.length < 4) continue
			if (p.includes(s) || s.includes(p)) score += 1
		}
	}
	return score
}

/**
 * Tatoeba-linked sentences in `nativeLanguageId` for this target-language sentence (both directions).
 * When multiple links exist, pick the English line that best matches dictionary glosses for this sense.
 */
async function findBestNativeParallelForSense(
	targetSentenceId: string,
	nativeLanguageId: string,
	definitions: unknown,
): Promise<{ id: string; text: string; languageId: string } | null> {
	const rows = await prisma.sentenceTranslation.findMany({
		where: {
			OR: [
				{
					originalSentenceId: targetSentenceId,
					translatedSentence: { languageId: nativeLanguageId },
				},
				{
					translatedSentenceId: targetSentenceId,
					originalSentence: { languageId: nativeLanguageId },
				},
			],
		},
		include: {
			originalSentence: { select: { id: true, text: true, languageId: true } },
			translatedSentence: { select: { id: true, text: true, languageId: true } },
		},
		orderBy: { id: "asc" },
	})

	if (rows.length === 0) return null

	const sense = definitionSenseTokens(definitions)

	const mapped = rows.map((row) =>
		row.originalSentenceId === targetSentenceId ? row.translatedSentence : row.originalSentence,
	)

	let best = mapped[0]!
	let bestScore = scoreParallelForSense(best.text, sense)

	for (let i = 1; i < mapped.length; i++) {
		const par = mapped[i]!
		const sc = scoreParallelForSense(par.text, sense)
		if (sc > bestScore) {
			best = par
			bestScore = sc
		}
	}

	return best
}

export function buildClozePrompt(sentenceText: string, blankTokenIndex: number): string {
	let i = 0
	return sentenceText.replace(WORD_RUN, (raw) => {
		const cur = i++
		return cur === blankTokenIndex ? "____" : raw
	})
}

function firstDefinitionHint(definitions: unknown): string | null {
	if (!Array.isArray(definitions) || definitions.length === 0) return null
	const first = definitions[0]
	return typeof first === "string" && first.trim().length > 0 ? first.trim() : null
}

type ClozeCandidate = {
	targetSentenceId: string
	targetSentenceText: string
	position: number
}

async function loadClozeCandidates(
	wordId: string,
	targetLanguageId: string,
	testSentenceIds: string[],
): Promise<ClozeCandidate[]> {
	if (testSentenceIds.length === 0) return []

	const [sentenceWords, sentences] = await Promise.all([
		prisma.sentenceWord.findMany({
			where: { wordId, sentenceId: { in: testSentenceIds } },
			select: { sentenceId: true, position: true },
		}),
		prisma.sentence.findMany({
			where: {
				id: { in: testSentenceIds },
				languageId: targetLanguageId,
				markedForRemoval: false,
			},
			select: { id: true, text: true },
		}),
	])

	const posBySid = new Map(sentenceWords.map((sw) => [sw.sentenceId, sw.position]))
	const textBySid = new Map(sentences.map((s) => [s.id, s.text]))

	const out: ClozeCandidate[] = []
	for (const sid of testSentenceIds) {
		const position = posBySid.get(sid)
		const text = textBySid.get(sid)
		if (position === undefined || text === undefined) continue
		out.push({ targetSentenceId: sid, targetSentenceText: text, position })
	}

	return out
}

/**
 * Kaikki entries for inflected forms often have definitions like "past tense of vara" or
 * "definite form of man" instead of the actual meaning. Detect these and extract the
 * referenced lemma so we can look up its real definitions instead.
 */
const FORM_OF_RE =
	/^(?:present|past|future|imperative|indicative|subjunctive|infinitive|gerund|participle|superlative|comparative|singular|plural|nominative|genitive|dative|accusative|ablative|definite|indefinite|conditional|preterite|imperfect)[\s,;/]+(?:(?:tense|indicative|subjunctive|form|singular|plural|active|passive|simple|continuous|perfect)\s+)*(?:of\s+)(.+)/i

function extractFormOfLemma(gloss: string): string | null {
	const m = gloss.trim().match(FORM_OF_RE)
	if (!m) return null
	// The referenced lemma may have trailing context: "vara; am/is/are" → just take the first word-run
	const ref = m[1].trim()
	const firstWord = ref.match(/^[\p{L}\p{N}]+/u)
	return firstWord ? firstWord[0].toLowerCase() : null
}

/** Also detect "inflection of X:" which Kaikki uses for Swedish/Finnish etc. */
const INFLECTION_OF_RE = /^inflection of\s+([\p{L}\p{N}]+)/iu

function extractInflectionOfLemma(gloss: string): string | null {
	const m = gloss.trim().match(INFLECTION_OF_RE)
	return m ? m[1].toLowerCase() : null
}

/**
 * Word-token runs in order; must match `buildClozePrompt` / `SentenceWord.position` indexing.
 */
function wordRunsInOrder(text: string): string[] {
	return text.match(WORD_RUN) ?? []
}

/** How far we search left/right when token counts differ (e.g. "That's" → That + s). */
const PARALLEL_HINT_ALIGN_WINDOW = 4

/**
 * Use the native-language parallel token at the same index as the blank when it is not a
 * blocked function word; used when we have no expanded sense tokens to score.
 */
function tryParallelAlignedInlineHint(
	parallelText: string,
	blankTokenIndex: number,
): string | null {
	const runs = wordRunsInOrder(parallelText)
	if (blankTokenIndex < 0 || blankTokenIndex >= runs.length) return null
	const raw = runs[blankTokenIndex]!
	const tok = raw.toLowerCase()
	if (tok.length < 2) return null
	if (INLINE_HINT_ALIGNMENT_JUNK.has(tok)) return null
	return tok
}

/** Bounded Levenshtein: returns whether distance(a, b) ≤ max. */
function withinEditDistance(a: string, b: string, max: number): boolean {
	const m = a.length
	const n = b.length
	if (m === 0) return n <= max
	if (n === 0) return m <= max
	if (Math.abs(m - n) > max) return false

	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
	for (let i = 0; i <= m; i++) dp[i]![0] = i
	for (let j = 0; j <= n; j++) dp[0]![j] = j

	for (let i = 1; i <= m; i++) {
		let rowMin = Number.POSITIVE_INFINITY
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			const v = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost)
			dp[i]![j] = v
			if (v < rowMin) rowMin = v
		}
		if (rowMin > max) return false
	}
	return dp[m]![n]! <= max
}

function scoreParallelTokAgainstSense(tok: string, sense: Set<string>): number {
	if (sense.size === 0) return 0
	const h = tok.toLowerCase()
	let best = 0
	for (const s of sense) {
		if (s === h) return 100
		if (s.length >= 3 && h.length >= 3 && (h.includes(s) || s.includes(h))) {
			best = Math.max(best, 55)
			continue
		}
		if (s.length >= 4 && h.length >= 4) {
			if (withinEditDistance(h, s, 1)) best = Math.max(best, 45)
			else if (withinEditDistance(h, s, 2)) best = Math.max(best, 28)
		}
	}
	return best
}

/**
 * Gloss string after following form-of / inflection-of to the root lemma (same as gloss pivot).
 */
async function resolveGlossStringForPivot(
	definitions: unknown,
	targetLanguageId: string,
): Promise<string | null> {
	if (!Array.isArray(definitions) || definitions.length === 0) return null
	const firstGloss = definitions.find(
		(d): d is string => typeof d === "string" && d.trim().length > 0,
	)
	if (!firstGloss) return null

	let glossToUse = firstGloss
	const formOfLemma = extractFormOfLemma(firstGloss) ?? extractInflectionOfLemma(firstGloss)
	if (formOfLemma) {
		const rootWord = await prisma.word.findFirst({
			where: {
				lemma: formOfLemma,
				languageId: targetLanguageId,
				isAbbreviation: false,
			},
			select: { definitions: true },
			orderBy: { rank: "asc" },
		})
		if (rootWord && Array.isArray(rootWord.definitions)) {
			const realDef = (rootWord.definitions as string[]).find(
				(d) =>
					typeof d === "string" &&
					d.trim().length > 0 &&
					!extractFormOfLemma(d) &&
					!extractInflectionOfLemma(d),
			)
			if (realDef) glossToUse = realDef
		}
	}
	return glossToUse
}

async function expandedSenseTokensForInlineHint(
	definitions: unknown,
	targetLanguageId: string,
): Promise<Set<string>> {
	const out = definitionSenseTokens(definitions)
	const gloss = await resolveGlossStringForPivot(definitions, targetLanguageId)
	if (gloss) {
		for (const t of tokensForScoring(gloss)) {
			if (t.length >= 2) out.add(t)
		}
	}
	return out
}

/**
 * Pick a parallel hint token near the blank index that matches dictionary sense (handles
 * extra/missing tokens from apostrophes and phrasing). Falls back to pivot when nothing scores.
 */
async function tryParallelInlineHintWithWindow(
	parallelText: string,
	blankTokenIndex: number,
	definitions: unknown,
	targetLanguageId: string,
): Promise<string | null> {
	const runs = wordRunsInOrder(parallelText)
	if (runs.length === 0) return null

	const sense = await expandedSenseTokensForInlineHint(definitions, targetLanguageId)
	if (sense.size === 0) {
		return tryParallelAlignedInlineHint(parallelText, blankTokenIndex)
	}

	const from = Math.max(0, blankTokenIndex - PARALLEL_HINT_ALIGN_WINDOW)
	const to = Math.min(runs.length - 1, blankTokenIndex + PARALLEL_HINT_ALIGN_WINDOW)

	let bestTok: string | null = null
	let bestTotal = -1
	let bestIdx = blankTokenIndex

	for (let i = from; i <= to; i++) {
		const raw = runs[i]!
		const tok = raw.toLowerCase()
		if (tok.length < 2) continue
		if (INLINE_HINT_STOPWORDS_EN.has(tok)) continue

		const matchScore = scoreParallelTokAgainstSense(tok, sense)
		if (matchScore < 28) continue

		const closeness = PARALLEL_HINT_ALIGN_WINDOW - Math.abs(i - blankTokenIndex) + 1
		const total = matchScore * 10 + closeness
		const closer = Math.abs(i - blankTokenIndex) < Math.abs(bestIdx - blankTokenIndex)

		if (total > bestTotal || (total === bestTotal && closer)) {
			bestTotal = total
			bestTok = tok
			bestIdx = i
		}
	}

	if (bestTok == null) {
		const alignedRaw =
			blankTokenIndex >= 0 && blankTokenIndex < runs.length
				? runs[blankTokenIndex]!.toLowerCase()
				: null
		if (
			alignedRaw != null &&
			alignedRaw.length >= 2 &&
			!INLINE_HINT_ALIGNMENT_JUNK.has(alignedRaw)
		) {
			bestTok = alignedRaw
		}
	}

	return bestTok
}

/**
 * Translate a target-language word to the user's native language via English-gloss pivot.
 * Returns the best native lemma or `null` when no overlap is found.
 *
 * Strategy: extract content words (≥4 chars) from the target word's Kaikki glosses, then find
 * native-language words whose definitions share those content words. Prefers the most-common
 * native word (lowest rank) with the most overlapping tokens.
 *
 * For "form-of" definitions (e.g. "past tense of vara"), follows the reference back to the
 * root lemma and uses its real definitions for the pivot.
 */
async function translateViaGlossPivot(
	definitions: unknown,
	nativeLanguageId: string,
	targetLanguageId: string,
): Promise<string | null> {
	const glossToUse = await resolveGlossStringForPivot(definitions, targetLanguageId)
	if (!glossToUse) return null

	// Grammatical terms that should never be used as inline hints — safety net beyond form-of detection.
	const GRAMMAR_BLOCKLIST = new Set([
		"past",
		"present",
		"future",
		"tense",
		"form",
		"plural",
		"singular",
		"definite",
		"indefinite",
		"indicative",
		"subjunctive",
		"imperative",
		"conditional",
		"infinitive",
		"gerund",
		"participle",
		"superlative",
		"comparative",
		"nominative",
		"genitive",
		"dative",
		"accusative",
		"ablative",
		"preterite",
		"imperfect",
		"active",
		"passive",
		"perfect",
		"continuous",
		"simple",
		"progressive",
		"inflection",
	])

	// Extract meaningful content words — filter out short function words by requiring length ≥ 4
	// and grammatical descriptors.
	const contentWords = new Set<string>()
	for (const tok of tokensForScoring(glossToUse)) {
		if (tok.length >= 4 && !GRAMMAR_BLOCKLIST.has(tok)) contentWords.add(tok)
	}

	if (contentWords.size === 0) return null

	// Order content lemmas by first appearance in the gloss so "child" wins over "person"
	// when the gloss reads "young child of someone" (Tier 1 used to pick by English frequency only).
	const tokensOrdered: string[] = []
	const seenTok = new Set<string>()
	for (const tok of tokensForScoring(glossToUse)) {
		if (tok.length < 4 || GRAMMAR_BLOCKLIST.has(tok) || !contentWords.has(tok) || seenTok.has(tok))
			continue
		seenTok.add(tok)
		tokensOrdered.push(tok)
	}
	const tokens = tokensOrdered

	// Tier 1: direct lemma match — prefer gloss order, then frequency within the same lemma string.
	for (const tok of tokensOrdered) {
		const hit = await prisma.word.findFirst({
			where: {
				languageId: nativeLanguageId,
				rank: { gt: 0 },
				lemma: tok,
				isAbbreviation: false,
			},
			orderBy: { rank: "asc" },
			select: { lemma: true },
		})
		if (hit) return hit.lemma
	}

	// Tier 2: definition overlap — find native words whose English definitions share content words
	// with the target word's glosses. Rank by overlap count then frequency.
	const defMatch = await prisma.$queryRaw<Array<{ lemma: string; rank: number; overlap: number }>>`
		SELECT w."lemma", w."rank",
		  (
		    SELECT count(DISTINCT t.tok)::int
		    FROM unnest(${tokens}::text[]) AS t(tok),
		         jsonb_array_elements_text(w."definitions") AS def
		    WHERE lower(def) LIKE '%' || t.tok || '%'
		  ) AS overlap
		FROM "word" w
		WHERE w."languageId" = ${nativeLanguageId}::uuid
		  AND w."isAbbreviation" = false
		  AND w."rank" > 0
		  AND w."rank" <= 10000
		  AND EXISTS (
		    SELECT 1
		    FROM unnest(${tokens}::text[]) AS t(tok),
		         jsonb_array_elements_text(w."definitions") AS def
		    WHERE lower(def) LIKE '%' || t.tok || '%'
		  )
		ORDER BY overlap DESC, w."rank" ASC
		LIMIT 1
	`

	if (defMatch.length > 0) {
		return defMatch[0].lemma
	}

	return null
}

/**
 * Prefer a native parallel for any curated test sentence; otherwise a dictionary gloss as hint.
 */
export async function resolveClozeWithHint(params: {
	wordId: string
	nativeLanguageId: string
	targetLanguageId: string
}): Promise<ClozeResolution> {
	const word = await prisma.word.findFirst({
		where: {
			id: params.wordId,
			languageId: params.targetLanguageId,
		},
		select: {
			id: true,
			lemma: true,
			rank: true,
			definitions: true,
			testSentenceIds: true,
			isAbbreviation: true,
		},
	})

	if (!word || word.isAbbreviation || word.testSentenceIds.length === 0) {
		return { ok: false, reason: "no_test_sentences" }
	}

	const candidates = await loadClozeCandidates(
		word.id,
		params.targetLanguageId,
		word.testSentenceIds,
	)

	if (candidates.length === 0) {
		return { ok: false, reason: "no_blank_position" }
	}

	// Shuffle candidates so we don't always use the same sentence for a word
	for (let i = candidates.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
	}

	const glossPivotHint = (): Promise<string | null> =>
		translateViaGlossPivot(word.definitions, params.nativeLanguageId, params.targetLanguageId)

	for (const c of candidates) {
		const parallel = await findBestNativeParallelForSense(
			c.targetSentenceId,
			params.nativeLanguageId,
			word.definitions,
		)
		if (parallel) {
			const parallelTok = await tryParallelInlineHintWithWindow(
				parallel.text,
				c.position,
				word.definitions,
				params.targetLanguageId,
			)
			const pivotFallback = parallelTok == null ? await glossPivotHint() : null
			const inlineHint = parallelTok ?? pivotFallback
			return {
				ok: true,
				wordId: word.id,
				lemma: word.lemma,
				rank: word.rank,
				targetSentenceId: c.targetSentenceId,
				targetSentenceText: c.targetSentenceText,
				promptText: buildClozePrompt(c.targetSentenceText, c.position),
				hintText: parallel.text,
				hintSentenceId: parallel.id,
				hintSource: "parallel",
				blankTokenIndex: c.position,
				inlineHint,
			}
		}
	}

	const gloss = firstDefinitionHint(word.definitions)
	if (gloss) {
		const c = candidates[0]
		const inlineHint = await glossPivotHint()
		return {
			ok: true,
			wordId: word.id,
			lemma: word.lemma,
			rank: word.rank,
			targetSentenceId: c.targetSentenceId,
			targetSentenceText: c.targetSentenceText,
			promptText: buildClozePrompt(c.targetSentenceText, c.position),
			hintText: gloss,
			hintSentenceId: null,
			hintSource: "definition",
			blankTokenIndex: c.position,
			inlineHint,
		}
	}

	return { ok: false, reason: "no_hint_available" }
}

/**
 * Random word with curated test sentences within a frequency rank range.
 * `excludeWordIds` soft-ignored if it would empty the pool.
 * `rankRange` constrains to words between `min` and `max` rank (inclusive);
 * falls back to unconstrained if the range has no eligible words.
 */
export async function pickRandomWordIdForCloze(
	targetLanguageId: string,
	excludeWordIds: string[],
	rankRange?: { min: number; max: number },
): Promise<string | null> {
	const baseWhere: Prisma.WordWhereInput = {
		languageId: targetLanguageId,
		isOffensive: false,
		isAbbreviation: false,
		testSentenceIds: { isEmpty: false },
		...(rankRange ? { rank: { gte: rankRange.min, lte: rankRange.max } } : { rank: { gt: 0 } }),
	}

	let where: Prisma.WordWhereInput = baseWhere

	if (excludeWordIds.length > 0) {
		const withExclude: Prisma.WordWhereInput = {
			...baseWhere,
			id: { notIn: excludeWordIds },
		}
		const n = await prisma.word.count({ where: withExclude })
		if (n > 0) where = withExclude
	}

	let count = await prisma.word.count({ where })

	// Fall back to any ranked word if the range is empty (sparse frequency data).
	if (count === 0 && rankRange) {
		const fallbackWhere: Prisma.WordWhereInput = {
			languageId: targetLanguageId,
			isOffensive: false,
			isAbbreviation: false,
			testSentenceIds: { isEmpty: false },
			rank: { gt: 0 },
		}
		count = await prisma.word.count({ where: fallbackWhere })
		if (count > 0) where = fallbackWhere
	}

	if (count === 0) return null

	const skip = Math.floor(Math.random() * count)
	const word = await prisma.word.findFirst({
		where,
		select: { id: true },
		orderBy: { id: "asc" },
		skip,
	})

	return word?.id ?? null
}

/**
 * Pick a word near a target rank for assessment binary search.
 * Finds the closest word with test sentences at or above the target rank.
 */
export async function pickWordNearRank(
	targetLanguageId: string,
	targetRank: number,
	excludeWordIds: string[],
): Promise<{ wordId: string; rank: number } | null> {
	const baseWhere: Prisma.WordWhereInput = {
		languageId: targetLanguageId,
		isOffensive: false,
		isAbbreviation: false,
		testSentenceIds: { isEmpty: false },
		rank: { gte: Math.max(1, targetRank - 25), lte: targetRank + 25 },
		...(excludeWordIds.length > 0 ? { id: { notIn: excludeWordIds } } : {}),
	}

	const word = await prisma.word.findFirst({
		where: baseWhere,
		select: { id: true, rank: true },
		orderBy: { rank: "asc" },
	})

	if (word) return { wordId: word.id, rank: word.rank }

	// Widen search if nothing in the ±25 range
	const wider = await prisma.word.findFirst({
		where: {
			languageId: targetLanguageId,
			isOffensive: false,
			isAbbreviation: false,
			testSentenceIds: { isEmpty: false },
			rank: { gte: Math.max(1, targetRank - 100), lte: targetRank + 100 },
			...(excludeWordIds.length > 0 ? { id: { notIn: excludeWordIds } } : {}),
		},
		select: { id: true, rank: true },
		orderBy: { rank: "asc" },
	})

	return wider ? { wordId: wider.id, rank: wider.rank } : null
}
