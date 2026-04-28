import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
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

export const adminWordsRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)

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
