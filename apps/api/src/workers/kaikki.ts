import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import type PgBoss from "pg-boss"
import type { KaikkiIngestMode } from "../lib/ingestion-urls.ts"
import { updateIngestionProgress } from "../lib/job-progress.ts"
import { nodeReadableFromWeb } from "../lib/node-streams.ts"
import { chainFrequencyFromKaikki } from "../lib/pipeline-chain.ts"

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

	await prisma.ingestionJob.update({
		where: { id: jobId },
		data: { status: "RUNNING", startedAt: new Date() },
	})

	let processed = 0
	let errors = 0
	let inserted = 0
	let skipped = 0
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

	async function handleLine(line: string, partIndex: number) {
		processed++
		if (!line.trim()) return

		try {
			const entry: KaikkiEntry = JSON.parse(line)

			const mappedPos = POS_MAP[entry.pos?.toLowerCase() ?? ""]
			if (!mappedPos) {
				skipped++
				return
			}

			const lemma = entry.word?.trim()?.toLowerCase()
			if (!lemma) {
				skipped++
				return
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
				return
			}

			if (definitions.length === 0) {
				skipped++
				return
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
				const result = await flushBatch(batch)
				inserted += result.inserted
				errors += result.errors
				batch = []
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
			}
		} catch {
			errors++
		}
	}

	try {
		if (filePath) {
			for await (const line of linesFromFile(filePath)) {
				await handleLine(line, 1)
			}
		} else {
			for (let p = 0; p < downloadUrls.length; p++) {
				const url = downloadUrls[p]
				const partIndex = p + 1
				for await (const line of linesFromUrl(url)) {
					await handleLine(line, partIndex)
				}
			}
		}

		if (batch.length > 0) {
			const result = await flushBatch(batch)
			inserted += result.inserted
			errors += result.errors
		}

		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "COMPLETED",
				processedItems: processed,
				totalItems: processed,
				errorCount: errors,
				completedAt: new Date(),
				metadata: {
					inserted,
					skipped,
					lines: processed,
					streaming: !filePath,
					downloadUrl: downloadUrl ?? null,
					downloadUrls: filePath ? null : downloadUrls,
					kaikkiMode: kaikkiMode ?? null,
				} as object,
			},
		})

		console.log(`[kaikki] Done: ${inserted} inserted, ${skipped} skipped, ${errors} parse errors`)

		if (chainPipeline) {
			await chainFrequencyFromKaikki(languageId)
		}
	} catch (err) {
		console.error("[kaikki] Fatal error:", err)
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				processedItems: processed,
				errorCount: errors,
				completedAt: new Date(),
				metadata: { error: String(err), inserted, skipped },
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
): Promise<{ inserted: number; errors: number }> {
	let inserted = 0
	let errors = 0

	try {
		const result = await prisma.word.createMany({
			data: batch,
			skipDuplicates: true,
		})
		inserted = result.count
	} catch {
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

	return { inserted, errors }
}
