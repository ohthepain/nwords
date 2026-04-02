import { type SynonymQuality, prisma } from "@nwords/db"

export function orderedWordPair(wordIdA: string, wordIdB: string): [string, string] {
	return wordIdA < wordIdB ? [wordIdA, wordIdB] : [wordIdB, wordIdA]
}

export async function findSynonymPairQuality(
	languageId: string,
	wordIdA: string,
	wordIdB: string,
): Promise<SynonymQuality | null> {
	if (wordIdA === wordIdB) return null
	const [low, high] = orderedWordPair(wordIdA, wordIdB)
	const row = await prisma.wordSynonymPair.findUnique({
		where: {
			languageId_wordIdLow_wordIdHigh: { languageId, wordIdLow: low, wordIdHigh: high },
		},
		select: { quality: true },
	})
	return row?.quality ?? null
}

export async function upsertWordSynonymPair(
	languageId: string,
	wordIdA: string,
	wordIdB: string,
	quality: SynonymQuality,
): Promise<void> {
	const [low, high] = orderedWordPair(wordIdA, wordIdB)
	if (low === high) {
		throw new Error("Cannot register a synonym pair for the same word")
	}
	await prisma.wordSynonymPair.upsert({
		where: {
			languageId_wordIdLow_wordIdHigh: { languageId, wordIdLow: low, wordIdHigh: high },
		},
		create: { languageId, wordIdLow: low, wordIdHigh: high, quality },
		update: { quality },
	})
}
