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
		select: { pos: true, rank: true },
		orderBy: { rank: "asc" },
	})

	// Deduplicate by POS, keeping the lowest rank (most frequent) for each
	const seen = new Set<PartOfSpeech>()
	const result: Array<{ pos: PartOfSpeech; rank: number }> = []

	for (const w of words) {
		if (!seen.has(w.pos)) {
			seen.add(w.pos)
			result.push({ pos: w.pos, rank: w.rank })
		}
	}

	return result
}
