import { type PartOfSpeech, prisma } from "@nwords/db"

/**
 * Look up the POS of a user's typed answer in the target language.
 *
 * Checks both `Word.lemma` and `WordForm.form` tables, then returns
 * distinct POS values ordered by word rank (lowest rank = most frequent first).
 *
 * Returns an empty array when the word is not found in the database
 * (i.e. the user typed gibberish or an unknown word).
 */
export async function lookupUserAnswerPos(
	userAnswer: string,
	targetLanguageId: string,
): Promise<Array<{ pos: PartOfSpeech; rank: number }>> {
	const normalized = userAnswer.trim().toLowerCase()
	if (!normalized) return []

	const words = await prisma.word.findMany({
		where: {
			languageId: targetLanguageId,
			OR: [{ lemma: normalized }, { forms: { some: { form: normalized } } }],
		},
		select: { pos: true, effectiveRank: true },
		orderBy: { effectiveRank: "asc" },
	})

	// Deduplicate by POS, keeping the lowest rank (most frequent) for each
	const seen = new Set<PartOfSpeech>()
	const result: Array<{ pos: PartOfSpeech; rank: number }> = []

	for (const w of words) {
		if (!seen.has(w.pos)) {
			seen.add(w.pos)
			result.push({ pos: w.pos, rank: w.effectiveRank })
		}
	}

	return result
}

/** Dictionary entries matching a typed cloze answer (lemma or surface form), best rank first. */
export async function lookupUserAnswerWords(
	userAnswer: string,
	targetLanguageId: string,
): Promise<Array<{ id: string; lemma: string; rank: number }>> {
	const normalized = userAnswer.trim().toLowerCase()
	if (!normalized) return []

	const words = await prisma.word.findMany({
		where: {
			languageId: targetLanguageId,
			OR: [{ lemma: normalized }, { forms: { some: { form: normalized } } }],
		},
		select: { id: true, lemma: true, effectiveRank: true },
		orderBy: { effectiveRank: "asc" },
	})

	const seen = new Set<string>()
	const result: Array<{ id: string; lemma: string; rank: number }> = []
	for (const w of words) {
		if (!seen.has(w.id)) {
			seen.add(w.id)
			result.push({ id: w.id, lemma: w.lemma, rank: w.effectiveRank })
		}
	}
	return result
}
