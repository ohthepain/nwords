import { prisma } from "@nwords/db"
import { createServerFn } from "@tanstack/react-start"

export type WordSentence = {
	id: string
	text: string
	translations: string[]
}

export const getWordSentences = createServerFn({ method: "POST" })
	.inputValidator((data: { wordId: string; nativeLanguageId: string | null }) => data)
	.handler(async ({ data }) => {
		const { wordId, nativeLanguageId } = data

		const sentenceWords = await prisma.sentenceWord.findMany({
			where: { wordId },
			take: 20,
			include: {
				sentence: {
					include: {
						translations: {
							include: {
								translatedSentence: {
									select: { text: true, languageId: true },
								},
							},
						},
					},
				},
			},
			orderBy: { sentence: { testQualityScore: { sort: "desc", nulls: "last" } } },
		})

		const sentences: WordSentence[] = sentenceWords.map((sw) => ({
			id: sw.sentence.id,
			text: sw.sentence.text,
			translations: nativeLanguageId
				? sw.sentence.translations
						.filter((t) => t.translatedSentence.languageId === nativeLanguageId)
						.map((t) => t.translatedSentence.text)
				: [],
		}))

		return { sentences }
	})
