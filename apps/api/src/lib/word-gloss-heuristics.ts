import type { PartOfSpeech } from "@nwords/db"

/** Matches dictionary-metadata gloss lines we exclude from vocabulary testing. */
export const DICTIONARY_METADATA_DEFINITION_PATTERN =
	/inflection of|plural of|comparative of|superlative of|predicative/i

export function extractDefinitionStrings(definitions: unknown): string[] {
	if (!Array.isArray(definitions)) return []
	return definitions.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
}

export function definitionsTriggerDictionaryMetadataHeuristic(definitions: unknown): boolean {
	return extractDefinitionStrings(definitions).some((s) =>
		DICTIONARY_METADATA_DEFINITION_PATTERN.test(s),
	)
}

/** Deterministic exclusions before the LLM pass (proper nouns + dictionary-metadata senses). */
export function heuristicMarksUntestable(pos: PartOfSpeech, definitions: unknown): boolean {
	if (pos === "PROPER_NOUN") return true
	return definitionsTriggerDictionaryMetadataHeuristic(definitions)
}
