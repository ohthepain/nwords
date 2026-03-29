import { prisma } from "@nwords/db"
import { Hono } from "hono"

export const languagesRoute = new Hono()
	// List all languages (public)
	.get("/", async (c) => {
		const enabledOnly = c.req.query("enabled") === "true"

		const languages = await prisma.language.findMany({
			where: enabledOnly ? { enabled: true } : undefined,
			orderBy: { name: "asc" },
			select: {
				id: true,
				code: true,
				code3: true,
				name: true,
				enabled: true,
			},
		})

		return c.json({ languages })
	})

	// Get a single language
	.get("/:id", async (c) => {
		const { id } = c.req.param()

		const language = await prisma.language.findUnique({
			where: { id },
			include: {
				_count: {
					select: { words: true, sentences: true },
				},
			},
		})

		if (!language) {
			return c.json({ error: "Language not found" }, 404)
		}

		return c.json({
			id: language.id,
			code: language.code,
			code3: language.code3,
			name: language.name,
			enabled: language.enabled,
			wordCount: language._count.words,
			sentenceCount: language._count.sentences,
		})
	})
