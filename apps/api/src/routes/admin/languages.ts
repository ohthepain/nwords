import { zValidator } from "@hono/zod-validator"
import { Prisma, prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import {
	enqueueAiVocabPipeline,
	enqueueVocabUnitsLlmFromCommonWords,
} from "../../lib/ai-vocab-pipeline"
import { normalizeCommonLemma } from "../../lib/language-common-lemmas"
import { enqueueLanguageIngestionPipeline } from "../../lib/language-pipeline"
import { isLegacyVocabPipeline } from "../../lib/vocab-pipeline-env"
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
					const started = isLegacyVocabPipeline()
						? await enqueueLanguageIngestionPipeline(id)
						: await enqueueAiVocabPipeline(id)
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

	/** Dev / admin: enqueue full Kaikki → frequency → Tatoeba chain (set VOCAB_PIPELINE=legacy or use after AI experiments). */
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

	/** AI step 1 only: fetch top-N frequency lemmas into job metadata (`topLemmas`). Run LLM vocabulary after review. */
	.post("/:id/run-ai-vocab-pipeline", async (c) => {
		const { id } = c.req.param()
		const lang = await prisma.language.findUnique({ where: { id } })
		if (!lang) {
			return c.json({ error: "Language not found" }, 404)
		}

		const started = await enqueueAiVocabPipeline(id)
		if (!started) {
			return c.json({ error: "Failed to start common words job" }, 500)
		}

		return c.json({
			id: lang.id,
			code: lang.code,
			name: lang.name,
			pipelineJobId: started.jobId,
		})
	})

	/** AI step 2: `VOCAB_UNITS_LLM` from a completed COMMON_WORDS_TOP job (latest, or `commonWordsJobId` in body). */
	.post(
		"/:id/run-llm-vocab-from-common-words",
		zValidator(
			"json",
			z.object({
				commonWordsJobId: z.string().uuid().optional(),
			}),
		),
		async (c) => {
			const { id } = c.req.param()
			const body = c.req.valid("json")
			const lang = await prisma.language.findUnique({ where: { id } })
			if (!lang) {
				return c.json({ error: "Language not found" }, 404)
			}

			try {
				const out = await enqueueVocabUnitsLlmFromCommonWords(id, body.commonWordsJobId)
				return c.json({
					id: lang.id,
					code: lang.code,
					name: lang.name,
					pipelineJobId: out.jobId,
				})
			} catch (e) {
				return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
			}
		},
	)

	/** Curated “most common words” list used as LLM seed when non-empty. */
	.get("/:id/common-lemmas", async (c) => {
		const { id } = c.req.param()
		const lang = await prisma.language.findUnique({
			where: { id },
			select: { id: true, code: true, name: true },
		})
		if (!lang) {
			return c.json({ error: "Language not found" }, 404)
		}
		const lemmas = await prisma.languageCommonLemma.findMany({
			where: { languageId: id },
			orderBy: { sortOrder: "asc" },
			select: { id: true, lemma: true, sortOrder: true },
		})
		return c.json({ language: lang, lemmas })
	})

	.post(
		"/:id/common-lemmas",
		zValidator("json", z.object({ lemma: z.string().min(1) })),
		async (c) => {
			const { id } = c.req.param()
			const body = c.req.valid("json")
			const lang = await prisma.language.findUnique({ where: { id }, select: { id: true } })
			if (!lang) {
				return c.json({ error: "Language not found" }, 404)
			}
			const lemma = normalizeCommonLemma(body.lemma)
			if (!lemma) {
				return c.json({ error: "Lemma is empty" }, 400)
			}

			const agg = await prisma.languageCommonLemma.aggregate({
				where: { languageId: id },
				_max: { sortOrder: true },
			})
			const sortOrder = (agg._max.sortOrder ?? -1) + 1

			try {
				const row = await prisma.languageCommonLemma.create({
					data: { languageId: id, lemma, sortOrder },
					select: { id: true, lemma: true, sortOrder: true },
				})
				return c.json(row, 201)
			} catch (e) {
				if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
					return c.json({ error: "That lemma is already in the list" }, 409)
				}
				throw e
			}
		},
	)

	.delete("/:id/common-lemmas/:rowId", async (c) => {
		const { id, rowId } = c.req.param()
		const lang = await prisma.language.findUnique({ where: { id }, select: { id: true } })
		if (!lang) {
			return c.json({ error: "Language not found" }, 404)
		}
		const row = await prisma.languageCommonLemma.findUnique({
			where: { id: rowId },
			select: { id: true, languageId: true },
		})
		if (!row || row.languageId !== id) {
			return c.json({ error: "Lemma row not found" }, 404)
		}
		await prisma.languageCommonLemma.delete({ where: { id: rowId } })
		return c.json({ deleted: true })
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
