import { bnpdFreqListUrl, resolveHermitDaveFrequencyUrl } from "./ingestion-urls"
import { nodeReadableFromWeb, readLinesFromReadable } from "./node-streams"

export type TopFrequencyLemmasResult = {
	lemmas: string[]
	format: "hermitdave" | "bnpd"
	source: string
	downloadUrl: string
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

/**
 * Load the first `limit` lemmas from HermitDave (preferred) or BNPD frequency lists — no `Word` rows required.
 */
export async function fetchTopFrequencyLemmas(
	iso639_1: string,
	limit: number,
): Promise<TopFrequencyLemmasResult | null> {
	if (limit <= 0) return null

	const hermit = await resolveHermitDaveFrequencyUrl(iso639_1)
	if (hermit) {
		const lemmas: string[] = []
		for await (const line of linesFromUrl(hermit.downloadUrl)) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith("#")) continue
			const m = trimmed.match(/^(.+?)\s+(\d+)$/)
			if (!m) continue
			const lemma = m[1].trim()
			if (!lemma) continue
			lemmas.push(lemma)
			if (lemmas.length >= limit) {
				return {
					lemmas,
					format: "hermitdave",
					source: hermit.source,
					downloadUrl: hermit.downloadUrl,
				}
			}
		}
		return lemmas.length > 0
			? { lemmas, format: "hermitdave", source: hermit.source, downloadUrl: hermit.downloadUrl }
			: null
	}

	const downloadUrl = bnpdFreqListUrl(iso639_1)
	let ok = false
	try {
		const head = await fetch(downloadUrl, { method: "HEAD" })
		ok = head.ok
	} catch {
		ok = false
	}
	if (!ok) return null

	const lemmas: string[] = []
	for await (const line of linesFromUrl(downloadUrl)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith("#")) continue
		const lemma = trimmed.split(/\s+/)[0]?.trim()
		if (!lemma) continue
		lemmas.push(lemma.toLowerCase())
		if (lemmas.length >= limit) {
			return {
				lemmas,
				format: "bnpd",
				source: "bnpd/freqListsLemmatized",
				downloadUrl,
			}
		}
	}

	return lemmas.length > 0
		? {
				lemmas,
				format: "bnpd",
				source: "bnpd/freqListsLemmatized",
				downloadUrl,
			}
		: null
}

/**
 * HermitDave / FrequencyWords only (no BNPD fallback). Same line format as bulk frequency import (`word count`).
 */
export async function fetchHermitDaveFrequencyLemmasOnly(
	iso639_1: string,
	limit: number,
): Promise<TopFrequencyLemmasResult | null> {
	if (limit <= 0) return null

	const hermit = await resolveHermitDaveFrequencyUrl(iso639_1)
	if (!hermit) return null

	const lemmas: string[] = []
	for await (const line of linesFromUrl(hermit.downloadUrl)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith("#")) continue
		const m = trimmed.match(/^(.+?)\s+(\d+)$/)
		if (!m) continue
		const lemma = m[1].trim()
		if (!lemma) continue
		lemmas.push(lemma)
		if (lemmas.length >= limit) {
			return {
				lemmas,
				format: "hermitdave",
				source: hermit.source,
				downloadUrl: hermit.downloadUrl,
			}
		}
	}
	return lemmas.length > 0
		? { lemmas, format: "hermitdave", source: hermit.source, downloadUrl: hermit.downloadUrl }
		: null
}
