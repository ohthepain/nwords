import type { PartOfSpeech, Prisma } from "@nwords/db"

export type CurriculumFormKey =
	| "noun_singular_definite"
	| "noun_plural_indefinite"
	| "noun_plural_definite"
	| "spoken_colloquial_variant"
	| "verb_infinitive"
	| "verb_present"
	| "verb_past"
	| "verb_supine"
	| "verb_imperative"
	| "verb_passive"
	| "adjective_common_gender"
	| "adjective_neuter"
	| "adjective_plural_definite"
	| "adjective_comparative"
	| "adjective_superlative"
	| "adverb_comparative"
	| "adverb_superlative"
	| "pronoun_subject"
	| "pronoun_object"
	| "pronoun_possessive"
	| "determiner_common"
	| "determiner_neuter"
	| "determiner_plural_definite"
	| "numeral_cardinal"
	| "numeral_ordinal"

export type CurriculumFormCandidate = {
	baseWordId: string
	baseLemma: string
	pos: PartOfSpeech
	form: string
	formKey: CurriculumFormKey
	formTags: string[]
	minRank: number
	siblingOffset: number
	provisionalRank: number
}

type BaseWord = {
	id: string
	lemma: string
	pos: PartOfSpeech
	rank: number
}

type WordFormLike = {
	form: string
	tags: Prisma.JsonValue
}

type SlotSpec = {
	key: CurriculumFormKey
	minRank?: number
	offset: number
	matches: (tags: Set<string>) => boolean
}

const NOUN_SLOTS: SlotSpec[] = [
	{
		key: "noun_singular_definite",
		offset: 30,
		matches: (tags) => has(tags, "singular", "sg") && has(tags, "definite", "def"),
	},
	{
		key: "noun_plural_indefinite",
		offset: 60,
		matches: (tags) =>
			has(tags, "plural", "pl") &&
			has(tags, "indefinite", "indef") &&
			!has(tags, "definite", "def"),
	},
	{
		key: "noun_plural_definite",
		offset: 90,
		matches: (tags) => has(tags, "plural", "pl") && has(tags, "definite", "def"),
	},
]

const VERB_SLOTS: SlotSpec[] = [
	{
		key: "verb_infinitive",
		offset: 0,
		matches: (tags) => has(tags, "infinitive", "inf"),
	},
	{
		key: "verb_present",
		offset: 30,
		matches: (tags) => has(tags, "present", "pres") && !has(tags, "passive", "pass"),
	},
	{
		key: "verb_past",
		offset: 60,
		minRank: 500,
		matches: (tags) => has(tags, "past", "preterite", "pret") && !has(tags, "passive", "pass"),
	},
	{
		key: "verb_supine",
		offset: 90,
		matches: (tags) => has(tags, "supine", "sup"),
	},
	{
		key: "verb_imperative",
		offset: 120,
		matches: (tags) => has(tags, "imperative", "imp"),
	},
	{
		key: "verb_passive",
		offset: 150,
		minRank: 1000,
		matches: (tags) => has(tags, "passive", "pass"),
	},
]

const ADJECTIVE_SLOTS: SlotSpec[] = [
	/** Indefinite singular common / utrum (e.g. Swedish "en stor bil") — not neuter, not plural, not definite. */
	{
		key: "adjective_common_gender",
		offset: 15,
		matches: (tags) =>
			has(tags, "singular", "sg") &&
			!has(tags, "neuter", "neut", "neutrum") &&
			!has(tags, "plural", "pl") &&
			!has(tags, "definite", "def") &&
			!hasDegree(tags) &&
			!hasNaturalGender(tags),
	},
	{
		key: "adjective_neuter",
		offset: 30,
		matches: (tags) =>
			has(tags, "neuter", "neut") &&
			has(tags, "singular", "sg") &&
			!hasDegree(tags) &&
			!hasNaturalGender(tags),
	},
	{
		key: "adjective_plural_definite",
		offset: 60,
		matches: (tags) =>
			(has(tags, "plural", "pl") || has(tags, "definite", "def")) &&
			!hasDegree(tags) &&
			!hasNaturalGender(tags),
	},
	{
		key: "adjective_comparative",
		offset: 90,
		matches: (tags) => has(tags, "comparative", "comp"),
	},
	{
		key: "adjective_superlative",
		offset: 120,
		matches: (tags) => has(tags, "superlative", "sup"),
	},
]

