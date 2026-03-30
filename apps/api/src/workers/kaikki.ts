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
import { chainFrequencyFromKaikki } from "../lib/pipeline-chain"

/**
 * Kaikki.org dictionary dump worker (JSON lines).
 * Prefers four per-POS JSONL URLs (same data as HTML `pos-*` browse pages); falls back to one monolith URL.
 * Drops entries tagged offensive; POS filter still applied on each line.
 */

const POS_MAP: Record<string, string> = {
	noun: "NOUN",
	verb: "VERB",
	adj: "ADJECTIVE",
	adv: "ADVERB",
	adjective: "ADJECTIVE",
	adverb: "ADVERB",
}

const OFFENSIVE_TAGS = new Set(["vulgar", "offensive", "slur", "derogatory", "pejorative"])

interface KaikkiEntry {
	word: string
	pos: string
	lang?: string
	senses?: Array<{
		glosses?: string[]
		tags?: string[]
		raw_tags?: string[]
	}>
}

export interface KaikkiJobData {
	jobId: string
	languageId: string
	filePath?: string
	/** Single URL (legacy / monolith). */
	downloadUrl?: string
	/** Multiple URLs — typically four `by-pos-*.jsonl` files streamed in order. */
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
		throw new Error(`Kaikki download failed HTTP ${res.status}: ${url}`)
	}
	const input = nodeReadableFromWeb(res.body)
	const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
	try {
		for await (const line of rl) yield line
	} finally {
		rl.close()
	}
}

export async function processKaikkiJob(job: PgBoss.Job<KaikkiJobData>) {
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
	if (!started) return

	await appendJobLog(jobId, "out", "Kaikki dictionary: job started.")
	await appendJobLog(
		jobId,
		"out",
		filePath
			? `Kaikki: importing from file`
			: `Kaikki: streaming ${downloadUrls.length} URL(s), mode ${kaikkiMode ?? "default"}`,
	)

	let processed = 0
	let errors = 0
	let inserted = 0
	let skipped = 0
	let batchFlushCount = 0
	const BATCH_SIZE = 500
	const totalParts = !filePath ? downloadUrls.length : 1

	let batch: Array<{
		languageId: string
		lemma: string
		pos: "NOUN" | "VERB" | "ADJECTIVE" | "ADVERB"
		rank: number
		definitions: Prisma.InputJsonValue
		isOffensive: boolean
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

			const definitions: string[] = []
			let isOffensive = false

			for (const sense of entry.senses ?? []) {
				if (sense.glosses) {
					definitions.push(...sense.glosses)
				}
				const tags = [...(sense.tags ?? []), ...(sense.raw_tags ?? [])]
				if (tags.some((t) => OFFENSIVE_TAGS.has(t.toLowerCase()))) {
					isOffensive = true
				}
			}

			if (isOffensive) {
				skipped++
				return true
			}

			if (definitions.length === 0) {
				skipped++
				return true
			}

			batch.push({
				languageId,
				lemma,
				pos: mappedPos as "NOUN" | "VERB" | "ADJECTIVE" | "ADVERB",
				rank: 0,
				definitions: definitions as Prisma.InputJsonValue,
				isOffensive: false,
			})

			if (batch.length >= BATCH_SIZE) {
				const flushT0 = Date.now()
				const result = await flushBatch(batch, batchFlushCount + 1)
				const flushMs = Date.now() - flushT0
				inserted += result.inserted
				errors += result.errors
				batch = []
				batchFlushCount++
				const slow = flushMs >= 4000
				const sample = batchFlushCount <= 2 || batchFlushCount % 40 === 0
				if (slow || sample || result.flushPath === "upsertFallback") {
					kaikkiAgentLog({
						location: "kaikki.ts:handleLine:afterFlush",
						message: "post-flush timing",
						hypothesisId: result.flushPath === "upsertFallback" ? "H2" : slow ? "H4" : "H1",
						data: {
							batchFlushCount,
							flushMs,
							processed,
							insertedBatch: result.inserted,
							errorsBatch: result.errors,
							flushPath: result.flushPath,
							partIndex,
						},
					})
				}
				if (batchFlushCount === 1 || batchFlushCount % 5 === 0) {
					await appendJobLog(
						jobId,
						"out",
						`Kaikki flush ${batchFlushCount}: part ${partIndex}/${totalParts}, lines ${processed}, inserted ${inserted}`,
					)
				}
				const progT0 = Date.now()
				await updateIngestionProgress(jobId, {
					processedItems: processed,
					errorCount: errors,
					extraMetadata: {
						inserted,
						skipped,
						streaming: !filePath,
						kaikkiPart: partIndex,
						kaikkiParts: totalParts,
						kaikkiMode: kaikkiMode ?? null,
					},
				})
				const progMs = Date.now() - progT0
				if (progMs >= 3000) {
					kaikkiAgentLog({
						location: "kaikki.ts:handleLine:afterProgress",
						message: "updateIngestionProgress slow",
						hypothesisId: "H4",
						data: { progMs, batchFlushCount, processed },
					})
				}
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
				await appendJobLog(jobId, "out", `Kaikki: downloading part ${partIndex}/${downloadUrls.length}…`)
				for await (const line of linesFromUrl(url)) {
					if (!(await handleLine(line, partIndex))) return
				}
				await appendJobLog(jobId, "out", `Kaikki: finished part ${partIndex}/${downloadUrls.length}`)
			}
		}

		if (batch.length > 0) {
			const result = await flushBatch(batch, batchFlushCount + 1)
			inserted += result.inserted
			errors += result.errors
		}

		if (await isIngestionJobCancelled(jobId)) return

		await appendJobLog(
			jobId,
			"out",
			`Kaikki complete: ${inserted} inserted, ${skipped} skipped, ${errors} parse errors`,
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
					lines: processed,
					streaming: !filePath,
					downloadUrl: downloadUrl ?? null,
					downloadUrls: filePath ? null : downloadUrls,
					kaikkiMode: kaikkiMode ?? null,
				} as Prisma.InputJsonValue,
			},
		})
		if (done.count === 0) return

		console.log(`[kaikki] Done: ${inserted} inserted, ${skipped} skipped, ${errors} parse errors`)

		if (chainPipeline) {
			await chainFrequencyFromKaikki(languageId)
		}
	} catch (err) {
		console.error("[kaikki] Fatal error:", err)
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
				} as Prisma.InputJsonValue,
			},
		})
		throw err
	}
}

