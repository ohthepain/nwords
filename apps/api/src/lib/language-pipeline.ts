import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { prisma } from "@nwords/db"
import { getBoss } from "./boss"
import { INGEST_QUEUE } from "./ingestion-queues"
import { resolveKaikkiDownloadPlan } from "./ingestion-urls"

const UPLOAD_DIR = path.join(process.cwd(), "uploads")

/**
 * Start full dictionary + frequency + Tatoeba pipeline when a language is first enabled.
 * Kaikki: prefers four per-POS JSONL streams (pos-noun, …) when available; else monolith `.jsonl`.
 */
export async function enqueueLanguageIngestionPipeline(
	languageId: string,
): Promise<{ jobId: string } | null> {
	const lang = await prisma.language.findUnique({ where: { id: languageId } })
	if (!lang) return null

	// Drop finished / queued rows. Then cancel any RUNNING workers for this language so Re-import
	// does not leave duplicate Tatoeba (etc.) jobs streaming the same export.
	await prisma.ingestionJob.deleteMany({
		where: {
			languageId,
			status: { in: ["COMPLETED", "FAILED", "CANCELLED", "PENDING"] },
		},
	})
	await prisma.ingestionJob.updateMany({
		where: { languageId, status: "RUNNING" },
		data: { status: "CANCELLED", completedAt: new Date() },
	})

	const dictionaryLabel = (lang.kaikkiDictionaryName ?? lang.name).trim()
	const { downloadUrls, mode } = await resolveKaikkiDownloadPlan(dictionaryLabel)

	await mkdir(UPLOAD_DIR, { recursive: true })

	const job = await prisma.ingestionJob.create({
		data: {
			type: "KAIKKI_WORDS",
			languageId,
			metadata: {
				downloadUrls,
				kaikkiMode: mode,
				chainPipeline: true,
				kaikkiDictionaryName: dictionaryLabel,
				source: "kaikki.org",
				languageCode: lang.code,
				languageName: lang.name,
			},
		},
	})

	try {
		const boss = await getBoss()
		await boss.send(INGEST_QUEUE.KAIKKI, {
			jobId: job.id,
			languageId,
			downloadUrls,
			kaikkiMode: mode,
			chainPipeline: true,
		})
	} catch (err) {
		const base =
			job.metadata !== null && typeof job.metadata === "object" && !Array.isArray(job.metadata)
				? { ...(job.metadata as Record<string, unknown>) }
				: {}
		await prisma.ingestionJob.update({
			where: { id: job.id },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: { ...base, error: String(err), stage: "pg-boss-send" },
			},
		})
		throw err
	}

	return { jobId: job.id }
}

/**
 * Manual file-based job (existing admin UI) — optional chain disabled by default.
 */
export async function enqueueKaikkiFromFile(
	languageId: string,
	filePath: string,
	meta: Record<string, unknown>,
): Promise<{ jobId: string }> {
	const job = await prisma.ingestionJob.create({
		data: {
			type: "KAIKKI_WORDS",
			languageId,
			metadata: { ...meta, filePath },
		},
	})

	try {
		const boss = await getBoss()
		await boss.send(INGEST_QUEUE.KAIKKI, {
			jobId: job.id,
			languageId,
			filePath,
			chainPipeline: false,
		})
	} catch (err) {
		const base =
			job.metadata !== null && typeof job.metadata === "object" && !Array.isArray(job.metadata)
				? { ...(job.metadata as Record<string, unknown>) }
				: {}
		await prisma.ingestionJob.update({
			where: { id: job.id },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: { ...base, error: String(err), stage: "pg-boss-send" },
			},
		})
		throw err
	}

	return { jobId: job.id }
}

/** Persist uploaded buffer for workers that still expect a local path. */
export async function saveUploadToDisk(
	languageCode: string,
	type: string,
	originalName: string,
	buffer: Buffer,
): Promise<string> {
	await mkdir(UPLOAD_DIR, { recursive: true })
	const filename = `${Date.now()}-${languageCode}-${type.toLowerCase()}-${originalName.replace(/[^\w.-]+/g, "_")}`
	const filePath = path.join(UPLOAD_DIR, filename)
	await writeFile(filePath, buffer)
	return filePath
}
