import { createReadStream } from "node:fs"
import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import type PgBoss from "pg-boss"
import { cefrLevelForFrequencyRank } from "@nwords/shared"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"
import { nodeReadableFromWeb, readLinesFromReadable } from "../lib/node-streams"
import { chainTatoebaFromFrequency } from "../lib/pipeline-chain"

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

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) return

	await appendJobLog(jobId, "out", "Frequency list: job started.")
	await appendJobLog(
		jobId,
		"out",
		`Frequency (${format}): applying ranks — ${filePath ? "local file" : "download"}`,
	)

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
			let hermitFlush = 0

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
					hermitFlush++
					if (hermitFlush === 1 || hermitFlush % 20 === 0) {
						await appendJobLog(
							jobId,
							"out",
							`Frequency hermitdave: flush ${hermitFlush}, lines scanned ${processed}, ranks applied ${updated}`,
						)
					}
					await updateIngestionProgress(jobId, {
						processedItems: processed,
						errorCount: errors,
						extraMetadata: { updated, notFound, format: "hermitdave" },
					})
					if (await isIngestionJobCancelled(jobId)) return
				}
			}

			if (batchH.length > 0) {
				const r = await flushRankBatch(batchH, languageId)
				updated += r.updated
				notFound += r.notFound
				errors += r.errors
			}

			if (await isIngestionJobCancelled(jobId)) return

			await prisma.frequencyList.upsert({
				where: { languageId_source: { languageId, source } },
				create: { languageId, source },
				update: { importedAt: new Date() },
			})

			await appendJobLog(
				jobId,
				"out",
				`Frequency hermitdave: complete — ${updated} rank updates, ${notFound} lemmas not in dictionary`,
			)
			const prevH = await snapshotJobMetadata(jobId)
			const doneH = await prisma.ingestionJob.updateMany({
				where: { id: jobId, status: "RUNNING" },
				data: {
					status: "COMPLETED",
					processedItems: processed,
					totalItems: processed,
					errorCount: errors,
					completedAt: new Date(),
					metadata: {
						...prevH,
						updated,
						notFound,
						format: "hermitdave",
						lines: processed,
					} as Prisma.InputJsonValue,
				},
			})
			if (doneH.count === 0) return

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
			let bnpdFlush = 0

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
					bnpdFlush++
					if (bnpdFlush === 1 || bnpdFlush % 20 === 0) {
						await appendJobLog(
							jobId,
							"out",
							`Frequency bnpd: flush ${bnpdFlush}, lines ${processed}, ranks applied ${updated}`,
						)
					}
					await updateIngestionProgress(jobId, {
						processedItems: processed,
						errorCount: errors,
						extraMetadata: { updated, notFound, format: "bnpd" },
					})
					if (await isIngestionJobCancelled(jobId)) return
				}
			}

			if (batch.length > 0) {
				const r = await flushRankBatch(batch, languageId)
				updated += r.updated
				notFound += r.notFound
				errors += r.errors
			}

			if (await isIngestionJobCancelled(jobId)) return

			await prisma.frequencyList.upsert({
				where: { languageId_source: { languageId, source } },
				create: { languageId, source },
				update: { importedAt: new Date() },
			})

			await appendJobLog(
				jobId,
				"out",
				`Frequency bnpd: complete — ${updated} updates, ${notFound} lemmas missing`,
			)
			const prevB = await snapshotJobMetadata(jobId)
			const doneB = await prisma.ingestionJob.updateMany({
				where: { id: jobId, status: "RUNNING" },
				data: {
					status: "COMPLETED",
					processedItems: processed,
					totalItems: processed,
					errorCount: errors,
					completedAt: new Date(),
					metadata: {
						...prevB,
						updated,
						notFound,
						format: "bnpd",
						lines: processed,
					} as Prisma.InputJsonValue,
				},
			})
			if (doneB.count === 0) return

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
		await appendJobLog(jobId, "out", `Frequency TSV: counted ${totalLines} lines, applying ranks…`)

		const lines2 = filePath ? linesFromFile(filePath) : linesFromUrl(url as string)

		let batch: Array<{ lemma: string; rank: number }> = []
		let detectedFormat: "rank_word" | "word_rank" | null = null
		let processed2 = 0
		let tsvFlush = 0

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
				tsvFlush++
				if (tsvFlush === 1 || tsvFlush % 20 === 0) {
					await appendJobLog(
						jobId,
						"out",
						`Frequency TSV: flush ${tsvFlush}, lines ${processed2}/${totalLines}, ranks applied ${updated}`,
					)
				}

				await updateIngestionProgress(jobId, {
					processedItems: processed2,
					errorCount: errors,
				})
				if (await isIngestionJobCancelled(jobId)) return
			}
		}

		if (batch.length > 0) {
			const result = await flushRankBatch(batch, languageId)
			updated += result.updated
			notFound += result.notFound
			errors += result.errors
		}

		if (await isIngestionJobCancelled(jobId)) return

		await prisma.frequencyList.upsert({
			where: { languageId_source: { languageId, source } },
			create: { languageId, source },
			update: { importedAt: new Date() },
		})

		await appendJobLog(
			jobId,
			"out",
			`Frequency TSV: complete — ${updated} updates, ${notFound} lemmas missing`,
		)
		const prevT = await snapshotJobMetadata(jobId)
		const doneT = await prisma.ingestionJob.updateMany({
			where: { id: jobId, status: "RUNNING" },
			data: {
				status: "COMPLETED",
				processedItems: processed2,
				errorCount: errors,
				completedAt: new Date(),
				metadata: {
					...prevT,
					updated,
					notFound,
					totalLines,
					format: "tsv",
				} as Prisma.InputJsonValue,
			},
		})
		if (doneT.count === 0) return

		console.log(`[frequency] Done: ${updated} updated, ${notFound} not found, ${errors} errors`)

		if (chainPipeline) {
			await chainTatoebaFromFrequency(languageId)
		}
	} catch (err) {
		console.error("[frequency] Fatal error:", err)
		if (await isIngestionJobCancelled(jobId)) return
		await appendJobLog(jobId, "err", String(err))
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
				metadata: {
					...prevMeta,
					error: String(err),
					updated,
					notFound,
				} as Prisma.InputJsonValue,
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
			const cefrLevel = cefrLevelForFrequencyRank(rank)
			for (const id of wordIds) {
				updates.push(prisma.word.update({ where: { id }, data: { rank, cefrLevel } }))
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
