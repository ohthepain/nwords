import { describe, expect, it } from "vitest"
import { app } from "../index"

describe("Languages route", () => {
	it("lists all languages", async () => {
		const res = await app.request("/api/languages")
		expect(res.status).toBe(200)

		const body = await res.json()
		expect(body.languages).toBeDefined()
		expect(Array.isArray(body.languages)).toBe(true)
		// Should have seeded languages
		expect(body.languages.length).toBeGreaterThan(0)
	})

	it("filters to enabled-only languages", async () => {
		const res = await app.request("/api/languages?enabled=true")
		expect(res.status).toBe(200)

		const body = await res.json()
		expect(body.languages).toBeDefined()
		// All returned languages should be enabled
		for (const lang of body.languages) {
			expect(lang.enabled).toBe(true)
		}
	})
})
