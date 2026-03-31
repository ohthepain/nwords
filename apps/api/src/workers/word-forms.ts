import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import type PgBoss from "pg-boss"
import type { KaikkiIngestMode } from "../lib/ingestion-urls"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"
import { nodeReadableFromWeb } from "../lib/node-streams"

/**
 * Word-forms ingestion worker.
 * Re-reads Kaikki JSONL (same source as the kaikki worker) and extracts `forms` arrays
 * to populate the `word_form` table — morphological inflections, conjugations, plurals, etc.
 *
 * Must run after kaikki import so that Word rows exist for the FK.
 */

const POS_MAP: Record<string, string> = {
	noun: "NOUN",
	verb: "VERB",
	adj: "ADJECTIVE",
	adv: "ADVERB",
	adjective: "ADJECTIVE",
	adverb: "ADVERB",
}

interface KaikkiEntry {
	word: string
	pos: string
	forms?: Array<{
		form: string
		tags?: string[]
	}>
}

export interface WordFormsJobData {
	jobId: string
	languageId: string
	filePath?: string
	downloadUrl?: string
	downloadUrls?: string[]
	kaikkiMode?: KaikkiIngestMode
	chainPipeline?: boolean
}

async function* linesFromFile(filePath: string): AsyncGenerator<string> {
	const input = createReadStream(filePath, "utf-8")
	const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
	try {
		for await (const line of rl) yield line
	} finally {
		rl.close()
	}
}

async function* linesFromUrl(url: string): AsyncGenerator<string> {
	const res = await fetch(url)
	if (!res.ok) {
		throw new Error(`Word-forms download failed HTTP ${res.status}: ${url}`)
	}
	const input = nodeReadableFromWeb(res.body)
	const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
	try {
		for await (const line of rl) yield line
	} finally {
		rl.close()
	}
}

/** Max forms we store per lemma — caps pathological cases (agglutinative langs). */
const MAX_FORMS_PER_WORD = 200

