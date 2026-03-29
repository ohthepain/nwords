import { describe, expect, it } from "vitest"
import { app } from "../index.ts"

describe("Health route", () => {
	it("returns ok status", async () => {
		const res = await app.request("/api/health")
		expect(res.status).toBe(200)

		const body = await res.json()
		expect(body.status).toBe("ok")
		expect(body.timestamp).toBeDefined()
	})
})
