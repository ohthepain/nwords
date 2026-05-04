import { describe, expect, it } from "vitest"
import {
	plannedFormRank,
	selectCurriculumFormCandidates,
	selectSpokenColloquialFormCandidates,
} from "./curriculum-form-selection"

describe("selectCurriculumFormCandidates", () => {
	it("promotes only tagged forms for the selected base lemma", () => {
		const selected = selectCurriculumFormCandidates(
			{ id: "base-1", lemma: "låg", pos: "ADJECTIVE", rank: 42 },
			[
				{ form: "lågt", tags: ["neuter", "singular", "indefinite"] },
				{ form: "låga", tags: ["plural"] },
				{ form: "låge", tags: ["masculine", "singular", "definite"] },
				{ form: "lågbetald", tags: [] },
				{ form: "lägre", tags: ["comparative"] },
				{ form: "lägst", tags: ["superlative", "predicative"] },
				{ form: "lägsta", tags: ["superlative", "attributive"] },
			],
		)

		expect(selected.map((form) => [form.formKey, form.form])).toEqual([
			["adjective_neuter", "lågt"],
			["adjective_plural_definite", "låga"],
			["adjective_comparative", "lägre"],
			["adjective_superlative", "lägst"],
		])
	})

	it("applies verb minimum ranks for past and passive forms", () => {
		const selected = selectCurriculumFormCandidates(
			{ id: "base-1", lemma: "se", pos: "VERB", rank: 7 },
			[
				{ form: "ser", tags: ["present"] },
				{ form: "såg", tags: ["past"] },
				{ form: "sett", tags: ["supine"] },
				{ form: "se", tags: ["imperative"] },
				{ form: "ses", tags: ["passive", "present"] },
			],
		)

		const byKey = new Map(selected.map((form) => [form.formKey, form]))
		expect(byKey.get("verb_present")?.provisionalRank).toBe(37)
		expect(byKey.get("verb_past")?.provisionalRank).toBe(500)
		expect(byKey.get("verb_passive")?.provisionalRank).toBe(1000)
		const past = byKey.get("verb_past")
		expect(past).toBeDefined()
		if (past) expect(plannedFormRank(7, past)).toBe(500)
	})

	it("detects indefinite singular common-gender forms when Kaikki surface differs from lemma", () => {
		const selected = selectCurriculumFormCandidates(
			{ id: "base", lemma: "formbase", pos: "ADJECTIVE", rank: 100 },
			[{ form: "commonsurf", tags: ["singular", "sg", "indefinite", "indef"] }],
		)

		expect(selected.find((c) => c.formKey === "adjective_common_gender")?.form).toBe("commonsurf")
	})

	it("does not select adjective common gender when only the lemma repeats the feature", () => {
		const selected = selectCurriculumFormCandidates(
			{ id: "base", lemma: "stor", pos: "ADJECTIVE", rank: 100 },
			[{ form: "stort", tags: ["singular", "neuter", "indefinite"] }],
		)
		expect(selected.find((c) => c.formKey === "adjective_common_gender")).toBeUndefined()
		expect(selected.find((c) => c.formKey === "adjective_neuter")?.form).toBe("stort")
	})

	it("selectSpokenColloquialFormCandidates returns tagged informal surfaces", () => {
		const colloquials = selectSpokenColloquialFormCandidates(
			{ id: "w1", lemma: "någon", pos: "PRONOUN", rank: 200 },
			[{ form: "nåt", tags: ["colloquial", "pronoun"] }],
			new Set(),
		)
		expect(colloquials).toHaveLength(1)
		expect(colloquials[0]?.form).toBe("nåt")
		expect(colloquials[0]?.formKey).toBe("spoken_colloquial_variant")
	})

	it("skips spoken forms already used as slot promotions", () => {
		const colloquials = selectSpokenColloquialFormCandidates(
			{ id: "w1", lemma: "inte", pos: "ADVERB", rank: 10 },
			[{ form: "int", tags: ["colloquial", "informal"] }],
			new Set(["int"]),
		)
		expect(colloquials).toHaveLength(0)
	})
})
