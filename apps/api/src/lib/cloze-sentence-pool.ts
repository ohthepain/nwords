import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"

const LINKED_POOL_TAKE = 80

/**
 * Predicate for words that can yield cloze candidates via `loadClozeCandidates`: non-empty
 * curated `testSentenceIds` and/or at least one `SentenceWord` in the target language (not
 * marked for removal). Matches `resolveClozeWithHint` / `linkedSentenceIdsForClozePool`.
 */
export function prismaWhereWordHasResolvableClozeMaterial(
	targetLanguageId: string,
): Prisma.WordWhereInput {
	return {
		isOffensive: false,
		isAbbreviation: false,
		isTestable: true,
		OR: [
			{ testSentenceIds: { isEmpty: false } },
			{
				sentenceWords: {
					some: {
						sentence: {
							languageId: targetLanguageId,
							markedForRemoval: false,
						},
					},
				},
			},
		],
	}
}

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