async function flushBatch(
	batch: Array<{
		languageId: string
		lemma: string
		pos: "NOUN" | "VERB" | "ADJECTIVE" | "ADVERB"
		rank: number
		definitions: Prisma.InputJsonValue
		isOffensive: boolean
	}>,
	_flushIndex: number,
): Promise<{ inserted: number; errors: number; flushPath: "createMany" | "upsertFallback" }> {
	let inserted = 0
	let errors = 0
	let flushPath: "createMany" | "upsertFallback" = "createMany"
	const dbT0 = Date.now()

	try {
		const result = await prisma.word.createMany({
			data: batch,
			skipDuplicates: true,
		})
		inserted = result.count
	} catch (err) {
		flushPath = "upsertFallback"
		kaikkiAgentLog({
			location: "kaikki.ts:flushBatch",
			message: "createMany failed, upsert fallback",
			hypothesisId: "H2",
			data: {
				flushIndex: _flushIndex,
				batchLen: batch.length,
				errName: err instanceof Error ? err.name : "unknown",
				errMsg: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
			},
		})
		for (const word of batch) {
			try {
				await prisma.word.upsert({
					where: {
						languageId_lemma_pos: {
							languageId: word.languageId,
							lemma: word.lemma,
							pos: word.pos,
						},
					},
					create: word,
					update: {
						definitions: word.definitions,
						isOffensive: word.isOffensive,
					},
				})
				inserted++
			} catch {
				errors++
			}
		}
	}

	const dbMs = Date.now() - dbT0
	if (dbMs >= 3500 || flushPath === "upsertFallback") {
		kaikkiAgentLog({
			location: "kaikki.ts:flushBatch:end",
			message: "flushBatch db timing",
			hypothesisId: flushPath === "upsertFallback" ? "H2" : "H4",
			data: {
				flushIndex: _flushIndex,
				dbMs,
				flushPath,
				batchLen: batch.length,
				inserted,
				errors,
			},
		})
	}

	return { inserted, errors, flushPath }
}
