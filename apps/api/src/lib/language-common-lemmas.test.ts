import { prisma } from "@nwords/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	appendCommonLemmasNotAlreadyPresent,
	syncLanguageCommonLemmasFromList,
} from "./language-common-lemmas"

describe.skipIf(!process.env.DATABASE_URL)("language-common-lemmas (db)", () => {
	let langId = ""

	beforeAll(async () => {
		const code = `lc_lemma_${Date.now()}`
		const l = await prisma.language.create({
			data: { code, name: "language-common-lemmas test", enabled: false },
		})
		langId = l.id
	})

	afterAll(async () => {
		if (!langId) return
		await prisma.language.delete({ where: { id: langId } }).catch(() => {})
	})

	it("sync sets COMMON for all rows; append adds HERMIT_DAVE only for new lemmas", async () => {
		await syncLanguageCommonLemmasFromList(langId, ["alpha", "beta"])
		let rows = await prisma.languageCommonLemma.findMany({
			where: { languageId: langId },
			orderBy: { sortOrder: "asc" },
			select: { lemma: true, curriculumSource: true },
		})
		expect(rows).toHaveLength(2)
		expect(rows.every((r) => r.curriculumSource === "COMMON")).toBe(true)

		const stats = await appendCommonLemmasNotAlreadyPresent(langId, ["beta", "gamma"], {
			sourceForNewRows: "HERMIT_DAVE",
		})
		expect(stats.added).toBe(1)
		expect(stats.skippedAlreadyInDb).toBe(1)

		rows = await prisma.languageCommonLemma.findMany({
			where: { languageId: langId },
			orderBy: { sortOrder: "asc" },
			select: { lemma: true, curriculumSource: true },
		})
		const byLemma = Object.fromEntries(rows.map((r) => [r.lemma, r.curriculumSource]))
		expect(byLemma.alpha).toBe("COMMON")
		expect(byLemma.beta).toBe("COMMON")
		expect(byLemma.gamma).toBe("HERMIT_DAVE")
	})
})
