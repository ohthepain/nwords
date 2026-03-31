import { prisma } from "@nwords/db"
import { sendIngestJob } from "./boss"
import { INGEST_QUEUE } from "./ingestion-queues"
import {
	bnpdFreqListUrl,
	resolveHermitDaveFrequencyUrl,
	tatoebaPerLanguageSentencesUrl,
} from "./ingestion-urls"

export async function chainFrequencyFromKaikki(languageId: string): Promise<void> {
	const lang = await prisma.language.findUnique({ where: { id: languageId } })
	if (!lang) return

	const hermit = await resolveHermitDaveFrequencyUrl(lang.code)
	if (hermit) {
		const job = await prisma.ingestionJob.create({
			data: {
				type: "FREQUENCY_LIST",
				languageId,
				metadata: {
					downloadUrl: hermit.downloadUrl,
					format: "hermitdave",
					source: hermit.source,
					hermitYear: hermit.year,
					chainPipeline: true,
					languageCode: lang.code,
					languageName: lang.name,
				},
			},
		})

		await sendIngestJob(INGEST_QUEUE.FREQUENCY, {
			jobId: job.id,
			languageId,
			downloadUrl: hermit.downloadUrl,
			format: "hermitdave",
			source: hermit.source,
			chainPipeline: true,
		})
		return
	}

	const downloadUrl = bnpdFreqListUrl(lang.code)
	let ok = false
	try {
		const head = await fetch(downloadUrl, { method: "HEAD" })
		ok = head.ok
	} catch {
		ok = false
	}

	if (!ok) {
		console.warn(
			`[pipeline] No hermitdave or bnpd frequency file for ${lang.code}; skipping to Tatoeba`,
		)
		await chainTatoebaFromFrequency(languageId, {
			skippedFrequency: true,
			downloadUrlAttempted: downloadUrl,
		})
		return
	}

	const job = await prisma.ingestionJob.create({
		data: {
			type: "FREQUENCY_LIST",
			languageId,
			metadata: {
				downloadUrl,
				format: "bnpd",
				source: "bnpd/freqListsLemmatized",
				chainPipeline: true,
				languageCode: lang.code,
				languageName: lang.name,
			},
		},
	})

	await sendIngestJob(INGEST_QUEUE.FREQUENCY, {
		jobId: job.id,
		languageId,
		downloadUrl,
		format: "bnpd",
		source: "bnpd/freqListsLemmatized",
		chainPipeline: true,
	})
}

export async function chainTatoebaFromFrequency(
	languageId: string,
	extraMeta: Record<string, unknown> = {},
): Promise<void> {
	const lang = await prisma.language.findUnique({ where: { id: languageId } })
	if (!lang?.code3) {
		console.warn(
			`[pipeline] Language ${languageId} has no code3; cannot download Tatoeba per-language export`,
		)
		return
	}

	const downloadUrl = tatoebaPerLanguageSentencesUrl(lang.code3)

	// Only one Tatoeba job should ingest the same export per language at a time. Double chain calls
	// (e.g. races, retries) or a lingering RUNNING row would otherwise enqueue duplicates.
	const job = await prisma.$transaction(async (tx) => {
		const existing = await tx.ingestionJob.findFirst({
			where: {
				languageId,
				type: "TATOEBA_SENTENCES",
				status: { in: ["PENDING", "RUNNING"] },
			},
			select: { id: true, status: true },
		})
		if (existing) {
			return { kind: "skip" as const, existingId: existing.id, status: existing.status }
		}
		const created = await tx.ingestionJob.create({
			data: {
				type: "TATOEBA_SENTENCES",
				languageId,
				metadata: {
					downloadUrl,
					chainPipeline: true,
					languageCode: lang.code,
					languageName: lang.name,
					tatoebaLangCode: lang.code3,
					...extraMeta,
				},
			},
		})
		return { kind: "created" as const, row: created }
	})

	if (job.kind === "skip") {
		console.warn(
			`[pipeline] Tatoeba already ${job.status} for language ${languageId} (${job.existingId}); skipping duplicate chain enqueue`,
		)
		return
	}

	await sendIngestJob(INGEST_QUEUE.TATOEBA, {
		jobId: job.row.id,
		languageId,
		downloadUrl,
		langCode: lang.code3,
		chainPipeline: true,
	})
}
