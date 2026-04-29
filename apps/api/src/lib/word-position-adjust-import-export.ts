import { prisma } from "@nwords/db"
import { z } from "zod"

export const POSITION_ADJUST_EXPORT_VERSION = 1 as const

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

const adjustmentRowSchema = z.object({
	languageCode: z.string().min(1),
	lemma: z.string().min(1),
	pos: z.enum(PART_OF_SPEECH_VALUES),
	positionAdjust: z.number().int().min(-10000).max(10000),
})

export const positionAdjustImportSchema = z.object({
	version: z.literal(POSITION_ADJUST_EXPORT_VERSION).optional(),
	adjustments: z.array(adjustmentRowSchema),
})

export type PositionAdjustExportPayload = z.infer<typeof positionAdjustImportSchema> & {
	version: typeof POSITION_ADJUST_EXPORT_VERSION
	exportedAt: string
}

export async function buildPositionAdjustExport(params: {
	languageId?: string
}): Promise<PositionAdjustExportPayload> {
	const where = {
		positionAdjust: { not: 0 },
		...(params.languageId ? { languageId: params.languageId } : {}),
	}
	const rows = await prisma.word.findMany({
		where,
		select: {
			lemma: true,
			pos: true,
			positionAdjust: true,
			language: { select: { code: true } },
		},
		orderBy: [{ languageId: "asc" }, { lemma: "asc" }, { pos: "asc" }],
	})
	return {
		version: POSITION_ADJUST_EXPORT_VERSION,
		exportedAt: new Date().toISOString(),
		adjustments: rows.map((r) => ({
			languageCode: r.language.code,
			lemma: r.lemma,
			pos: r.pos,
			positionAdjust: r.positionAdjust,
		})),
	}
}

/**
 * Apply position adjustments from JSON. Words not listed in the file are unchanged.
 * Duplicate keys (same language + lemma + pos) in the file: last occurrence wins.
 */
export async function importPositionAdjustMerge(
	parsed: z.infer<typeof positionAdjustImportSchema>,
): Promise<{
	applied: number
	skippedUnresolved: number
	skippedDuplicateInFile: number
}> {
	const languageCodes = [...new Set(parsed.adjustments.map((a) => a.languageCode))]
	const languages = await prisma.language.findMany({
		where: { code: { in: languageCodes } },
		select: { id: true, code: true },
	})
	const languageIdByCode = new Map(languages.map((l) => [l.code, l.id]))

	let skippedUnresolved = 0
	let skippedDuplicateInFile = 0
	type DedupRow = z.infer<typeof adjustmentRowSchema> & { languageId: string }
	const dedupe = new Map<string, DedupRow>()

	for (const row of parsed.adjustments) {
		const languageId = languageIdByCode.get(row.languageCode)
		if (!languageId) {
			skippedUnresolved++
			continue
		}
		const key = `${languageId}:${row.lemma}:${row.pos}`
		if (dedupe.has(key)) skippedDuplicateInFile++
		dedupe.set(key, { ...row, languageId })
	}

	type Resolved = { id: string; positionAdjust: number }
	const resolved: Resolved[] = []

	for (const row of dedupe.values()) {
		const word = await prisma.word.findUnique({
			where: {
				languageId_lemma_pos: {
					languageId: row.languageId,
					lemma: row.lemma,
					pos: row.pos,
				},
			},
			select: { id: true },
		})
		if (!word) {
			skippedUnresolved++
			continue
		}
		resolved.push({ id: word.id, positionAdjust: row.positionAdjust })
	}

	const CHUNK = 100
	let applied = 0
	for (let i = 0; i < resolved.length; i += CHUNK) {
		const slice = resolved.slice(i, i + CHUNK)
		await prisma.$transaction(
			slice.map(
				({ id, positionAdjust }) =>
					prisma.$executeRaw`
					UPDATE "word"
					SET "positionAdjust" = ${positionAdjust},
					    "effectiveRank" = "rank" + ${positionAdjust}
					WHERE "id" = ${id}::uuid
				`,
			),
		)
		applied += slice.length
	}

	return {
		applied,
		skippedUnresolved,
		skippedDuplicateInFile,
	}
}
