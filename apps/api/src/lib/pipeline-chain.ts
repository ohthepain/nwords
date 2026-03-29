import { prisma } from "@nwords/db"
import { getBoss } from "./boss.ts"
import { INGEST_QUEUE } from "./ingestion-queues.ts"
import {
	bnpdFreqListUrl,
	resolveHermitDaveFrequencyUrl,
	tatoebaPerLanguageSentencesUrl,
} from "./ingestion-urls.ts"

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

		const boss = await getBoss()
		await boss.send(INGEST_QUEUE.FREQUENCY, {
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

	const boss = await getBoss()
	await boss.send(INGEST_QUEUE.FREQUENCY, {
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
	const job = await prisma.ingestionJob.create({
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

	const boss = await getBoss()
	await boss.send(INGEST_QUEUE.TATOEBA, {
		jobId: job.id,
		languageId,
		downloadUrl,
		langCode: lang.code3,
		chainPipeline: true,
	})
}
