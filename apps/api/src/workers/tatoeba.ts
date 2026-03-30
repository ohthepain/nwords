/// <reference path="../types/unbzip2-stream.d.ts" />
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { prisma, type Prisma } from "@nwords/db"
import type PgBoss from "pg-boss"
import bz2 from "unbzip2-stream"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"
import { nodeReadableFromWeb } from "../lib/node-streams"
import { linkSentencesAndAssignTests, type LinkingProgressEvent } from "./sentence-link"

/**
 * Tatoeba sentence import: plain TSV (upload) or .tsv.bz2 per-language export (HTTP).
 * Optionally links sentences to lemmas and assigns Word.testSentenceIds.
 */

export interface TatoebaJobData {
	jobId: string
	languageId: string
	filePath?: string
	downloadUrl?: string
	langCode: string
	translationLinksPath?: string
	chainPipeline?: boolean
}

async function* linesFromFilePlain(filePath: string): AsyncGenerator<string> {
	const input = createReadStream(filePath, "utf-8")
	const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
	try {
		for await (const line of rl) yield line
	} finally {
		rl.close()
	}
}

/**
 * Stream bzip2-compressed Tatoeba TSV over HTTP (per-language export).
 */
async function* linesFromBz2Url(url: string): AsyncGenerator<string> {
	const res = await fetch(url)
	if (!res.ok) {
		throw new Error(`Tatoeba download failed HTTP ${res.status}: ${url}`)
	}

	const input = nodeReadableFromWeb(res.body).pipe(bz2())
	const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
	try {
		for await (const line of rl) yield line
	} finally {
		rl.close()
	}
}

