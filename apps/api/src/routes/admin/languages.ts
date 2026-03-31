import { zValidator } from "@hono/zod-validator"
import { prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import { enqueueLanguageIngestionPipeline } from "../../lib/language-pipeline"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

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

			const prev = await prisma.language.findUnique({ where: { id } })
			if (!prev) {
				return c.json({ error: "Language not found" }, 404)
			}

			const language = await prisma.language.update({
				where: { id },
				data: { enabled },
			})

			let pipelineJobId: string | null = null
			if (enabled && !prev.enabled) {
				const wordCount = await prisma.word.count({ where: { languageId: id } })
				if (wordCount === 0) {
					const started = await enqueueLanguageIngestionPipeline(id)
					pipelineJobId = started?.jobId ?? null
				}
			}

			return c.json({
				id: language.id,
				code: language.code,
				name: language.name,
				enabled: language.enabled,
				pipelineJobId,
			})
		},
	)

	/** Dev / admin: enqueue full Kaikki → frequency → Tatoeba chain regardless of word count or prior enable state. */
	.post("/:id/run-pipeline", async (c) => {
		const { id } = c.req.param()
		const lang = await prisma.language.findUnique({ where: { id } })
		if (!lang) {
			return c.json({ error: "Language not found" }, 404)
		}

		const started = await enqueueLanguageIngestionPipeline(id)
		if (!started) {
			return c.json({ error: "Failed to start pipeline" }, 500)
		}

		return c.json({
			id: lang.id,
			code: lang.code,
			name: lang.name,
			pipelineJobId: started.jobId,
		})
	})

	/**
	 * Remove lemma↔sentence links and test-sentence curation for this language so Tatoeba linking can run again.
	 * Does not delete `sentence` rows or `sentence_translation` pairs.
	 */
	.post("/:id/clear-sentence-links", async (c) => {
		const { id } = c.req.param()

		const lang = await prisma.language.findUnique({ where: { id } })
		if (!lang) {
			return c.json({ error: "Language not found" }, 404)
		}

		const result = await prisma.$transaction(async (tx) => {
			const deleted = await tx.sentenceWord.deleteMany({
				where: { sentence: { languageId: id } },
			})
			const sentencesReset = await tx.sentence.updateMany({
				where: { languageId: id },
				data: { testQualityScore: null, isTestCandidate: false },
			})
			const wordsReset = await tx.word.updateMany({
				where: { languageId: id },
				data: { testSentenceIds: [] },
			})
			return {
				sentenceWordsRemoved: deleted.count,
				sentencesReset: sentencesReset.count,
				wordsCleared: wordsReset.count,
			}
		})

		return c.json({
			id: lang.id,
			code: lang.code,
			name: lang.name,
			...result,
		})
	})

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
