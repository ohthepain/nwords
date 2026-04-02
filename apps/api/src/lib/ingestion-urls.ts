const BNPD_BASE = "https://raw.githubusercontent.com/bnpd/freqListsLemmatized/main"

/**
 * Kaikki site layout (human browsing):
 * - `/dictionary/{Language}/` — language hub (e.g. [Italian](https://kaikki.org/dictionary/Italian/))
 * - `/dictionary/{Language}/pos-{noun|verb|adj|adv}/index.html` — POS index
 * - `/dictionary/{Language}/pos-noun/foo--bar.html` — HTML chunks; each line is like `lemma (Noun) gloss…`
 *
 * Ingestion does **not** scrape HTML. We use the **postprocessed JSONL** dumps linked from those POS
 * pages (same senses), e.g.
 * `…/pos-noun/kaikki.org-dictionary-Italian-by-pos-noun.jsonl`
 * ([Italian nouns](https://kaikki.org/dictionary/Italian/pos-noun/index.html)).
 */

/** URL path segments / filename suffixes for the four content-word POS exports. */
export const KAIKKI_POS_SEGMENTS = ["pos-noun", "pos-verb", "pos-adj", "pos-adv"] as const

export type KaikkiIngestMode = "by-pos" | "monolith"

/** Full postprocessed JSONL (all POS); larger but one HTTP stream. */
export function kaikkiDictionaryJsonlUrl(dictionaryName: string): string {
	const slug = dictionaryName.trim()
	const enc = encodeURIComponent(slug)
	return `https://kaikki.org/dictionary/${enc}/kaikki.org-dictionary-${enc}.jsonl`
}

/**
 * Four JSONL URLs — one per content POS. Smaller combined footprint than the monolith when you
 * only need noun/verb/adj/adv (and matches the site’s POS split).
 */
export function kaikkiByPosJsonlUrls(dictionaryName: string): string[] {
	const slug = dictionaryName.trim()
	const enc = encodeURIComponent(slug)
	return KAIKKI_POS_SEGMENTS.map(
		(seg) =>
			`https://kaikki.org/dictionary/${enc}/${seg}/kaikki.org-dictionary-${enc}-by-${seg}.jsonl`,
	)
}

/**
 * Prefer per-POS JSONL files when all four respond to HEAD; otherwise fall back to the monolith URL.
 * Set `KAIKKI_FORCE_MONOLITH=true` to skip probing (e.g. restrictive proxies).
 */
export async function resolveKaikkiDownloadPlan(
	dictionaryName: string,
): Promise<{ downloadUrls: string[]; mode: KaikkiIngestMode }> {
	const label = dictionaryName.trim()
	if (process.env.KAIKKI_FORCE_MONOLITH === "true") {
		return { downloadUrls: [kaikkiDictionaryJsonlUrl(label)], mode: "monolith" }
	}

	const byPos = kaikkiByPosJsonlUrls(label)
	const oks = await Promise.all(
		byPos.map(async (u) => {
			try {
				const r = await fetch(u, { method: "HEAD", redirect: "follow" })
				return r.ok
			} catch {
				return false
			}
		}),
	)

	if (oks.every(Boolean)) {
		return { downloadUrls: byPos, mode: "by-pos" }
	}

	return { downloadUrls: [kaikkiDictionaryJsonlUrl(label)], mode: "monolith" }
}

/** Lemmatized frequency list (lemma + forms per line); ranks by line order. */
export function bnpdFreqListUrl(iso639_1: string): string {
	return `${BNPD_BASE}/${iso639_1.toLowerCase()}.txt`
}

/** Tatoeba weekly per-language export (bzip2-compressed TSV). */
export function tatoebaPerLanguageSentencesUrl(iso639_3: string): string {
	const c = iso639_3.toLowerCase()
	return `https://downloads.tatoeba.org/exports/per_language/${c}/${c}_sentences.tsv.bz2`
}

/**
 * Tatoeba sentence-translation pairs: tab-separated Tatoeba sentence ids for one direction.
 * Lies under `per_language/{baseIso3}/` — required for cloze hints in the “native → target” direction.
 * @see https://downloads.tatoeba.org/exports/
 */
export function tatoebaPairLinksBz2Url(baseIso639_3: string, otherIso639_3: string): string {
	const a = baseIso639_3.toLowerCase()
	const b = otherIso639_3.toLowerCase()
	return `https://downloads.tatoeba.org/exports/per_language/${a}/${a}-${b}_links.tsv.bz2`
}

const HERMITDAVE_CONTENT_API =
	"https://api.github.com/repos/hermitdave/FrequencyWords/contents/content"
const HERMITDAVE_RAW_BASE =
	"https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content"

interface GitHubContentsEntry {
	name: string
	type: string
}

export type HermitDaveFrequencyPlan = {
	downloadUrl: string
	year: string | null
	source: string
}

/**
 * Resolve {@link https://github.com/hermitdave/FrequencyWords | hermitdave/FrequencyWords}
 * `content/.../{lang}/{lang}_50k.txt` raw URL.
 * When `content/` lists year folders (e.g. 2016, 2018), uses the latest year that contains the list.
 * When the language folder sits directly under `content/`, uses that layout instead.
 */
export async function resolveHermitDaveFrequencyUrl(
	iso639_1: string,
): Promise<HermitDaveFrequencyPlan | null> {
	const lang = iso639_1.trim().toLowerCase()
	if (!lang) return null

	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	}
	const token = process.env.GITHUB_TOKEN?.trim()
	if (token) headers.Authorization = `Bearer ${token}`

	let items: GitHubContentsEntry[]
	try {
		const res = await fetch(`${HERMITDAVE_CONTENT_API}?ref=master`, { headers })
		if (!res.ok) return null
		const json: unknown = await res.json()
		if (!Array.isArray(json)) return null
		items = json as GitHubContentsEntry[]
	} catch {
		return null
	}

	const yearDirs = items
		.filter((i) => i.type === "dir" && /^\d{4}$/.test(i.name))
		.map((i) => i.name)
		.sort((a, b) => b.localeCompare(a))

	const urlForYear = (year: string) => `${HERMITDAVE_RAW_BASE}/${year}/${lang}/${lang}_50k.txt`

	const verifyHead = async (url: string): Promise<boolean> => {
		try {
			const r = await fetch(url, { method: "HEAD", redirect: "follow" })
			return r.ok
		} catch {
			return false
		}
	}

	for (const year of yearDirs) {
		const url = urlForYear(year)
		if (await verifyHead(url)) {
			return {
				downloadUrl: url,
				year,
				source: `hermitdave/FrequencyWords/${year}`,
			}
		}
	}

	const langAtRoot = items.some((i) => i.type === "dir" && i.name === lang)
	if (langAtRoot) {
		const flatUrl = `${HERMITDAVE_RAW_BASE}/${lang}/${lang}_50k.txt`
		if (await verifyHead(flatUrl)) {
			return {
				downloadUrl: flatUrl,
				year: null,
				source: "hermitdave/FrequencyWords",
			}
		}
	}

	return null
}
