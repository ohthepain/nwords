import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { countClozeWordRuns } from "./cloze-compositionality"

const LINKED_POOL_TAKE = 80
/** Oversample before in-memory ordering so shorter sentences can win ties on priority. */
const LINKED_POOL_FETCH = 320

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
 * not marked for removal. Ordered by `aiClozePriority` (when set), then **shorter** sentence
 * (word-run count), then `testQualityScore`.
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
		orderBy: { id: "asc" },
		select: {
			sentenceId: true,
			aiClozePriority: true,
			sentence: { select: { text: true, testQualityScore: true } },
		},
		take: Math.max(take * 4, LINKED_POOL_FETCH),
	})

	rows.sort((a, b) => {
		const pa = a.aiClozePriority
		const pb = b.aiClozePriority
		if (pa != null && pb != null && pa !== pb) return pb - pa
		if (pa != null && pb == null) return -1
		if (pa == null && pb != null) return 1
		const wa = countClozeWordRuns(a.sentence.text)
		const wb = countClozeWordRuns(b.sentence.text)
		if (wa !== wb) return wa - wb
		const ta = a.sentence.testQualityScore ?? -1
		const tb = b.sentence.testQualityScore ?? -1
		return tb - ta
	})

	return rows.slice(0, take).map((r) => r.sentenceId)
}