export async function processTatoebaJob(job: PgBoss.Job<TatoebaJobData>) {
	const {
		jobId,
		filePath,
		downloadUrl,
		languageId,
		langCode,
		translationLinksPath,
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

	await appendJobLog(jobId, "out", "Tatoeba sentences: job started.")
	await appendJobLog(
		jobId,
		"out",
		filePath
			? "Tatoeba: importing from local TSV"
			: "Tatoeba: streaming bzip2 export (line count unknown until done)",
	)

	let totalLines = 0
	let processed = 0
	let errors = 0
	let inserted = 0
	let skipped = 0
	let translationsLinked = 0
	let sentenceFlush = 0
	const BATCH_SIZE = 500

	try {
		if (filePath) {
			const countSource = linesFromFilePlain(filePath)
			for await (const _ of countSource) {
				totalLines++
			}
			await prisma.ingestionJob.update({
				where: { id: jobId },
				data: { totalItems: totalLines },
			})
			await appendJobLog(jobId, "out", `Tatoeba: file has ${totalLines.toLocaleString()} lines (all langs)`)
		}
		// HTTP downloads: total line count unknown up front (no double-fetch of multi‑GB bz2).

		const tatoebaUrl = downloadUrl
		if (!filePath && !tatoebaUrl) {
			throw new Error("downloadUrl missing")
		}
		const readSource = filePath
			? linesFromFilePlain(filePath)
			: linesFromBz2Url(tatoebaUrl as string)

		let batch: Array<{
			tatoebaId: number
			languageId: string
			text: string
		}> = []

		for await (const line of readSource) {
			processed++

			const trimmed = line.trim()
			if (!trimmed) continue

			const parts = trimmed.split("\t")
			if (parts.length < 3) continue

			const sentenceId = Number.parseInt(parts[0], 10)
			const sentenceLang = parts[1]
			const text = parts[2]

			if (sentenceLang !== langCode) {
				skipped++
				continue
			}

			if (Number.isNaN(sentenceId) || !text.trim()) {
				skipped++
				continue
			}

			batch.push({
				tatoebaId: sentenceId,
				languageId,
				text: text.trim(),
			})

			if (batch.length >= BATCH_SIZE) {
				const result = await flushSentenceBatch(batch)
				inserted += result.inserted
				errors += result.errors
				batch = []

				sentenceFlush++
				if (sentenceFlush === 1 || sentenceFlush % 15 === 0) {
					await appendJobLog(
						jobId,
						"out",
						`Tatoeba import: batch ${sentenceFlush}, lines scanned ${processed.toLocaleString()}, sentences inserted ${inserted}`,
					)
				}
				await updateIngestionProgress(jobId, {
					processedItems: processed,
					errorCount: errors,
					extraMetadata: { inserted, skipped, phase: "import" },
				})
				if (await isIngestionJobCancelled(jobId)) {
					console.log(`[tatoeba] Job ${jobId} cancelled, stopping import loop`)
					return
				}
			}
		}

		if (batch.length > 0) {
			const result = await flushSentenceBatch(batch)
			inserted += result.inserted
			errors += result.errors
		}

		if (await isIngestionJobCancelled(jobId)) {
			console.log(`[tatoeba] Job ${jobId} cancelled before translation / linking`)
			return
		}

		await appendJobLog(
			jobId,
			"out",
			`Tatoeba: sentence import pass done — ${inserted} inserted, ${skipped} skipped, ${errors} row errors`,
		)

		if (translationLinksPath) {
			await appendJobLog(jobId, "out", "Tatoeba: processing translation links file…")
			translationsLinked = await processTranslationLinks(translationLinksPath)
			await appendJobLog(jobId, "out", `Tatoeba: linked ${translationsLinked} translation pairs`)
		}

		let linkStats = { sentencesProcessed: 0, linksCreated: 0, candidates: 0 }
		if (chainPipeline !== false) {
			await appendJobLog(jobId, "out", "Tatoeba: linking sentences to lemmas / test assignments…")
			const LINK_DETAIL_LOG_MS = 5000
			let lastDetailLogAt = 0
			let linkBatchCount = 0

			const maybeLogLinking = async (msg: string, force: boolean) => {
				const t = Date.now()
				if (force || t - lastDetailLogAt >= LINK_DETAIL_LOG_MS) {
					lastDetailLogAt = t
					await appendJobLog(jobId, "out", msg)
				}
			}

			linkStats = await linkSentencesAndAssignTests(
				languageId,
				async (ev: LinkingProgressEvent) => {
					if (ev.kind === "link_batch") {
						linkBatchCount++
						await updateIngestionProgress(jobId, {
							extraMetadata: {
								phase: "linking",
								linkingSentencesProcessed: ev.sentencesProcessed,
								linkingLinksCreated: ev.linksCreated,
								linkingCandidates: ev.candidates,
							},
						})
						const detail = `Tatoeba linking: ${ev.sentencesProcessed} sentences scored, ${ev.linksCreated} word–sentence links, ${ev.candidates} candidates (+${ev.batchSentenceCount} in batch)`
						await maybeLogLinking(detail, linkBatchCount === 1)
						return
					}
					await updateIngestionProgress(jobId, {
						extraMetadata: {
							phase: "assign_test_sentences",
							assignWordsDone: ev.wordsProcessed,
							assignWordsTotal: ev.wordsTotal,
						},
					})
					if (ev.wordsTotal === 0) return
					const detail =
						ev.wordsProcessed === 0
							? `Tatoeba: picking test sentences for up to ${ev.wordsTotal.toLocaleString()} dictionary words…`
							: `Tatoeba assign-tests: ${ev.wordsProcessed.toLocaleString()}/${ev.wordsTotal.toLocaleString()} words`
					await maybeLogLinking(detail, ev.wordsProcessed === 0)
				},
			)
		}

		await appendJobLog(
			jobId,
			"out",
			`Tatoeba complete: ${linkStats.linksCreated} links, ${linkStats.candidates} candidates`,
		)

		const prevMeta = await snapshotJobMetadata(jobId)

		const finished = await prisma.ingestionJob.updateMany({
			where: { id: jobId, status: "RUNNING" },
			data: {
				status: "COMPLETED",
				processedItems: processed,
				totalItems: filePath ? totalLines : processed,
				errorCount: errors,
				completedAt: new Date(),
				metadata: {
					...prevMeta,
					inserted,
					skipped,
					translationsLinked,
					linesSeen: processed,
					sourceLines: filePath ? totalLines : null,
					phase: "done",
					linking: linkStats,
					downloadUrl: downloadUrl ?? null,
				} as Prisma.InputJsonValue,
			},
		})
		if (finished.count === 0) return

		console.log(
			`[tatoeba] Done: ${inserted} sentences, link ${linkStats.linksCreated}, candidates ${linkStats.candidates}`,
		)
	} catch (err) {
		console.error("[tatoeba] Fatal error:", err)
		if (await isIngestionJobCancelled(jobId)) return
		await appendJobLog(jobId, "err", String(err))
		const prevFail = await snapshotJobMetadata(jobId)
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				processedItems: processed,
				errorCount: errors,
				completedAt: new Date(),
				metadata: {
					...prevFail,
					error: String(err),
					inserted,
					skipped,
				} as Prisma.InputJsonValue,
			},
		})
		throw err
	}
}

