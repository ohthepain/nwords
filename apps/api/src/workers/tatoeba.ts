/// <reference path="../types/unbzip2-stream.d.ts" />
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { prisma, type Prisma } from "@nwords/db"
import type PgBoss from "pg-boss"
import bz2 from "unbzip2-stream"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"
import { tatoebaPairLinksBz2Url } from "../lib/ingestion-urls"
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

/** Tatoeba TSV `lang` column vs our pipeline `langCode` (usually ISO 639-3, e.g. vie). */
function tatoebaLangMatches(column: string, langCode: string): boolean {
	const c = column.toLowerCase()
	const l = langCode.toLowerCase()
	if (c === l) return true
	// Vietnamese: Tatoeba exports sometimes use 639-1 `vi` in the column.
	if ((l === "vie" && c === "vi") || (l === "vi" && c === "vie")) return true
	return false
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
	if (!started) {
		const row = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[tatoeba] skipped job ${jobId}: could not claim (ingestion status=${row?.status ?? "missing"})`,
		)
		return
	}

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
	/** Log progress while streaming huge bz2 files (batch logs alone go quiet for long gaps). */
	let lastHeartbeatAt = Date.now()
	const HEARTBEAT_MS = 45_000

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

			if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
				lastHeartbeatAt = Date.now()
				await appendJobLog(
					jobId,
					"out",
					`Tatoeba import: still streaming… ${processed.toLocaleString()} lines read, ${inserted.toLocaleString()} sentences inserted, ${skipped.toLocaleString()} lines skipped (other languages in TSV)`,
				)
				await updateIngestionProgress(jobId, {
					processedItems: processed,
					errorCount: errors,
					extraMetadata: { inserted, skipped, phase: "import" },
				})
				if (await isIngestionJobCancelled(jobId)) {
					console.log(`[tatoeba] Job ${jobId} cancelled during import heartbeat`)
					return
				}
			}

			const trimmed = line.trim()
			if (!trimmed) continue

			const parts = trimmed.split("\t")
			if (parts.length < 3) continue

			const sentenceId = Number.parseInt(parts[0], 10)
			const sentenceLang = parts[1]
			const text = parts[2]

			if (!tatoebaLangMatches(sentenceLang, langCode)) {
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
				lastHeartbeatAt = Date.now()
				if (sentenceFlush === 1 || sentenceFlush % 5 === 0) {
					await appendJobLog(
						jobId,
						"out",
						`Tatoeba import: batch ${sentenceFlush}, lines scanned ${processed.toLocaleString()}, sentences inserted ${inserted.toLocaleString()}`,
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

		if (chainPipeline !== false) {
			const fromExports = await importCrossLanguageLinksFromTatoeba(jobId, langCode)
			translationsLinked += fromExports
		}

		if (translationLinksPath) {
			await appendJobLog(jobId, "out", "Tatoeba: processing translation links file…")
			translationsLinked += await processTranslationLinks(translationLinksPath)
			await appendJobLog(jobId, "out", `Tatoeba: linked ${translationsLinked} translation pairs (total incl. exports)`)
		} else if (translationsLinked > 0) {
			await appendJobLog(
				jobId,
				"out",
				`Tatoeba: ${translationsLinked.toLocaleString()} translation pair rows from Tatoeba exports (for parallel hints)`,
			)
		}

		let linkStats = { sentencesProcessed: 0, linksCreated: 0, candidates: 0 }
		if (chainPipeline !== false) {
			await appendJobLog(
				jobId,
				"out",
				"Tatoeba: starting sentence–lemma linking. Large languages can take a long time; progress logs appear below.",
			)
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

async function consumeTranslationLinkLines(lineSource: AsyncIterable<string>): Promise<number> {
	let linked = 0
	const BATCH_SIZE = 500
	let batch: Array<{ origTatoebaId: number; transTatoebaId: number }> = []

	for await (const line of lineSource) {
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

async function processTranslationLinks(linksPath: string): Promise<number> {
	const readStream = createReadStream(linksPath, "utf-8")
	const rl = createInterface({ input: readStream })
	try {
		return await consumeTranslationLinkLines(rl)
	} finally {
		rl.close()
	}
}

/**
 * Import Tatoeba `{base}-{partner}_links.tsv.bz2` for each other enabled language so cloze hints can use parallels.
 * Pairs are only stored when both Tatoeba sentence ids already exist (run after each language’s sentence import).
 */
async function importCrossLanguageLinksFromTatoeba(jobId: string, baseLangCode3: string): Promise<number> {
	const self = baseLangCode3.toLowerCase()
	const partners = await prisma.language.findMany({
		where: { enabled: true, code3: { not: null } },
		select: { code3: true, name: true },
	})

	let total = 0
	for (const row of partners) {
		const other = row.code3!.toLowerCase()
		if (other === self) continue

		if (await isIngestionJobCancelled(jobId)) {
			return total
		}

		const url = tatoebaPairLinksBz2Url(self, other)
		try {
			const head = await fetch(url, { method: "HEAD", redirect: "follow" })
			if (!head.ok) {
				await appendJobLog(
					jobId,
					"out",
					`Tatoeba translation links: no weekly export for ${self}→${other} (HTTP ${head.status}); hints may need the other language’s Tatoeba import first`,
				)
				continue
			}
		} catch (err) {
			await appendJobLog(
				jobId,
				"err",
				`Tatoeba translation links: could not check ${self}→${other}: ${String(err)}`,
			)
			continue
		}

		await appendJobLog(jobId, "out", `Tatoeba translation links: importing ${self}↔${other}…`)
		try {
			const n = await consumeTranslationLinkLines(linesFromBz2Url(url))
			total += n
			await appendJobLog(
				jobId,
				"out",
				`Tatoeba translation links: ${self}↔${other} — ${n.toLocaleString()} pairs linked (both sentences must exist in DB)`,
			)
		} catch (err) {
			await appendJobLog(jobId, "err", `Tatoeba translation links ${self}↔${other}: ${String(err)}`)
		}
	}

	return total
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
		const a = idMap.get(origTatoebaId)
		const b = idMap.get(transTatoebaId)
		if (!a || !b || a === b) continue
		// Canonical order so eng→vie and vie→eng Tatoeba exports dedupe on @@unique([originalSentenceId, translatedSentenceId]).
		const [originalSentenceId, translatedSentenceId] = a < b ? [a, b] : [b, a]
		creates.push({ originalSentenceId, translatedSentenceId })
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
