import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

export const adminSentencesRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)

	.patch(
		"/:id/cloze-quality",
		zValidator("json", z.object({ delta: z.union([z.literal(1), z.literal(-1)]) })),
		async (c) => {
			const { id } = c.req.param()
			const { delta } = c.req.valid("json")

			const sentence = await prisma.sentence.findUnique({
				where: { id },
				select: { id: true, clozeQuality: true },
			})
			if (!sentence) return c.json({ error: "Sentence not found" }, 404)

			const updated = await prisma.sentence.update({
				where: { id },
				data: { clozeQuality: sentence.clozeQuality + delta },
				select: { id: true, clozeQuality: true },
			})

			return c.json({ id: updated.id, clozeQuality: updated.clozeQuality })
		},
	)
