import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { setWordPositionAdjust } from "../../lib/resolve-word-order"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

export const adminWordsRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)

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
