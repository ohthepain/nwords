import { prisma } from "@nwords/db"
import { Hono } from "hono"

export const wordsRoute = new Hono()
	.get("/", async (c) => {
		const languageId = c.req.query("languageId")
		const limit = Number.parseInt(c.req.query("limit") ?? "50", 10)
		const offset = Number.parseInt(c.req.query("offset") ?? "0", 10)

		if (!languageId) {
			return c.json({ error: "languageId is required" }, 400)
		}

		const words = await prisma.word.findMany({
			where: { languageId, isOffensive: false, isAbbreviation: false },
			orderBy: { effectiveRank: "asc" },
			take: Math.min(limit, 100),
			skip: offset,
		})

		return c.json({ words })
	})
	.get("/count/:languageId", async (c) => {
		const { languageId } = c.req.param()
		const count = await prisma.word.count({
			where: { languageId, isOffensive: false, isAbbreviation: false },
		})
		return c.json({ count })
	})
