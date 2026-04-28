import { type SynonymQuality, prisma } from "@nwords/db"
import { z } from "zod"
import { orderedWordPair } from "./word-synonym-pair"

export const SYNONYM_EXPORT_VERSION = 1 as const

const PART_OF_SPEECH_VALUES = [
	"NOUN",
	"VERB",
	"ADJECTIVE",
	"ADVERB",
	"PRONOUN",
	"DETERMINER",
	"PREPOSITION",
	"CONJUNCTION",
	"PARTICLE",
	"INTERJECTION",
	"NUMERAL",
	"PROPER_NOUN",
] as const

const wordRefSchema = z.object({
	lemma: z.string().min(1),
	pos: z.enum(PART_OF_SPEECH_VALUES),
})

const pairRowSchema = z.object({
	languageCode: z.string().min(1),
	a: wordRefSchema,
	b: wordRefSchema,
	quality: z.enum(["GOOD", "BAD"]),
})

export const synonymPairsImportSchema = z.object({
	version: z.literal(SYNONYM_EXPORT_VERSION).optional(),
	pairs: z.array(pairRowSchema),
})

export type SynonymPairsExportPayload = z.infer<typeof synonymPairsImportSchema> & {
	version: typeof SYNONYM_EXPORT_VERSION
	exportedAt: string
}

export async function buildSynonymPairsExport(params: {
	languageId?: string
}): Promise<SynonymPairsExportPayload> {
	const where = params.languageId ? { languageId: params.languageId } : {}
	const rows = await prisma.wordSynonymPair.findMany({
		where,
		include: {
			language: { select: { code: true } },
			wordLow: { select: { lemma: true, pos: true } },
			wordHigh: { select: { lemma: true, pos: true } },
		},
		orderBy: [{ languageId: "asc" }, { wordIdLow: "asc" }, { wordIdHigh: "asc" }],
	})
	return {
		version: SYNONYM_EXPORT_VERSION,
		exportedAt: new Date().toISOString(),
		pairs: rows.map((r) => ({
			languageCode: r.language.code,
			a: { lemma: r.wordLow.lemma, pos: r.wordLow.pos },
			b: { lemma: r.wordHigh.lemma, pos: r.wordHigh.pos },
			quality: r.quality,
		})),
	}
}

export async function importSynonymPairsMerge(
	parsed: z.infer<typeof synonymPairsImportSchema>,
): Promise<{
	inserted: number
	skippedUnresolved: number
	skippedDuplicateInFile: number
	skippedAlreadyInDb: number
}> {
	const languageCodes = [...new Set(parsed.pairs.map((p) => p.languageCode))]
	const languages = await prisma.language.findMany({
		where: { code: { in: languageCodes } },
		select: { id: true, code: true },
	})
	const languageIdByCode = new Map(languages.map((l) => [l.code, l.id]))

	type Resolved = { languageId: string; low: string; high: string; quality: SynonymQuality }
	const seenResolved = new Set<string>()
	const toCreate: Resolved[] = []
	let skippedUnresolved = 0
	let skippedDuplicateInFile = 0

	for (const row of parsed.pairs) {
		const languageId = languageIdByCode.get(row.languageCode)
		if (!languageId) {
			skippedUnresolved++
			continue
		}

		const [wa, wb] = await Promise.all([
			prisma.word.findUnique({
				where: {
					languageId_lemma_pos: {
						languageId,
						lemma: row.a.lemma,
						pos: row.a.pos,
					},
				},
				select: { id: true },
			}),
			prisma.word.findUnique({
				where: {
					languageId_lemma_pos: {
						languageId,
						lemma: row.b.lemma,
						pos: row.b.pos,
					},
				},
				select: { id: true },
			}),
		])

		if (!wa || !wb) {
			skippedUnresolved++
			continue
		}

		const [low, high] = orderedWordPair(wa.id, wb.id)
		if (low === high) {
			skippedUnresolved++
			continue
		}

		const dedupeKey = `${languageId}:${low}:${high}`
		if (seenResolved.has(dedupeKey)) {
			skippedDuplicateInFile++
			continue
		}
		seenResolved.add(dedupeKey)

		toCreate.push({ languageId, low, high, quality: row.quality })
	}

	const existingKeys = new Set<string>()
	if (toCreate.length > 0) {
		const existing = await prisma.wordSynonymPair.findMany({
			where: {
				OR: toCreate.map((t) => ({
					languageId: t.languageId,
					wordIdLow: t.low,
					wordIdHigh: t.high,
				})),
			},
			select: { languageId: true, wordIdLow: true, wordIdHigh: true },
		})
		for (const e of existing) {
			existingKeys.add(`${e.languageId}:${e.wordIdLow}:${e.wordIdHigh}`)
		}
	}

	const toInsert = toCreate.filter((t) => {
		const key = `${t.languageId}:${t.low}:${t.high}`
		return !existingKeys.has(key)
	})
	const skippedAlreadyInDb = toCreate.length - toInsert.length

	let inserted = 0
	if (toInsert.length > 0) {
		const result = await prisma.wordSynonymPair.createMany({
			data: toInsert.map((t) => ({
				languageId: t.languageId,
				wordIdLow: t.low,
				wordIdHigh: t.high,
				quality: t.quality,
			})),
			skipDuplicates: true,
		})
		inserted = result.count
	}

	return {
		inserted,
		skippedUnresolved,
		skippedDuplicateInFile,
		skippedAlreadyInDb,
	}
}
