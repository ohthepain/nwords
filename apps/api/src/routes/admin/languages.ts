import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { prisma } from "@nwords/db"
import { authMiddleware } from "../../middleware/auth.ts"
import { adminMiddleware } from "../../middleware/admin.ts"

export const adminLanguagesRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)

	// List all languages with word/sentence counts
	.get("/", async (c) => {
		const languages = await prisma.language.findMany({
			orderBy: { name: "asc" },
			include: {
				_count: {
					select: { words: true, sentences: true },
				},
			},
		})

		return c.json({
			languages: languages.map((l) => ({
				id: l.id,
				code: l.code,
				code3: l.code3,
				name: l.name,
				enabled: l.enabled,
				wordCount: l._count.words,
				sentenceCount: l._count.sentences,
				createdAt: l.createdAt.toISOString(),
			})),
		})
	})

	// Toggle enabled/disabled
	.patch(
		"/:id/toggle",
		zValidator(
			"json",
			z.object({
				enabled: z.boolean(),
			}),
		),
		async (c) => {
			const { id } = c.req.param()
			const { enabled } = c.req.valid("json")

			const language = await prisma.language.update({
				where: { id },
				data: { enabled },
			})

			return c.json({
				id: language.id,
				code: language.code,
				name: language.name,
				enabled: language.enabled,
			})
		},
	)

	// Get details about a specific language's vocabulary coverage
	.get("/:id/stats", async (c) => {
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

		// Count words by CEFR level
		const cefrCounts = await prisma.word.groupBy({
			by: ["cefrLevel"],
			where: { languageId: id },
			_count: true,
		})

		// Count words missing sentences
		const wordsMissingSentences = await prisma.word.count({
			where: {
				languageId: id,
				sentenceWords: { none: {} },
			},
		})

		return c.json({
			language: {
				id: language.id,
				code: language.code,
				name: language.name,
				enabled: language.enabled,
			},
			wordCount: language._count.words,
			sentenceCount: language._count.sentences,
			wordsMissingSentences,
			cefrDistribution: cefrCounts.map((c) => ({
				level: c.cefrLevel,
				count: c._count,
			})),
		})
	})
