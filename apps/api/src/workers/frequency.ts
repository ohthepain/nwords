import { createReadStream } from "node:fs"
import { prisma } from "@nwords/db"
import type PgBoss from "pg-boss"
import { updateIngestionProgress } from "../lib/job-progress.ts"
import { nodeReadableFromWeb, readLinesFromReadable } from "../lib/node-streams.ts"
import { chainTatoebaFromFrequency } from "../lib/pipeline-chain.ts"

/**
 * Frequency list importer: TSV/CSV (rank ↔ lemma) or bnpd/freqListsLemmatized (lemma first, rank = line #).
 */

export interface FrequencyJobData {
	jobId: string
	languageId: string
	filePath?: string
	downloadUrl?: string
	source: string
	/** `tsv` = rank/lemma columns; `bnpd` = first token per line is lemma, order = frequency; `hermitdave` = `{word} {count}` lines, rank = line order */
	format?: "tsv" | "bnpd" | "hermitdave"
	chainPipeline?: boolean
}

async function* linesFromFile(filePath: string): AsyncGenerator<string> {
	const input = createReadStream(filePath)
	try {
		yield* readLinesFromReadable(input)
	} finally {
		input.destroy()
	}
}

async function* linesFromUrl(url: string): AsyncGenerator<string> {
	const res = await fetch(url)
	if (!res.ok) {
		throw new Error(`Frequency download failed HTTP ${res.status}: ${url}`)
	}
	const input = nodeReadableFromWeb(res.body)
	try {
		yield* readLinesFromReadable(input)
	} finally {
		input.destroy()
	}
}

