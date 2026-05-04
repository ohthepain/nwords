import type { PartOfSpeech } from "@nwords/db"

/** Kaikki/Wiktionary `pos` string → our `PartOfSpeech` string names (before narrowing). */
export const KAIKKI_POS_MAP: Record<string, string> = {
	noun: "NOUN",
	verb: "VERB",
	adj: "ADJECTIVE",
	adv: "ADVERB",
	adjective: "ADJECTIVE",
	adverb: "ADVERB",
	pron: "PRONOUN",
	pronoun: "PRONOUN",
	det: "DETERMINER",
	determiner: "DETERMINER",
	prep: "PREPOSITION",
	preposition: "PREPOSITION",
	prep_phrase: "PREPOSITION",
	conj: "CONJUNCTION",
	conjunction: "CONJUNCTION",
	particle: "PARTICLE",
	intj: "INTERJECTION",
	interjection: "INTERJECTION",
	num: "NUMERAL",
	numeral: "NUMERAL",
	name: "PROPER_NOUN",
	proper_noun: "PROPER_NOUN",
}

export const KAIKKI_OFFENSIVE_TAGS = new Set([
	"vulgar",
	"offensive",
	"slur",
	"derogatory",
	"pejorative",
])

/** Skip these Wiktionary sense tags so lemmas like "GDP" are not glossed as full words. */
export const KAIKKI_ABBREVIATION_SENSE_TAGS = new Set([
	"abbreviation",
	"abbrev",
	"initialism",
	"acronym",
	"clipping",
	"shortening",
])

export interface KaikkiSense {
	glosses?: string[]
	tags?: string[]
	raw_tags?: string[]
}

export interface KaikkiEntry {
	word: string
	pos: string
	lang?: string
	senses?: KaikkiSense[]
	forms?: Array<{
		form: string
		tags?: string[]
	}>
}

export function kaikkiSenseHasAbbreviationTag(sense: KaikkiSense): boolean {
	for (const t of [...(sense.tags ?? []), ...(sense.raw_tags ?? [])]) {
		if (KAIKKI_ABBREVIATION_SENSE_TAGS.has(t.toLowerCase())) return true
	}
	return false
}

export function mapKaikkiPos(pos: string): PartOfSpeech | null {
	const mapped = KAIKKI_POS_MAP[pos?.toLowerCase() ?? ""]
	return (mapped ?? null) as PartOfSpeech | null
}

export function kaikkiEntryHasOffensiveSense(entry: KaikkiEntry): boolean {
	for (const sense of entry.senses ?? []) {
		const tags = [...(sense.tags ?? []), ...(sense.raw_tags ?? [])]
		if (tags.some((t) => KAIKKI_OFFENSIVE_TAGS.has(t.toLowerCase()))) return true
	}
	return false
}

/** Gloss strings from non-abbreviation senses (same policy as `kaikki` worker). */
export function extractKaikkiGlossDefinitions(entry: KaikkiEntry): string[] {
	const definitions: string[] = []
	for (const sense of entry.senses ?? []) {
		if (kaikkiSenseHasAbbreviationTag(sense)) continue
		if (sense.glosses) definitions.push(...sense.glosses)
	}
	return definitions
}

export function normalizeKaikkiLemma(word: string | undefined): string {
	return word?.trim()?.toLowerCase() ?? ""
}
