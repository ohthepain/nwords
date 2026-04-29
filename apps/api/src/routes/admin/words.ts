import { zValidator } from "@hono/zod-validator"
import { Prisma, prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { setWordPositionAdjust } from "../../lib/resolve-word-order"
import {
	buildSynonymPairsExport,
	importSynonymPairsMerge,
	synonymPairsImportSchema,
} from "../../lib/synonym-pair-import-export"
import {
	buildPositionAdjustExport,
	importPositionAdjustMerge,
	positionAdjustImportSchema,
} from "../../lib/word-position-adjust-import-export"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

const PROMPT_WORDLIST_MAX = 5000

export const adminWordsRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)

	/**
	 * Compact ranked lemma list for LLM prompts (reorder / curriculum tasks).
	 * `w` is unique lemmas: for each lemma we keep the lowest effectiveRank among POS rows, then
	 * order globally by that rank; index i ⇒ rank i+1 in this slice.
	 */
	.get("/prompt-wordlist.json", async (c) => {
		const languageId = c.req.query("languageId")?.trim()
		if (!languageId) {
			return c.json({ error: "languageId is required" }, 400)
		}
		const limitRaw = c.req.query("limit")
		const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : PROMPT_WORDLIST_MAX
		const limit = Number.isFinite(limitParsed)
			? Math.min(PROMPT_WORDLIST_MAX, Math.max(1, limitParsed))
			: PROMPT_WORDLIST_MAX

		const lang = await prisma.language.findFirst({
			where: { id: languageId },
			select: { code: true },
		})
		if (!lang) {
			return c.json({ error: "Language not found" }, 404)
		}

		const rows = await prisma.$queryRaw<{ lemma: string }[]>(
			Prisma.sql`
				WITH best AS (
					SELECT DISTINCT ON ("lemma") "lemma", "effectiveRank" AS er
					FROM "word"
					WHERE "languageId" = ${languageId}::uuid AND "effectiveRank" > 0
					ORDER BY "lemma", "effectiveRank" ASC, "id" ASC
				)
				SELECT "lemma" FROM best
				ORDER BY er ASC, "lemma" ASC
				LIMIT ${limit}
			`,
		)

		c.header(
			"Content-Disposition",
			`attachment; filename="nwords-prompt-wordlist-${lang.code}.json"`,
		)
		return c.json({
			v: 1,
			lc: lang.code,
			n: rows.length,
			w: rows.map((r) => r.lemma),
		})
	})

	.get("/synonyms/export", async (c) => {
		const languageIdRaw = c.req.query("languageId")?.trim()
		const languageId = languageIdRaw && languageIdRaw.length > 0 ? languageIdRaw : undefined
		if (languageId) {
			const lang = await prisma.language.findFirst({
				where: { id: languageId },
				select: { code: true },
			})
			if (!lang) {
				return c.json({ error: "Language not found" }, 404)
			}
			c.header("Content-Disposition", `attachment; filename="nwords-synonyms-${lang.code}.json"`)
		} else {
			c.header("Content-Disposition", `attachment; filename="nwords-synonyms-all.json"`)
		}
		const payload = await buildSynonymPairsExport({ languageId })
		return c.json(payload)
	})

	.post("/synonyms/import", async (c) => {
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400)
		}
		const parsed = synonymPairsImportSchema.safeParse(body)
		if (!parsed.success) {
			return c.json({ error: "Invalid synonym export file", issues: parsed.error.issues }, 400)
		}
		const stats = await importSynonymPairsMerge(parsed.data)
		return c.json({ ok: true, ...stats })
	})

	.get("/position-adjustments/export", async (c) => {
		const languageIdRaw = c.req.query("languageId")?.trim()
		const languageId = languageIdRaw && languageIdRaw.length > 0 ? languageIdRaw : undefined
		if (languageId) {
			const lang = await prisma.language.findFirst({
				where: { id: languageId },
				select: { code: true },
			})
			if (!lang) {
				return c.json({ error: "Language not found" }, 404)
			}
			c.header(
				"Content-Disposition",
				`attachment; filename="nwords-position-adjustments-${lang.code}.json"`,
			)
		} else {
			c.header("Content-Disposition", `attachment; filename="nwords-position-adjustments-all.json"`)
		}
		const payload = await buildPositionAdjustExport({ languageId })
		return c.json(payload)
	})

	.post("/position-adjustments/import", async (c) => {
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400)
		}
		const parsed = positionAdjustImportSchema.safeParse(body)
		if (!parsed.success) {
			return c.json(
				{ error: "Invalid position-adjustments export file", issues: parsed.error.issues },
				400,
			)
		}
		const stats = await importPositionAdjustMerge(parsed.data)
		return c.json({ ok: true, ...stats })
	})

	.post("/:id/exclude-from-tests", async (c) => {
		const { id } = c.req.param()
		const word = await prisma.word.findUnique({
			where: { id },
			select: { id: true, isTestable: true },
		})
		if (!word) return c.json({ error: "Word not found" }, 404)
		await prisma.word.update({ where: { id }, data: { isTestable: false } })
		return c.json({ ok: true, wordId: id })
	})

	.patch(
		"/:id/position-adjust",
		zValidator(
			"json",
			z.object({
				positionAdjust: z.number().int().min(-10000).max(10000),
			}),
		),
		async (c) => {
			const { id } = c.req.param()
			const { positionAdjust } = c.req.valid("json")

			const word = await prisma.word.findUnique({
				where: { id },
				select: { id: true, lemma: true, rank: true, effectiveRank: true },
			})
			if (!word) {
				return c.json({ error: "Word not found" }, 404)
			}

			await setWordPositionAdjust(id, positionAdjust)

			return c.json({
				id: word.id,
				lemma: word.lemma,
				rank: word.rank,
				positionAdjust,
				effectiveRank: word.rank + positionAdjust,
			})
		},
	)
