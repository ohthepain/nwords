import { describe, expect, it } from "vitest"
import { normalizeCandidate } from "./cloze-generation"

describe("normalizeCandidate", () => {
	it("requires the exact non-split learning unit in the sentence", () => {
		expect(
			normalizeCandidate(
				{
					sentence: "Jag såg en hund.",
					cloze: "Jag ____ en hund.",
					answer: "ser",
					alternatives: ["såg"],
					difficulty: "easy",
					tags: [],
					naturalness: 5,
					usefulness: 5,
					modernness: 5,
					fun: 0,
					risk: 0,
					selectionReason: "test",
				},
				"ser",
			),
		).toBeNull()
	})

	it("normalizes split learning units by blanking fixed parts only", () => {
		const normalized = normalizeCandidate(
			{
				sentence: "Du ser pigg ut idag.",
				cloze: "Du ____ pigg ____ idag.",
				answer: "ser ... ut",
				alternatives: ["ser ut"],
				difficulty: "easy",
				tags: ["spoken"],
				naturalness: 5,
				usefulness: 5,
				modernness: 5,
				fun: 1,
				risk: 0,
				selectionReason: "test",
			},
			"ser ... ut",
		)

		expect(normalized?.sentence).toBe("Du ser pigg ut idag.")
		expect(normalized?.cloze).toBe("Du ____ pigg ____ idag.")
		expect(normalized?.answer).toBe("ser ... ut")
		expect(normalized?.alternatives).toEqual([])
	})

	it("strips fake Markdown __word__ around the target so underscore runs are not mistaken for blanks", () => {
		const normalized = normalizeCandidate(
			{
				sentence: "Jag hoppas att vi __lever__ länge.",
				cloze: "Jag hoppas att vi ____ länge.",
				answer: "lever",
				alternatives: [],
				difficulty: "easy",
				tags: [],
				naturalness: 5,
				usefulness: 5,
				modernness: 5,
				fun: 0,
				risk: 0,
				selectionReason: "test",
			},
			"lever",
		)

		expect(normalized).not.toBeNull()
		expect(normalized?.sentence).toBe("Jag hoppas att vi lever länge.")
		expect(normalized?.cloze).toBe("Jag hoppas att vi ____ länge.")
		expect(normalized?.answer).toBe("lever")
	})
})
