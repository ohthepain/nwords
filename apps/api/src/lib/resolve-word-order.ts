import { prisma } from "@nwords/db"

/**
 * Recompute `effectiveRank` for every word in a language.
 * effectiveRank = rank + positionAdjust
 *
 * Called after frequency-list import and after admin adjusts a word's positionAdjust.
 */
export async function resolveWordOrder(languageId: string): Promise<number> {
	const result = await prisma.$executeRaw`
		UPDATE "word"
		SET "effectiveRank" = "rank" + "positionAdjust"
		WHERE "languageId" = ${languageId}::uuid
	`
	return result
}

/**
 * Update a single word's positionAdjust and recompute its effectiveRank atomically.
 */
export async function setWordPositionAdjust(wordId: string, positionAdjust: number): Promise<void> {
	await prisma.$executeRaw`
		UPDATE "word"
		SET "positionAdjust" = ${positionAdjust},
		    "effectiveRank" = "rank" + ${positionAdjust}
		WHERE "id" = ${wordId}::uuid
	`
}
