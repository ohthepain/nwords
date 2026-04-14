import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { cefrLevelForFrequencyRank } from "@nwords/shared"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

export type WordPanelWord = {
	id: string
	lemma: string
	pos: string
	alternatePos: string[]
	rank: number
	/** Present when opened from admin word list: raw frequency rank vs materialised ordering. */
	positionAdjust?: number
	effectiveRank?: number
	definitions: string[]
	cefrLevel: string | null
	isOffensive: boolean
	langCode: string
	sentenceCount: number
}

export type WordPanelKnowledge = {
	confidence: number
	timesTested: number
	timesCorrect: number
	lastTestedAt: string | null
	lastCorrect: boolean
	streak: number
}

/** Dictionary row + optional signed-in user stats (for practice / unified word panel). */
export const getWordPanelData = createServerFn({ method: "POST" })
	.inputValidator((data: { wordId: string }) => data)
	.handler(async ({ data }) => {
		const word = await prisma.word.findUnique({
			where: { id: data.wordId },
			include: {
				language: { select: { code: true } },
				_count: { select: { sentenceWords: true } },
			},
		})
		if (!word) return null

		const rank = word.effectiveRank
		const cefrLevel = word.cefrLevel ?? (rank > 0 ? cefrLevelForFrequencyRank(rank) : null)

		const panelWord: WordPanelWord = {
			id: word.id,
			lemma: word.lemma,
			pos: word.pos,
			alternatePos: [...word.alternatePos],
			rank,
			definitions: (word.definitions as string[]) ?? [],
			cefrLevel: cefrLevel ?? null,
			isOffensive: word.isOffensive,
			langCode: word.language.code,
			sentenceCount: word._count.sentenceWords,
		}

		const request = getRequest()
		let knowledge: WordPanelKnowledge | null = null
		if (request) {
			const session = await auth.api.getSession({ headers: request.headers })
			if (session?.user?.id) {
				const k = await prisma.userWordKnowledge.findUnique({
					where: { userId_wordId: { userId: session.user.id, wordId: data.wordId } },
				})
				if (k) {
					knowledge = {
						confidence: k.confidence,
						timesTested: k.timesTested,
						timesCorrect: k.timesCorrect,
						lastTestedAt: k.lastTestedAt?.toISOString() ?? null,
						lastCorrect: k.lastCorrect,
						streak: k.streak,
					}
				}
			}
		}

		return { word: panelWord, knowledge }
	})
