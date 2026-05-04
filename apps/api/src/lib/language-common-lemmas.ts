import type { CurriculumSource } from "@nwords/db"
import { prisma } from "@nwords/db"

export function normalizeCommonLemma(input: string): string {
	return input.normalize("NFC").trim()
}

function asMetaRecord(metadata: unknown): Record<string, unknown> {
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>) }
	}
	return {}
}

export type VocabLlmSeed = {
	requiredWords: string[]
	unitCount: number
	glossLanguageName: string
	glossLanguageCode: string
	chainedFromJobId: string | null
}

function seedFromMeta(
	meta: Record<string, unknown>,
	chainedFromJobId: string | null,
	words: string[],
): VocabLlmSeed {
	const unitCount = typeof meta.unitCount === "number" && meta.unitCount > 0 ? meta.unitCount : 2000
	const glossLanguageName =
		typeof meta.glossLanguageName === "string" ? meta.glossLanguageName : "English"
	const glossLanguageCode =
		typeof meta.glossLanguageCode === "string" ? meta.glossLanguageCode : "en"
	return {
		requiredWords: words,
		unitCount,
		glossLanguageName,
		glossLanguageCode,
		chainedFromJobId,
	}
}

async function latestCompletedCommonWordsJob(languageId: string) {
	return prisma.ingestionJob.findFirst({
		where: { languageId, type: "COMMON_WORDS_TOP", status: "COMPLETED" },
		orderBy: [{ completedAt: "desc" }, { id: "desc" }],
	})
}

/**
 * Replace all rows for the language with the given lemmas (deduped, order preserved).
 * Called after a successful COMMON_WORDS_TOP run and when resolving LLM seed from job metadata.
 */
export async function syncLanguageCommonLemmasFromList(
	languageId: string,
	lemmas: string[],
): Promise<void> {
	const seen = new Set<string>()
	const normalized: string[] = []
	for (const raw of lemmas) {
		const lemma = normalizeCommonLemma(raw)
		if (!lemma) continue
		if (seen.has(lemma)) continue
		seen.add(lemma)
		normalized.push(lemma)
	}

	await prisma.$transaction(async (tx) => {
		await tx.languageCommonLemma.deleteMany({ where: { languageId } })
		if (normalized.length === 0) return
		await tx.languageCommonLemma.createMany({
			data: normalized.map((lemma, sortOrder) => ({
				languageId,
				lemma,
				sortOrder,
				curriculumSource: "COMMON" as CurriculumSource,
			})),
		})
	})
}

/** Stats for HermitDave-style append jobs. */
export type AppendCommonLemmaStats = {
	added: number
	skippedAlreadyInDb: number
	skippedDuplicateInCandidates: number
}

/**
 * Append lemmas in candidate order after existing rows. Skips lemmas already present (normalized)
 * or duplicated inside `candidateLemmas`. Does not reorder or remove existing entries.
 */
export async function appendCommonLemmasNotAlreadyPresent(
	languageId: string,
	candidateLemmas: string[],
	opts?: { sourceForNewRows?: CurriculumSource },
): Promise<AppendCommonLemmaStats> {
	const sourceForNewRows = opts?.sourceForNewRows ?? "HERMIT_DAVE"
	let skippedAlreadyInDb = 0
	let skippedDuplicateInCandidates = 0
	const candidatesSeen = new Set<string>()
	const normalizedOrder: string[] = []
	for (const raw of candidateLemmas) {
		const lemma = normalizeCommonLemma(raw)
		if (!lemma) continue
		if (candidatesSeen.has(lemma)) {
			skippedDuplicateInCandidates++
			continue
		}
		candidatesSeen.add(lemma)
		normalizedOrder.push(lemma)
	}

	let added = 0
	await prisma.$transaction(async (tx) => {
		const existing = await tx.languageCommonLemma.findMany({
			where: { languageId },
			select: { lemma: true },
		})
		const inDb = new Set(existing.map((r) => normalizeCommonLemma(r.lemma)))

		const agg = await tx.languageCommonLemma.aggregate({
			where: { languageId },
			_max: { sortOrder: true },
		})
		let sortOrder = (agg._max.sortOrder ?? -1) + 1
		const rows: {
			languageId: string
			lemma: string
			sortOrder: number
			curriculumSource: CurriculumSource
		}[] = []

		for (const lemma of normalizedOrder) {
			if (inDb.has(lemma)) {
				skippedAlreadyInDb++
				continue
			}
			inDb.add(lemma)
			rows.push({
				languageId,
				lemma,
				sortOrder: sortOrder++,
				curriculumSource: sourceForNewRows,
			})
		}

		added = rows.length
		if (rows.length > 0) {
			await tx.languageCommonLemma.createMany({ data: rows })
		}
	})

	return { added, skippedAlreadyInDb, skippedDuplicateInCandidates }
}

/**
 * Words and gloss/unitCount for VOCAB_UNITS_LLM.
 * - With `forceCommonWordsJobId`: use that job’s `topLemmas` and refresh the curated table to match.
 * - Otherwise: use curated table if non-empty; else latest completed COMMON_WORDS_TOP (and mirror into the table).
 */
export async function resolveVocabLlmSeed(
	languageId: string,
	opts?: { forceCommonWordsJobId?: string },
): Promise<VocabLlmSeed> {
	if (opts?.forceCommonWordsJobId) {
		const row = await prisma.ingestionJob.findUnique({ where: { id: opts.forceCommonWordsJobId } })
		if (!row || row.languageId !== languageId) {
			throw new Error(
				`COMMON_WORDS_TOP job ${opts.forceCommonWordsJobId} not found or language mismatch`,
			)
		}
		if (row.type !== "COMMON_WORDS_TOP") {
			throw new Error(`Job ${opts.forceCommonWordsJobId} is not COMMON_WORDS_TOP`)
		}
		if (row.status !== "COMPLETED") {
			throw new Error(
				`COMMON_WORDS_TOP job ${opts.forceCommonWordsJobId} is ${row.status}, not COMPLETED`,
			)
		}
		const meta = asMetaRecord(row.metadata)
		const raw = meta.topLemmas
		if (
			!Array.isArray(raw) ||
			raw.length === 0 ||
			!raw.every((x): x is string => typeof x === "string")
		) {
			throw new Error("COMMON_WORDS_TOP metadata missing topLemmas array")
		}
		await syncLanguageCommonLemmasFromList(languageId, raw)
		return seedFromMeta(meta, row.id, raw)
	}

	const tableRows = await prisma.languageCommonLemma.findMany({
		where: { languageId },
		orderBy: { sortOrder: "asc" },
	})

	if (tableRows.length > 0) {
		const words = tableRows.map((r) => r.lemma)
		const metaJob = await latestCompletedCommonWordsJob(languageId)
		const meta = metaJob ? asMetaRecord(metaJob.metadata) : {}
		return seedFromMeta(meta, metaJob?.id ?? null, words)
	}

	const job = await latestCompletedCommonWordsJob(languageId)
	if (!job) {
		throw new Error(
			"No common lemmas saved for this language and no completed COMMON_WORDS_TOP job — add words in admin or run Common words first.",
		)
	}
	const meta = asMetaRecord(job.metadata)
	const raw = meta.topLemmas
	if (
		!Array.isArray(raw) ||
		raw.length === 0 ||
		!raw.every((x): x is string => typeof x === "string")
	) {
		throw new Error("COMMON_WORDS_TOP metadata missing topLemmas array")
	}
	await syncLanguageCommonLemmasFromList(languageId, raw)
	return seedFromMeta(meta, job.id, raw)
}
