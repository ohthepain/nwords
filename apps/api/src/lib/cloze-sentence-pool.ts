import { prisma } from "@nwords/db"

const LINKED_POOL_TAKE = 80

/**
 * Sentence IDs linked via `SentenceWord` for this word, target-language sentences only,
 * not marked for removal, best `testQualityScore` first (same spirit as `getWordSentences`).
 */
export async function linkedSentenceIdsForClozePool(
	wordId: string,
	languageId: string,
	take = LINKED_POOL_TAKE,
): Promise<string[]> {
	const rows = await prisma.sentenceWord.findMany({
		where: {
			wordId,
			sentence: {
				languageId,
				markedForRemoval: false,
			},
		},
		orderBy: { sentence: { testQualityScore: { sort: "desc", nulls: "last" } } },
		select: { sentenceId: true },
		take,
	})
	return rows.map((r) => r.sentenceId)
}