async function flushSentenceBatch(
	batch: Array<{ tatoebaId: number; languageId: string; text: string }>,
): Promise<{ inserted: number; errors: number }> {
	let inserted = 0
	let errors = 0

	try {
		const result = await prisma.sentence.createMany({
			data: batch,
			skipDuplicates: true,
		})
		inserted = result.count
	} catch {
		for (const sentence of batch) {
			try {
				await prisma.sentence.upsert({
					where: { tatoebaId: sentence.tatoebaId },
					create: sentence,
					update: { text: sentence.text },
				})
				inserted++
			} catch {
				errors++
			}
		}
	}

	return { inserted, errors }
}

async function processTranslationLinks(linksPath: string): Promise<number> {
	let linked = 0
	const BATCH_SIZE = 500

	const readStream = createReadStream(linksPath, "utf-8")
	const rl = createInterface({ input: readStream })

	let batch: Array<{ origTatoebaId: number; transTatoebaId: number }> = []

	for await (const line of rl) {
		const trimmed = line.trim()
		if (!trimmed) continue

		const parts = trimmed.split("\t")
		if (parts.length < 2) continue

		const origId = Number.parseInt(parts[0], 10)
		const transId = Number.parseInt(parts[1], 10)

		if (Number.isNaN(origId) || Number.isNaN(transId)) continue

		batch.push({ origTatoebaId: origId, transTatoebaId: transId })

		if (batch.length >= BATCH_SIZE) {
			linked += await flushLinkBatch(batch)
			batch = []
		}
	}

	if (batch.length > 0) {
		linked += await flushLinkBatch(batch)
	}

	return linked
}

async function flushLinkBatch(
	batch: Array<{ origTatoebaId: number; transTatoebaId: number }>,
): Promise<number> {
	let linked = 0

	const allTatoebaIds = [...new Set(batch.flatMap((b) => [b.origTatoebaId, b.transTatoebaId]))]

	const sentences = await prisma.sentence.findMany({
		where: { tatoebaId: { in: allTatoebaIds } },
		select: { id: true, tatoebaId: true },
	})

	const idMap = new Map<number, string>()
	for (const s of sentences) {
		if (s.tatoebaId !== null) {
			idMap.set(s.tatoebaId, s.id)
		}
	}

	const creates = []
	for (const { origTatoebaId, transTatoebaId } of batch) {
		const origId = idMap.get(origTatoebaId)
		const transId = idMap.get(transTatoebaId)
		if (!origId || !transId) continue

		creates.push({
			originalSentenceId: origId,
			translatedSentenceId: transId,
		})
	}

	if (creates.length > 0) {
		try {
			const result = await prisma.sentenceTranslation.createMany({
				data: creates,
				skipDuplicates: true,
			})
			linked = result.count
		} catch {
			// ignore duplicate errors
		}
	}

	return linked
}
