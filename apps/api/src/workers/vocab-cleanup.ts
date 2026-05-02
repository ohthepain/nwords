import type { PartOfSpeech, Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { cefrLevelForFrequencyRank } from "@nwords/shared"
import type PgBoss from "pg-boss"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs"
import { normalizeCommonLemma } from "../lib/language-common-lemmas"
import { resolveWordOrder } from "../lib/resolve-word-order"

export interface VocabCleanupJobData {
	jobId: string
	languageId: string
	dryRun?: boolean
	senseOffset?: number
}

function asMetaRecord(metadata: unknown): Record<string, unknown> {
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>) }
	}
	return {}
}

const PREVIEW_CAP = 200

function resolveSenseOffset(explicit?: number): number {
	if (typeof explicit === "number" && explicit >= 1 && explicit <= 10_000) return explicit
	const raw = process.env.VOCAB_CLEANUP_SENSE_OFFSET?.trim()
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN
	if (Number.isFinite(n) && n >= 1 && n <= 10_000) return n
	return 300
}

function groupingKeyLemma(lemma: string): string {
	return normalizeCommonLemma(lemma).toLowerCase()
}

type WordRow = {
	id: string
	lemma: string
	pos: PartOfSpeech
	rank: number
	effectiveRank: number
	positionAdjust: number
}

function comparePrimary(a: WordRow, b: WordRow, commonLemmaRank: Map<string, number>): number {
	if (a.effectiveRank !== b.effectiveRank) return a.effectiveRank - b.effectiveRank
	const ka = groupingKeyLemma(a.lemma)
	const kb = groupingKeyLemma(b.lemma)
	const ca = commonLemmaRank.get(ka) ?? 1_000_000
	const cb = commonLemmaRank.get(kb) ?? 1_000_000
	if (ca !== cb) return ca - cb
	return a.id.localeCompare(b.id)
}

