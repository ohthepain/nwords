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

export type HintSource = "parallel" | "definition"

export type ClozeResolution =
	| {
			ok: true
			wordId: string
			lemma: string
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
			where: { id: { in: testSentenceIds }, languageId: targetLanguageId },
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
 * Translate a target-language word to the user's native language via English-gloss pivot.
 * Returns the best native lemma or `null` when no overlap is found.
 *
 * Strategy: extract content words (≥3 chars) from the target word's Kaikki glosses, then find
 * native-language words whose definitions share those content words. Prefers the most-common
 * native word (lowest rank) with the most overlapping tokens.
 *
 * Example: Vietnamese "chó" → glosses ["dog"] → English content words {"dog"}
 *   → Danish word with gloss containing "dog" → "hund" (rank 832)
 */
async function translateViaGlossPivot(
	definitions: unknown,
	nativeLanguageId: string,
): Promise<string | null> {
	if (!Array.isArray(definitions) || definitions.length === 0) return null

	// Extract meaningful content words from the target word's FIRST English gloss only.
	// Using only the first gloss avoids polluting the pivot with unrelated senses for polysemous words.
	// Filter out short function words (to, a, an, of, the, be, …) by requiring length ≥ 4.
	const firstGloss = definitions.find((d): d is string => typeof d === "string" && d.trim().length > 0)
	if (!firstGloss) return null

	const contentWords = new Set<string>()
	for (const tok of tokensForScoring(firstGloss)) {
		if (tok.length >= 4) contentWords.add(tok)
	}

	if (contentWords.size === 0) return null
	const tokens = [...contentWords]

	// Tier 1: direct lemma match — if a native word's lemma IS one of the content words,
	// that's the best possible match (e.g. Vietnamese "chó" → gloss "dog" → English lemma "dog").
	const lemmaMatch = await prisma.$queryRaw<
		Array<{ lemma: string; rank: number }>
	>`
		SELECT w."lemma", w."rank"
		FROM "word" w
		WHERE w."languageId" = ${nativeLanguageId}::uuid
		  AND w."rank" > 0
		  AND w."lemma" = ANY(${tokens}::text[])
		ORDER BY w."rank" ASC
		LIMIT 1
	`

	if (lemmaMatch.length > 0) {
		return lemmaMatch[0].lemma
	}

	// Tier 2: definition overlap — find native words whose English definitions share content words
	// with the target word's glosses. Rank by overlap count then frequency.
	const defMatch = await prisma.$queryRaw<
		Array<{ lemma: string; rank: number; overlap: number }>
	>`
		SELECT w."lemma", w."rank",
		  (
		    SELECT count(DISTINCT t.tok)::int
		    FROM unnest(${tokens}::text[]) AS t(tok),
		         jsonb_array_elements_text(w."definitions") AS def
		    WHERE lower(def) LIKE '%' || t.tok || '%'
		  ) AS overlap
		FROM "word" w
		WHERE w."languageId" = ${nativeLanguageId}::uuid
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
			definitions: true,
			testSentenceIds: true,
		},
	})

	if (!word || word.testSentenceIds.length === 0) {
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

	// Inline hint: target word translated to native language via English-gloss pivot (fire-and-forget).
	const inlineHint = await translateViaGlossPivot(word.definitions, params.nativeLanguageId)

	for (const c of candidates) {
		const parallel = await findBestNativeParallelForSense(
			c.targetSentenceId,
			params.nativeLanguageId,
			word.definitions,
		)
		if (parallel) {
			return {
				ok: true,
				wordId: word.id,
				lemma: word.lemma,
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
		return {
			ok: true,
			wordId: word.id,
			lemma: word.lemma,
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

/** Uniform random word with curated test sentences; `excludeWordIds` soft-ignored if it would empty the pool. */
export async function pickRandomWordIdForCloze(
	targetLanguageId: string,
	excludeWordIds: string[],
): Promise<string | null> {
	const baseWhere: Prisma.WordWhereInput = {
		languageId: targetLanguageId,
		isOffensive: false,
		testSentenceIds: { isEmpty: false },
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

	const count = await prisma.word.count({ where })
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