export async function processFrequencyJob(job: PgBoss.Job<FrequencyJobData>) {
	const {
		jobId,
		filePath,
		downloadUrl,
		languageId,
		source,
		format = "tsv",
		chainPipeline,
	} = job.data

	if (!filePath && !downloadUrl) {
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: { error: "Either filePath or downloadUrl is required" },
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
	let updated = 0
	let notFound = 0
	const BATCH_SIZE = 500

	try {
		const url = downloadUrl
		if (!filePath && !url) {
			throw new Error("downloadUrl missing")
		}
		const lines = filePath ? linesFromFile(filePath) : linesFromUrl(url as string)

		if (format === "hermitdave") {
			let lineRank = 0
			let batchH: Array<{ lemma: string; rank: number }> = []

			for await (const line of lines) {
				processed++
				const trimmed = line.trim()
				if (!trimmed || trimmed.startsWith("#")) continue

				const m = trimmed.match(/^(.+?)\s+(\d+)$/)
				if (!m) continue

				const lemma = m[1].trim().toLowerCase()
				if (!lemma) continue

				lineRank++
				batchH.push({ lemma, rank: lineRank })

				if (batchH.length >= BATCH_SIZE) {
					const r = await flushRankBatch(batchH, languageId)
					updated += r.updated
					notFound += r.notFound
					errors += r.errors
					batchH = []
					await updateIngestionProgress(jobId, {
						processedItems: processed,
						errorCount: errors,
						extraMetadata: { updated, notFound, format: "hermitdave" },
					})
				}
			}

			if (batchH.length > 0) {
				const r = await flushRankBatch(batchH, languageId)
				updated += r.updated
				notFound += r.notFound
				errors += r.errors
			}

			await prisma.frequencyList.upsert({
				where: { languageId_source: { languageId, source } },
				create: { languageId, source },
				update: { importedAt: new Date() },
			})

			await prisma.ingestionJob.update({
				where: { id: jobId },
				data: {
					status: "COMPLETED",
					processedItems: processed,
					totalItems: processed,
					errorCount: errors,
					completedAt: new Date(),
					metadata: { updated, notFound, format: "hermitdave", lines: processed },
				},
			})

			console.log(
				`[frequency/hermitdave] Done: ${updated} ranks applied, ${notFound} missing lemmas`,
			)

			if (chainPipeline) {
				await chainTatoebaFromFrequency(languageId)
			}
			return
		}

		if (format === "bnpd") {
			let lineRank = 0
			let batch: Array<{ lemma: string; rank: number }> = []

			for await (const line of lines) {
				processed++
				const trimmed = line.trim()
				if (!trimmed || trimmed.startsWith("#")) continue

				lineRank++
				const lemma = trimmed.split(/\s+/)[0]?.toLowerCase()
				if (!lemma) continue

				batch.push({ lemma, rank: lineRank })

				if (batch.length >= BATCH_SIZE) {
					const r = await flushRankBatch(batch, languageId)
					updated += r.updated
					notFound += r.notFound
					errors += r.errors
					batch = []
					await updateIngestionProgress(jobId, {
						processedItems: processed,
						errorCount: errors,
						extraMetadata: { updated, notFound, format: "bnpd" },
					})
				}
			}

			if (batch.length > 0) {
				const r = await flushRankBatch(batch, languageId)
				updated += r.updated
				notFound += r.notFound
				errors += r.errors
			}

			await prisma.frequencyList.upsert({
				where: { languageId_source: { languageId, source } },
				create: { languageId, source },
				update: { importedAt: new Date() },
			})

			await prisma.ingestionJob.update({
				where: { id: jobId },
				data: {
					status: "COMPLETED",
					processedItems: processed,
					totalItems: processed,
					errorCount: errors,
					completedAt: new Date(),
					metadata: { updated, notFound, format: "bnpd", lines: processed },
				},
			})

			console.log(`[frequency/bnpd] Done: ${updated} ranks applied, ${notFound} missing lemmas`)

			if (chainPipeline) {
				await chainTatoebaFromFrequency(languageId)
			}
			return
		}

		// ─── TSV / CSV (original behaviour) ───
		let totalLines = 0
		for await (const _ of lines) {
			totalLines++
		}

		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: { totalItems: totalLines },
		})

		const lines2 = filePath ? linesFromFile(filePath) : linesFromUrl(url as string)

		let batch: Array<{ lemma: string; rank: number }> = []
		let detectedFormat: "rank_word" | "word_rank" | null = null
		let processed2 = 0

		for await (const line of lines2) {
			processed2++

			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith("#")) continue

			const sep = trimmed.includes("\t") ? "\t" : ","
			const parts = trimmed.split(sep).map((p) => p.trim())

			if (parts.length < 2) continue

			if (detectedFormat === null) {
				detectedFormat = /^\d+$/.test(parts[0]) ? "rank_word" : "word_rank"
			}

			let rank: number
			let lemma: string

			if (detectedFormat === "rank_word") {
				rank = Number.parseInt(parts[0], 10)
				lemma = parts[1].toLowerCase()
			} else {
				lemma = parts[0].toLowerCase()
				rank = Number.parseInt(parts[1], 10)
			}

			if (Number.isNaN(rank) || !lemma) continue

			batch.push({ lemma, rank })

			if (batch.length >= BATCH_SIZE) {
				const result = await flushRankBatch(batch, languageId)
				updated += result.updated
				notFound += result.notFound
				errors += result.errors
				batch = []

				await updateIngestionProgress(jobId, {
					processedItems: processed2,
					errorCount: errors,
				})
			}
		}

		if (batch.length > 0) {
			const result = await flushRankBatch(batch, languageId)
			updated += result.updated
			notFound += result.notFound
			errors += result.errors
		}

		await prisma.frequencyList.upsert({
			where: { languageId_source: { languageId, source } },
			create: { languageId, source },
			update: { importedAt: new Date() },
		})

		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "COMPLETED",
				processedItems: processed2,
				errorCount: errors,
				completedAt: new Date(),
				metadata: { updated, notFound, totalLines, format: "tsv" },
			},
		})

		console.log(`[frequency] Done: ${updated} updated, ${notFound} not found, ${errors} errors`)

		if (chainPipeline) {
			await chainTatoebaFromFrequency(languageId)
		}
	} catch (err) {
		console.error("[frequency] Fatal error:", err)
		const snap = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { processedItems: true, metadata: true },
		})
		const prevMeta = (snap?.metadata ?? {}) as Record<string, unknown>
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				processedItems: snap?.processedItems ?? 0,
				errorCount: errors,
				completedAt: new Date(),
				metadata: { ...prevMeta, error: String(err), updated, notFound },
			},
		})
		throw err
	}
}

async function flushRankBatch(
	batch: Array<{ lemma: string; rank: number }>,
	languageId: string,
): Promise<{ updated: number; notFound: number; errors: number }> {
	let updated = 0
	let notFound = 0
	let errors = 0

	const lemmas = batch.map((b) => b.lemma)
	try {
		const existingWords = await prisma.word.findMany({
			where: { languageId, lemma: { in: lemmas } },
			select: { id: true, lemma: true },
		})

		const wordByLemma = new Map<string, string[]>()
		for (const w of existingWords) {
			const ids = wordByLemma.get(w.lemma) ?? []
			ids.push(w.id)
			wordByLemma.set(w.lemma, ids)
		}

		const updates = []
		for (const { lemma, rank } of batch) {
			const wordIds = wordByLemma.get(lemma)
			if (!wordIds) {
				notFound++
				continue
			}
			for (const id of wordIds) {
				updates.push(prisma.word.update({ where: { id }, data: { rank } }))
			}
		}

		if (updates.length > 0) {
			await prisma.$transaction(updates)
			updated += updates.length
		}
	} catch {
		errors += batch.length
	}

	return { updated, notFound, errors }
}