export async function processVocabCleanupJob(job: PgBoss.Job<VocabCleanupJobData>) {
	const { jobId, languageId } = job.data
	const row = await prisma.ingestionJob.findUnique({ where: { id: jobId } })
	const fileMeta = asMetaRecord(row?.metadata)

	const dryRun =
		job.data.dryRun === true ||
		fileMeta.dryRun === true ||
		(typeof fileMeta.dryRun === "string" && fileMeta.dryRun === "true")

	const senseOffset = resolveSenseOffset(
		typeof job.data.senseOffset === "number" ? job.data.senseOffset : undefined,
	)

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const r = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[vocab-cleanup] skipped job ${jobId}: could not claim (ingestion status=${r?.status ?? "missing"})`,
		)
		return
	}

	try {
		const language = await prisma.language.findUnique({ where: { id: languageId } })
		if (!language) throw new Error(`Language ${languageId} not found`)

		await appendJobLog(
			jobId,
			"out",
			`Vocab cleanup: ${language.name} — ${dryRun ? "DRY RUN" : "apply"}; sense offset ${senseOffset} (homograph spacing + dense ranks only).`,
		)

		const [commonRows, wordRows] = await Promise.all([
			prisma.languageCommonLemma.findMany({
				where: { languageId },
				select: { lemma: true, sortOrder: true },
			}),
			prisma.word.findMany({
				where: { languageId, curriculumSource: "AI_CURRICULUM" },
				select: {
					id: true,
					lemma: true,
					pos: true,
					rank: true,
					effectiveRank: true,
					positionAdjust: true,
				},
			}),
		])

		const commonLemmaRank = new Map<string, number>()
		for (const r of commonRows) {
			const k = groupingKeyLemma(r.lemma)
			const prev = commonLemmaRank.get(k)
			if (prev === undefined || r.sortOrder < prev) {
				commonLemmaRank.set(k, r.sortOrder)
			}
		}

		const survivors: WordRow[] = wordRows.map((w) => ({
			id: w.id,
			lemma: w.lemma,
			pos: w.pos,
			rank: w.rank,
			effectiveRank: w.effectiveRank,
			positionAdjust: w.positionAdjust,
		}))

		await appendJobLog(
			jobId,
			"out",
			`${survivors.length.toLocaleString()} AI curriculum unit(s) to reorder.`,
		)

		/** Index in sort-by-(effectiveRank,id) */
		const sortedByRank = [...survivors].sort((a, b) => {
			if (a.effectiveRank !== b.effectiveRank) return a.effectiveRank - b.effectiveRank
			return a.id.localeCompare(b.id)
		})

		const naturalIndex = new Map<string, number>()
		for (let i = 0; i < sortedByRank.length; i++) {
			naturalIndex.set(sortedByRank[i].id, i)
		}

		const groups = new Map<string, WordRow[]>()
		for (const w of survivors) {
			const g = groupingKeyLemma(w.lemma)
			const list = groups.get(g) ?? []
			list.push(w)
			groups.set(g, list)
		}

		let senseGroupsAdjusted = 0
		const sortKey = new Map<string, number>()
		for (const w of survivors) {
			sortKey.set(w.id, naturalIndex.get(w.id) ?? 0)
		}

		for (const [_gkey, list] of groups) {
			if (list.length < 2) continue
			senseGroupsAdjusted++
			const primary =
				[...list].sort((a, b) => comparePrimary(a, b, commonLemmaRank))[0] ?? list[0]
			const secondaries = list
				.filter((x) => x.id !== primary.id)
				.sort((a, b) => comparePrimary(a, b, commonLemmaRank))

			const pNat = naturalIndex.get(primary.id) ?? 0
			for (let j = 0; j < secondaries.length; j++) {
				const sec = secondaries[j]
				const newKey = pNat + senseOffset + (j + 1) * 1e-6
				sortKey.set(sec.id, newKey)
			}
		}

		const finalOrder = [...survivors].sort((a, b) => {
			const ka = sortKey.get(a.id) ?? 0
			const kb = sortKey.get(b.id) ?? 0
			if (ka !== kb) return ka - kb
			return a.id.localeCompare(b.id)
		})

		const oldIndex = new Map<string, number>()
		for (let i = 0; i < sortedByRank.length; i++) {
			oldIndex.set(sortedByRank[i].id, i)
		}

		const newRankById = new Map<string, number>()
		for (let i = 0; i < finalOrder.length; i++) {
			newRankById.set(finalOrder[i].id, i + 1)
		}

		let wouldRenumberTotal = 0
		const renumberSamples: Array<{
			wordId: string
			lemma: string
			pos: PartOfSpeech
			oldIndex: number
			newRank: number
		}> = []
		for (const w of survivors) {
			const oi = oldIndex.get(w.id) ?? 0
			const nr = newRankById.get(w.id) ?? 0
			const ni = nr - 1
			if (oi !== ni) wouldRenumberTotal++
		}
		const deltas = survivors
			.map((w) => {
				const oi = oldIndex.get(w.id) ?? 0
				const nr = newRankById.get(w.id) ?? 0
				const ni = nr - 1
				return { w, delta: Math.abs(ni - oi), id: w.id, nr }
			})
			.sort((a, b) => b.delta - a.delta || a.id.localeCompare(b.id))
		for (const x of deltas.slice(0, PREVIEW_CAP)) {
			renumberSamples.push({
				wordId: x.w.id,
				lemma: x.w.lemma,
				pos: x.w.pos,
				oldIndex: oldIndex.get(x.w.id) ?? 0,
				newRank: x.nr,
			})
		}

		if (!dryRun && survivors.length > 0) {
			const updates: ReturnType<typeof prisma.word.update>[] = []
			for (const w of survivors) {
				const newRank = newRankById.get(w.id) ?? w.rank
				const cefr = cefrLevelForFrequencyRank(newRank)
				updates.push(
					prisma.word.update({
						where: { id: w.id },
						data: {
							rank: newRank,
							positionAdjust: 0,
							effectiveRank: newRank,
							cefrLevel: cefr ?? null,
						},
					}),
				)
			}
			const TX_CHUNK = 150
			for (let i = 0; i < updates.length; i += TX_CHUNK) {
				if (await isIngestionJobCancelled(jobId)) return
				await prisma.$transaction(updates.slice(i, i + TX_CHUNK))
			}
		}
		if (!dryRun) {
			await resolveWordOrder(languageId)
		}

		await appendJobLog(
			jobId,
			"out",
			`Homograph groups (2+ senses same spelling): ${senseGroupsAdjusted.toLocaleString()}; ${wouldRenumberTotal.toLocaleString()} row(s) changed position after dense renumber.`,
		)

		const prev = await snapshotJobMetadata(jobId)

		const completionMeta: Record<string, unknown> = {
			...prev,
			dryRun,
			senseOffset,
			senseGroupsAdjusted,
			wouldRenumberTotal,
			wouldRenumber: renumberSamples,
			...(dryRun
				? {}
				: {
						renumberedPositionChanges: wouldRenumberTotal,
					}),
		}

		await prisma.ingestionJob.updateMany({
			where: { id: jobId, status: "RUNNING" },
			data: {
				status: "COMPLETED",
				processedItems: wordRows.length,
				totalItems: wordRows.length,
				completedAt: new Date(),
				metadata: completionMeta as Prisma.InputJsonValue,
			},
		})

		await appendJobLog(
			jobId,
			"out",
			dryRun
				? "Dry run complete — no database changes. See metadata `wouldRenumber` or Output → Preview."
				: "Vocab cleanup complete.",
		)
	} catch (err) {
		console.error("[vocab-cleanup] Fatal error:", err)
		if (await isIngestionJobCancelled(jobId)) return
		await appendJobLog(jobId, "err", String(err))
		const snap = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true, processedItems: true },
		})
		const prevMeta = asMetaRecord(snap?.metadata)
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: {
					...prevMeta,
					error: err instanceof Error ? err.message : String(err),
				} as Prisma.InputJsonValue,
			},
		})
		throw err
	}
}