const ADVERB_SLOTS: SlotSpec[] = [
	{
		key: "adverb_comparative",
		offset: 30,
		matches: (tags) => has(tags, "comparative", "comp"),
	},
	{
		key: "adverb_superlative",
		offset: 60,
		matches: (tags) => has(tags, "superlative", "sup"),
	},
]

const PRONOUN_SLOTS: SlotSpec[] = [
	{
		key: "pronoun_subject",
		offset: 30,
		matches: (tags) => has(tags, "subject", "subjective", "nominative", "nom"),
	},
	{
		key: "pronoun_object",
		offset: 60,
		matches: (tags) => has(tags, "object", "objective", "accusative", "acc", "dative", "dat"),
	},
	{
		key: "pronoun_possessive",
		offset: 90,
		matches: (tags) => has(tags, "possessive", "poss"),
	},
]

const DETERMINER_SLOTS: SlotSpec[] = [
	{
		key: "determiner_common",
		offset: 30,
		matches: (tags) => has(tags, "common", "common-gender", "utrum"),
	},
	{
		key: "determiner_neuter",
		offset: 60,
		matches: (tags) => has(tags, "neuter", "neut", "neutrum"),
	},
	{
		key: "determiner_plural_definite",
		offset: 90,
		matches: (tags) => has(tags, "plural", "pl") || has(tags, "definite", "def"),
	},
]

const NUMERAL_SLOTS: SlotSpec[] = [
	{
		key: "numeral_cardinal",
		offset: 30,
		matches: (tags) => has(tags, "cardinal"),
	},
	{
		key: "numeral_ordinal",
		offset: 60,
		matches: (tags) => has(tags, "ordinal"),
	},
]

function slotsForPos(pos: PartOfSpeech): SlotSpec[] {
	switch (pos) {
		case "NOUN":
			return NOUN_SLOTS
		case "VERB":
			return VERB_SLOTS
		case "ADJECTIVE":
			return ADJECTIVE_SLOTS
		case "ADVERB":
			return ADVERB_SLOTS
		case "PRONOUN":
			return PRONOUN_SLOTS
		case "DETERMINER":
			return DETERMINER_SLOTS
		case "NUMERAL":
			return NUMERAL_SLOTS
		default:
			return []
	}
}

function normalizeSurface(value: string): string {
	return value.normalize("NFC").trim().toLocaleLowerCase()
}

function tagsFromJson(value: Prisma.JsonValue): string[] {
	if (!Array.isArray(value)) return []
	return value
		.filter((tag): tag is string => typeof tag === "string")
		.map((tag) => tag.normalize("NFC").trim().toLocaleLowerCase())
		.filter(Boolean)
}

function has(tags: Set<string>, ...values: string[]): boolean {
	return values.some((value) => tags.has(value))
}

function hasDegree(tags: Set<string>): boolean {
	return has(tags, "comparative", "comp", "superlative", "sup")
}

function hasNaturalGender(tags: Set<string>): boolean {
	return has(tags, "masculine", "masc", "feminine", "fem")
}

function candidateQuality(form: string, tags: Set<string>): number {
	let score = 0
	if (has(tags, "rare", "archaic", "dated", "obsolete")) score += 1000
	if (has(tags, "attributive")) score += 20
	if (has(tags, "predicative")) score -= 10
	if (hasNaturalGender(tags)) score += 100
	score += [...form].length
	return score
}

