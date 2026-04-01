import { prisma } from "@nwords/db"

/** Split on non-letters/numbers (Unicode). */
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/gu

export function tokenizeSentenceText(text: string): string[] {
	return text
		.toLowerCase()
		.split(TOKEN_SPLIT)
		.filter((t) => t.length > 0)
}

export function scoreSentenceQuality(
	text: string,
	matchedDistinctLemmas: number,
	tokenCount: number,
): { score: number; isCandidate: boolean } {
	const len = text.length
	if (len < 18 || len > 350) return { score: 0, isCandidate: false }
	if (tokenCount < 3 || tokenCount > 24) return { score: 0, isCandidate: false }
	if (matchedDistinctLemmas < 1) return { score: 0, isCandidate: false }

	const coverage = Math.min(1, matchedDistinctLemmas / 4)
	const lengthFit = 1 - Math.min(1, Math.abs(tokenCount - 9) / 18)
	const score = Math.round(1000 * coverage * lengthFit) / 1000
	return { score, isCandidate: score >= 0.2 }
}

export type LinkingLinkBatchProgress = {
	kind: "link_batch"
	batchSentenceCount: number
	sentencesProcessed: number
	linksCreated: number
	candidates: number
}

export type LinkingAssignTestProgress = {
	kind: "assign_test_sentences"
	wordsProcessed: number
	wordsTotal: number
}

export type LinkingProgressEvent = LinkingLinkBatchProgress | LinkingAssignTestProgress

/**
 * Token-match sentences to dictionary lemmas, score usefulness for tests, then pick top sentences per word.
 */
export async function linkSentencesAndAssignTests(
	languageId: string,
	onProgress: (event: LinkingProgressEvent) => Promise<void>,
): Promise<{ sentencesProcessed: number; linksCreated: number; candidates: number }> {
	const LINK_BATCH = 100
	let sentencesProcessed = 0
	let linksCreated = 0
	let candidates = 0

	// Tatoeba creates sentences with `testQualityScore: null`. Only those need linking.
	// If a batch yields zero `SentenceWord` rows (e.g. dictionary empty / no token matches),
	// we must still advance: without `testQualityScore: null` the same rows would match forever.
	while (true) {
		const sentences = await prisma.sentence.findMany({
			where: {
				languageId,
				sentenceWords: { none: {} },
				testQualityScore: null,
			},
			select: { id: true, text: true },
			take: LINK_BATCH,
		})
		if (sentences.length === 0) break

		const tokenBySentence = new Map<string, string[]>()
		const allTokens = new Set<string>()
		for (const s of sentences) {
			const tok = tokenizeSentenceText(s.text)
			tokenBySentence.set(s.id, tok)
			for (const t of tok) allTokens.add(t)
		}

		const words = await prisma.word.findMany({
			where: {
				languageId,
				lemma: { in: [...allTokens] },
				isOffensive: false,
				isAbbreviation: false,
			},
			select: { id: true, lemma: true },
		})

		const lemmaToWordIds = new Map<string, string[]>()
		for (const w of words) {
			const arr = lemmaToWordIds.get(w.lemma) ?? []
			arr.push(w.id)
			lemmaToWordIds.set(w.lemma, arr)
		}

		const sentenceWordRows: Array<{ sentenceId: string; wordId: string; position: number }> = []

		for (const s of sentences) {
			const tokens = tokenBySentence.get(s.id) ?? []
			const matchedLemmaIds = new Set<string>()
			let position = 0
			for (const t of tokens) {
				const wids = lemmaToWordIds.get(t)
				// Same surface form can map to multiple Word rows (different POS / senses). Without a tagger
				// we cannot tell which applies, so linking all of them attaches the wrong sense (e.g. noun
				// "vik" vs verb "vik") and English parallels disagree with the blank. Skip ambiguous tokens.
				if (wids?.length === 1) {
					const [wid] = wids
					matchedLemmaIds.add(wid)
					sentenceWordRows.push({ sentenceId: s.id, wordId: wid, position })
				}
				position++
			}

			const { score, isCandidate } = scoreSentenceQuality(
				s.text,
				matchedLemmaIds.size,
				tokens.length,
			)

			await prisma.sentence.update({
				where: { id: s.id },
				data: { testQualityScore: score, isTestCandidate: isCandidate },
			})
			if (isCandidate) candidates++
			sentencesProcessed++
		}

		if (sentenceWordRows.length > 0) {
			const res = await prisma.sentenceWord.createMany({
				data: sentenceWordRows,
				skipDuplicates: true,
			})
			linksCreated += res.count
		}

		await onProgress({
			kind: "link_batch",
			batchSentenceCount: sentences.length,
			sentencesProcessed,
			linksCreated,
			candidates,
		})
	}

	await assignTopTestSentencesForLanguage(languageId, onProgress)

	return { sentencesProcessed, linksCreated, candidates }
}

const MAX_WORDS_TO_ASSIGN = 50_000

const ASSIGN_PROGRESS_EVERY = 200

async function assignTopTestSentencesForLanguage(
	languageId: string,
	onProgress: (event: LinkingProgressEvent) => Promise<void>,
): Promise<void> {
	const words = await prisma.word.findMany({
		where: { languageId, isAbbreviation: false },
		select: { id: true },
		take: MAX_WORDS_TO_ASSIGN,
	})

	const wordsTotal = words.length
	await onProgress({ kind: "assign_test_sentences", wordsProcessed: 0, wordsTotal })

	for (let i = 0; i < words.length; i++) {
		const wordId = words[i].id
		const links = await prisma.sentenceWord.findMany({
			where: {
				wordId,
				sentence: { isTestCandidate: true },
			},
			select: {
				sentenceId: true,
				sentence: { select: { testQualityScore: true } },
			},
			take: 60,
		})

		links.sort((a, b) => (b.sentence.testQualityScore ?? 0) - (a.sentence.testQualityScore ?? 0))
		const testSentenceIds = [...new Set(links.slice(0, 8).map((l) => l.sentenceId))]

		if (testSentenceIds.length > 0) {
			await prisma.word.update({
				where: { id: wordId },
				data: { testSentenceIds },
			})
		}

		const done = i + 1
		if (done % ASSIGN_PROGRESS_EVERY === 0 || done === wordsTotal) {
			await onProgress({ kind: "assign_test_sentences", wordsProcessed: done, wordsTotal })
		}
	}
}
