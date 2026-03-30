import { type Prisma, prisma } from "@nwords/db"

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
	  }
	| { ok: false; reason: "no_test_sentences" | "no_blank_position" | "no_hint_available" }

/**
 * Find a Tatoeba-linked sentence in `nativeLanguageId` for this target-language sentence.
 * Checks both directions (original/translated is not a language direction).
 */
export async function findNativeParallelSentence(
	targetSentenceId: string,
	nativeLanguageId: string,
): Promise<{ id: string; text: string; languageId: string } | null> {
	const row = await prisma.sentenceTranslation.findFirst({
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
	})

	if (!row) return null

	if (row.originalSentenceId === targetSentenceId) {
		return row.translatedSentence
	}
	return row.originalSentence
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

	for (const c of candidates) {
		const parallel = await findNativeParallelSentence(
			c.targetSentenceId,
			params.nativeLanguageId,
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