export function selectCurriculumFormCandidates(
	base: BaseWord,
	forms: WordFormLike[],
): CurriculumFormCandidate[] {
	const slots = slotsForPos(base.pos)
	if (slots.length === 0) return []

	const baseSurface = normalizeSurface(base.lemma)
	const bySlot = new Map<CurriculumFormKey, CurriculumFormCandidate[]>()

	for (const row of forms) {
		const form = normalizeSurface(row.form)
		if (!form || form === baseSurface || form.includes(" ")) continue

		const formTags = tagsFromJson(row.tags)
		const tags = new Set(formTags)
		if (has(tags, "misspelling", "nonstandard", "rare", "archaic", "obsolete")) continue

		for (const slot of slots) {
			if (!slot.matches(tags)) continue
			const minRank = slot.minRank ?? 0
			const provisionalRank = Math.max(base.rank + slot.offset, minRank)
			const list = bySlot.get(slot.key) ?? []
			list.push({
				baseWordId: base.id,
				baseLemma: base.lemma,
				pos: base.pos,
				form,
				formKey: slot.key,
				formTags,
				minRank,
				siblingOffset: slot.offset,
				provisionalRank,
			})
			bySlot.set(slot.key, list)
		}
	}

	const selected: CurriculumFormCandidate[] = []
	const selectedForms = new Set<string>()
	for (const slot of slots) {
		const best = (bySlot.get(slot.key) ?? []).sort((a, b) => {
			const qa = candidateQuality(a.form, new Set(a.formTags))
			const qb = candidateQuality(b.form, new Set(b.formTags))
			if (qa !== qb) return qa - qb
			return a.form.localeCompare(b.form)
		})[0]
		if (!best || selectedForms.has(best.form)) continue
		selected.push(best)
		selectedForms.add(best.form)
	}
	return selected
}

/** Tags on Kaikki morphological forms that indicate spoken / clipped variants (promoted ahead of the headword). */
const SPOKEN_VARIANT_TAGS = [
	"colloquial",
	"informal",
	"spoken",
	"diminutive",
	"clipping",
	"shortening",
] as const

function hasSpokenVariantTag(tags: Set<string>): boolean {
	return SPOKEN_VARIANT_TAGS.some((t) => tags.has(t))
}

function spokenVariantQuality(form: string, tags: Set<string>): number {
	let score = 0
	if (has(tags, "rare", "archaic", "obsolete")) score += 800
	if (has(tags, "clipping", "shortening")) score -= 30
	if (has(tags, "colloquial", "informal", "spoken")) score -= 15
	score += [...form].length * 2
	return score
}

/**
 * Additional learning units for informal surface forms (e.g. "nåt", "huvud") when Kaikki marks the form.
 * Excludes surfaces already taken by {@link selectCurriculumFormCandidates} or the base lemma.
 */
export function selectSpokenColloquialFormCandidates(
	base: BaseWord,
	forms: WordFormLike[],
	excludedSurfaces: ReadonlySet<string>,
): CurriculumFormCandidate[] {
	const slotsLength = slotsForPos(base.pos).length
	if (slotsLength === 0) return []

	const baseSurface = normalizeSurface(base.lemma)
	const picked: CurriculumFormCandidate[] = []

	for (const row of forms) {
		const form = normalizeSurface(row.form)
		if (!form || form === baseSurface || form.includes(" ") || excludedSurfaces.has(form)) continue

		const formTags = tagsFromJson(row.tags)
		const tags = new Set(formTags)
		if (!hasSpokenVariantTag(tags)) continue
		if (has(tags, "misspelling", "nonstandard", "rare", "archaic", "obsolete")) continue

		picked.push({
			baseWordId: base.id,
			baseLemma: base.lemma,
			pos: base.pos,
			form,
			formKey: "spoken_colloquial_variant",
			formTags,
			minRank: 0,
			siblingOffset: -45,
			provisionalRank: Math.max(base.rank - 45, 0),
		})
	}

	picked.sort((a, b) => {
		const qa = spokenVariantQuality(a.form, new Set(a.formTags))
		const qb = spokenVariantQuality(b.form, new Set(b.formTags))
		if (qa !== qb) return qa - qb
		return a.form.localeCompare(b.form)
	})

	const uniq: CurriculumFormCandidate[] = []
	const seen = new Set<string>()
	for (const p of picked) {
		if (seen.has(p.form)) continue
		seen.add(p.form)
		uniq.push(p)
	}
	return uniq
}

export function plannedFormRank(
	baseRank: number,
	form: Pick<CurriculumFormCandidate, "minRank" | "siblingOffset">,
): number {
	return Math.max(baseRank + form.siblingOffset, form.minRank)
}