export async function processWordFormsJob(job: PgBoss.Job<WordFormsJobData>) {
	const { jobId, languageId, filePath, downloadUrl, chainPipeline, kaikkiMode } = job.data
	const downloadUrls = job.data.downloadUrls?.length
		? job.data.downloadUrls
		: downloadUrl
			? [downloadUrl]
			: []

	if (!filePath && downloadUrls.length === 0) {
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: { error: "filePath, downloadUrl, or downloadUrls is required" },
			},
		})
		return
	}

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const row = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[word-forms] skipped job ${jobId}: could not claim (ingestion status=${row?.status ?? "missing"})`,
		)
		return
	}

	await appendJobLog(jobId, "out", "Word forms: job started.")
	await appendJobLog(
		jobId,
		"out",
		filePath
			? `Word forms: importing from file`
			: `Word forms: streaming ${downloadUrls.length} URL(s), mode ${kaikkiMode ?? "default"}`,
	)

	// Pre-load a map of (lemma, pos) → wordId for this language so we can resolve FKs in memory
	// instead of doing a DB lookup per entry.
	await appendJobLog(jobId, "out", "Word forms: loading lemma→wordId index…")
	const wordIndex = new Map<string, string>()
	const wordRows = await prisma.word.findMany({
		where: { languageId },
		select: { id: true, lemma: true, pos: true },
	})
	for (const w of wordRows) {
		wordIndex.set(`${w.lemma}\t${w.pos}`, w.id)
	}
	await appendJobLog(jobId, "out", `Word forms: loaded ${wordIndex.size} lemmas into index.`)

	let processed = 0
	let errors = 0
	let inserted = 0
	let skipped = 0
	let formsSkippedNoWord = 0
	let batchFlushCount = 0
	const BATCH_SIZE = 1000
	const totalParts = !filePath ? downloadUrls.length : 1

	let batch: Array<{
		languageId: string
		form: string
		wordId: string
		tags: Prisma.InputJsonValue
	}> = []

	async function handleLine(line: string, partIndex: number): Promise<boolean> {
		if (await isIngestionJobCancelled(jobId)) return false
		processed++
		if (!line.trim()) return true

		try {
			const entry: KaikkiEntry = JSON.parse(line)

			const mappedPos = POS_MAP[entry.pos?.toLowerCase() ?? ""]
			if (!mappedPos) {
				skipped++
				return true
			}

			const lemma = entry.word?.trim()?.toLowerCase()
			if (!lemma) {
				skipped++
				return true
			}

			if (!entry.forms || entry.forms.length === 0) {
				skipped++
				return true
			}

			const wordId = wordIndex.get(`${lemma}\t${mappedPos}`)
			if (!wordId) {
				formsSkippedNoWord++
				return true
			}

			let formCount = 0
			for (const f of entry.forms) {
				if (formCount >= MAX_FORMS_PER_WORD) break
				const form = f.form?.trim()?.toLowerCase()
				if (!form || form === lemma) continue // skip the lemma itself
				const tags = f.tags ?? []

				batch.push({
					languageId,
					form,
					wordId,
					tags: tags as Prisma.InputJsonValue,
				})
				formCount++
			}

			if (batch.length >= BATCH_SIZE) {
				const result = await flushBatch(batch)
				inserted += result.inserted
				errors += result.errors
				batch = []
				batchFlushCount++
				if (batchFlushCount === 1 || batchFlushCount % 5 === 0) {
					await appendJobLog(
						jobId,
						"out",
						`Word forms flush ${batchFlushCount}: part ${partIndex}/${totalParts}, entries ${processed}, forms inserted ${inserted}`,
					)
				}
				await updateIngestionProgress(jobId, {
					processedItems: processed,
					errorCount: errors,
					extraMetadata: {
						inserted,
						skipped,
						formsSkippedNoWord,
						streaming: !filePath,
						kaikkiPart: partIndex,
						kaikkiParts: totalParts,
						kaikkiMode: kaikkiMode ?? null,
					},
				})
				if (await isIngestionJobCancelled(jobId)) return false
			}
		} catch {
			errors++
		}
		return true
	}

	try {
		if (filePath) {
			for await (const line of linesFromFile(filePath)) {
				if (!(await handleLine(line, 1))) return
			}
		} else {
			for (let p = 0; p < downloadUrls.length; p++) {
				const url = downloadUrls[p]
				const partIndex = p + 1
				await appendJobLog(jobId, "out", `Word forms: downloading part ${partIndex}/${downloadUrls.length}…`)
				for await (const line of linesFromUrl(url)) {
					if (!(await handleLine(line, partIndex))) return
				}
				await appendJobLog(jobId, "out", `Word forms: finished part ${partIndex}/${downloadUrls.length}`)
			}
		}

		if (batch.length > 0) {
			const result = await flushBatch(batch)
			inserted += result.inserted
			errors += result.errors
		}

		if (await isIngestionJobCancelled(jobId)) return

		await appendJobLog(
			jobId,
			"out",
			`Word forms complete: ${inserted} forms inserted, ${skipped} entries skipped, ${formsSkippedNoWord} no-word-match, ${errors} errors`,
		)

		const metaSnap = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true },
		})
		const prevCompleteMeta = (metaSnap?.metadata ?? {}) as Record<string, unknown>

		const done = await prisma.ingestionJob.updateMany({
			where: { id: jobId, status: "RUNNING" },
			data: {
				status: "COMPLETED",
				processedItems: processed,
				totalItems: processed,
				errorCount: errors,
				completedAt: new Date(),
				metadata: {
					...prevCompleteMeta,
					inserted,
					skipped,
					formsSkippedNoWord,
					lines: processed,
					streaming: !filePath,
					downloadUrl: downloadUrl ?? null,
					downloadUrls: filePath ? null : downloadUrls,
					kaikkiMode: kaikkiMode ?? null,
				} as Prisma.InputJsonValue,
			},
		})
		if (done.count === 0) return

		console.log(
			`[word-forms] Done: ${inserted} forms inserted, ${skipped} skipped, ${formsSkippedNoWord} no-word-match, ${errors} errors`,
		)
	} catch (err) {
		console.error("[word-forms] Fatal error:", err)
		if (await isIngestionJobCancelled(jobId)) return
		await appendJobLog(jobId, "err", String(err))
		const failSnap = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true },
		})
		const prevFailMeta = (failSnap?.metadata ?? {}) as Record<string, unknown>
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				processedItems: processed,
				errorCount: errors,
				completedAt: new Date(),
				metadata: {
					...prevFailMeta,
					error: String(err),
					inserted,
					skipped,
					formsSkippedNoWord,
				} as Prisma.InputJsonValue,
			},
		})
		throw err
	}
}

async function flushBatch(
	batch: Array<{
		languageId: string
		form: string
		wordId: string
		tags: Prisma.InputJsonValue
	}>,
): Promise<{ inserted: number; errors: number }> {
	let inserted = 0
	let errors = 0

	try {
		const result = await prisma.wordForm.createMany({
			data: batch,
			skipDuplicates: true,
		})
		inserted = result.count
	} catch {
		// Fallback: per-row upsert when batch fails (e.g. constraint violation edge cases)
		for (const row of batch) {
			try {
				await prisma.wordForm.upsert({
					where: {
						languageId_form_wordId: {
							languageId: row.languageId,
							form: row.form,
							wordId: row.wordId,
						},
					},
					create: row,
					update: { tags: row.tags },
				})
				inserted++
			} catch {
				errors++
			}
		}
	}

	return { inserted, errors }
}
