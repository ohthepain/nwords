import { prisma } from "@nwords/db"
import { POS_MISMATCH_MESSAGES, type PosKey, getPosMismatchMessage } from "@nwords/shared"

const POS_KEYS: PosKey[] = ["NOUN", "VERB", "ADJECTIVE", "ADVERB"]

export type SeedPosMismatchLanguageRow = {
	name: string
	code: string
	upserted: number
	usedEnglishFallback: boolean
}

export type SeedPosMismatchMessagesResult = {
	languageCount: number
	totalUpserted: number
	languages: SeedPosMismatchLanguageRow[]
}

/**
 * Upserts POS mismatch copy for every enabled language from `@nwords/shared`.
 * Safe to run repeatedly (idempotent upserts).
 */
export async function seedPosMismatchMessages(): Promise<SeedPosMismatchMessagesResult> {
	const enabledLanguages = await prisma.language.findMany({
		where: { enabled: true },
		select: { id: true, code: true, name: true },
		orderBy: { name: "asc" },
	})

	if (enabledLanguages.length === 0) {
		return { languageCount: 0, totalUpserted: 0, languages: [] }
	}

	const languages: SeedPosMismatchLanguageRow[] = []
	let totalUpserted = 0

	for (const lang of enabledLanguages) {
		const hasOwnMessages = lang.code in POS_MISMATCH_MESSAGES
		let langUpserted = 0

		for (const guessPos of POS_KEYS) {
			for (const targetPos of POS_KEYS) {
				if (guessPos === targetPos) continue

				const message = getPosMismatchMessage(lang.code, guessPos, targetPos)
				if (!message) continue

				await prisma.posMismatchMessage.upsert({
					where: {
						languageId_guessPos_targetPos: {
							languageId: lang.id,
							guessPos,
							targetPos,
						},
					},
					create: {
						languageId: lang.id,
						guessPos,
						targetPos,
						message,
					},
					update: {
						message,
					},
				})

				langUpserted++
			}
		}

		languages.push({
			name: lang.name,
			code: lang.code,
			upserted: langUpserted,
			usedEnglishFallback: !hasOwnMessages,
		})
		totalUpserted += langUpserted
	}

	return { languageCount: enabledLanguages.length, totalUpserted, languages }
}
