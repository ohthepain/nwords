import { describe, expect, it } from "vitest"
import {
	definitionsTriggerDictionaryMetadataHeuristic,
	extractDefinitionStrings,
	heuristicMarksUntestable,
} from "./word-gloss-heuristics"

describe("extractDefinitionStrings", () => {
	it("collects non-empty strings from arrays", () => {
		expect(extractDefinitionStrings(["  a ", "", "b"])).toEqual(["  a ", "b"])
	})

	it("returns empty for non-arrays", () => {
		expect(extractDefinitionStrings(null)).toEqual([])
		expect(extractDefinitionStrings({ foo: "bar" })).toEqual([])
		expect(extractDefinitionStrings("x")).toEqual([])
	})
})

describe("definitionsTriggerDictionaryMetadataHeuristic", () => {
	it("matches dictionary-metadata phrases case-insensitively", () => {
		expect(definitionsTriggerDictionaryMetadataHeuristic(["Inflection of foo"])).toBe(true)
		expect(definitionsTriggerDictionaryMetadataHeuristic(["PLURAL OF bar"])).toBe(true)
		expect(definitionsTriggerDictionaryMetadataHeuristic(["comparative of cold"])).toBe(true)
		expect(definitionsTriggerDictionaryMetadataHeuristic(["superlative of good"])).toBe(true)
		expect(definitionsTriggerDictionaryMetadataHeuristic(["predicative only"])).toBe(true)
	})

	it("does not match ordinary glosses", () => {
		expect(definitionsTriggerDictionaryMetadataHeuristic(["to run"])).toBe(false)
		expect(definitionsTriggerDictionaryMetadataHeuristic(["speed", "velocity"])).toBe(false)
	})
})

describe("heuristicMarksUntestable", () => {
	it("marks proper nouns", () => {
		expect(heuristicMarksUntestable("PROPER_NOUN", ["capital city"])).toBe(true)
	})

	it("does not mark ordinary noun without metadata gloss", () => {
		expect(heuristicMarksUntestable("NOUN", ["dog"])).toBe(false)
	})
})
