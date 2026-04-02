import { prisma } from "@nwords/db"
import { getAcceptableSynonymMessage, getUnacceptableSynonymMessage } from "@nwords/shared"
import { lookupUserAnswerWords } from "./pos-lookup"
import { findSynonymPairQuality } from "./word-synonym-pair"

export type SynonymFeedback = { kind: "good" | "bad"; message: string }

export async function computeSynonymFeedback(params: {
	userAnswer: string
	targetWordId: string
	targetLanguageId: string
	nativeLanguageCode: string
}): Promise<SynonymFeedback | undefined> {
	const guesses = await lookupUserAnswerWords(params.userAnswer, params.targetLanguageId)
	if (guesses.length === 0) return undefined

	const targetWord = await prisma.word.findUnique({
		where: { id: params.targetWordId },
		select: { lemma: true },
	})
	if (!targetWord) return undefined

	for (const g of guesses) {
		if (g.id === params.targetWordId) continue
		const q = await findSynonymPairQuality(params.targetLanguageId, g.id, params.targetWordId)
		if (q === "GOOD") {
			return {
				kind: "good",
				message: getAcceptableSynonymMessage(params.nativeLanguageCode, g.lemma),
			}
		}
	}
	for (const g of guesses) {
		if (g.id === params.targetWordId) continue
		const q = await findSynonymPairQuality(params.targetLanguageId, g.id, params.targetWordId)
		if (q === "BAD") {
			return {
				kind: "bad",
				message: getUnacceptableSynonymMessage(
					params.nativeLanguageCode,
					g.lemma,
					targetWord.lemma,
				),
			}
		}
	}
	return undefined
}
