import { zValidator } from "@hono/zod-validator"
import { Prisma, prisma } from "@nwords/db"
import { Hono } from "hono"
import { z } from "zod"
import {
	enqueueAiVocabPipeline,
	enqueueCommonCurriculumKaikkiFromCommonWords,
	enqueueHermitDaveCommonLemmasJob,
	enqueueVocabUnitsLlmFromCommonWords,
} from "../../lib/ai-vocab-pipeline"
import { sendIngestJob } from "../../lib/boss"
import {
	COMMON_CURRICULUM_FREQUENCY_TAG,
	pgJsonArrayContainsScalar,
} from "../../lib/common-curriculum-tags"
import { INGEST_QUEUE } from "../../lib/ingestion-queues"
import { normalizeCommonLemma } from "../../lib/language-common-lemmas"
import { enqueueLanguageIngestionPipeline } from "../../lib/language-pipeline"
import { isLegacyVocabPipeline } from "../../lib/vocab-pipeline-env"
import { adminMiddleware } from "../../middleware/admin"
import { authMiddleware } from "../../middleware/auth"

export const adminLanguagesRoute = new Hono()
	.use("*", authMiddleware, adminMiddleware)

	// List all languages with word/sentence counts
	.get("/", async (c) => {
		const commonFreqContain = pgJsonArrayContainsScalar(COMMON_CURRICULUM_FREQUENCY_TAG)
		const [languages, wordSourceCounts, commonCurriculumCohortRows] = await Promise.all([
			prisma.language.findMany({
				orderBy: { name: "asc" },
				include: {
					_count: {
						select: { words: true, sentences: true },
					},
				},
			}),
			prisma.word.groupBy({
				by: ["languageId", "curriculumSource"],
				_count: { _all: true },
			}),
			prisma.$queryRawUnsafe(
				`SELECT w."languageId"::text AS "languageId", COUNT(*)::bigint AS c
				FROM "word" w
				WHERE
					w."curriculumSource" IN ('COMMON', 'HERMIT_DAVE')
					OR (
						w."curriculumSource" = 'KAIKKI'
						AND w."curriculumUnit" IS NOT NULL
						AND COALESCE(w."curriculumUnit"::jsonb->'tags', '[]'::jsonb) @> ${commonFreqContain}
					)
				GROUP BY w."languageId"`,
			) as Promise<Array<{ languageId: string; c: bigint }>>,
		])
		const aiWordCountsByLanguageId = new Map(
			wordSourceCounts
				.filter((row) => row.curriculumSource === "AI_CURRICULUM")
				.map((row) => [row.languageId, row._count._all]),
		)
		const commonWordCountsByLanguageId = new Map(
			commonCurriculumCohortRows.map((row) => [row.languageId, Number(row.c)]),
		)

		return c.json({
			languages: languages.map((l) => ({
				id: l.id,
				code: l.code,
				code3: l.code3,
				name: l.name,
				enabled: l.enabled,
				wordCount: l._count.words,
				aiWordCount: aiWordCountsByLanguageId.get(l.id) ?? 0,
				commonWordCount: commonWordCountsByLanguageId.get(l.id) ?? 0,
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

	/** Build COMMON curriculum (`COMMON_CURRICULUM_KAIKKI`) from curated common lemmas (latest or pinned common-words job). */
	.post(
		"/:id/run-common-curriculum-from-common-words",
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
				const out = await enqueueCommonCurriculumKaikkiFromCommonWords(id, body.commonWordsJobId)
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

	/** HermitDave: append top-ranked lemmas into `language_common_lemma` (skips lemmas already listed). Separate manual step after Common words. */
	.post(
		"/:id/run-hermit-dave-common-lemmas",
		zValidator(
			"json",
			z.object({
				scanLimit: z.number().int().min(50).max(25_000).optional(),
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
				const out = await enqueueHermitDaveCommonLemmasJob(id, {
					scanLimit: body.scanLimit,
				})
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

	/** Post-process AI curriculum words: homograph sense spacing + dense ranks. */
	.post(
		"/:id/run-vocab-cleanup",
		zValidator(
			"json",
			z.object({
				dryRun: z.boolean().optional(),
				senseOffset: z.number().int().min(1).max(10_000).optional(),
			}),
		),
		async (c) => {
			const { id } = c.req.param()
			const body = c.req.valid("json")
			const lang = await prisma.language.findUnique({ where: { id } })
			if (!lang) {
				return c.json({ error: "Language not found" }, 404)
			}

			const dryRun = body.dryRun === true
			const job = await prisma.ingestionJob.create({
				data: {
					type: "VOCAB_CLEANUP",
					languageId: id,
					metadata: {
						dryRun,
						languageCode: lang.code,
						languageName: lang.name,
						...(body.senseOffset !== undefined ? { senseOffset: body.senseOffset } : {}),
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.VOCAB_CLEANUP, {
				jobId: job.id,
				languageId: id,
				dryRun,
				...(body.senseOffset !== undefined ? { senseOffset: body.senseOffset } : {}),
			})

			return c.json({ id: lang.id, jobId: job.id }, 201)
		},
	)

	/** LLM trim of scoped curriculum rows: mark peripheral senses/forms untestable (modern spoken defaults only). */
	.post(
		"/:id/run-curriculum-testability-trim",
		zValidator(
			"json",
			z.object({
				dryRun: z.boolean().optional(),
				batchSize: z.number().int().min(10).max(200).optional(),
			}),
		),
		async (c) => {
			const { id } = c.req.param()
			const body = c.req.valid("json")
			const lang = await prisma.language.findUnique({ where: { id } })
			if (!lang) {
				return c.json({ error: "Language not found" }, 404)
			}

			const dryRun = body.dryRun === true
			const job = await prisma.ingestionJob.create({
				data: {
					type: "CURRICULUM_TESTABILITY_TRIM",
					languageId: id,
					metadata: {
						dryRun,
						languageCode: lang.code,
						languageName: lang.name,
						...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.CURRICULUM_TESTABILITY_TRIM, {
				jobId: job.id,
				languageId: id,
				dryRun,
				...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
			})

			return c.json({ id: lang.id, jobId: job.id }, 201)
		},
	)

	/** Re-run the cloze generation pipeline on scoped rows with `isTestable=false` (same as Generate clozes, subset only). Promotes rows only after usable clozes validate. */
	.post(
		"/:id/run-curriculum-testability-trim-retry",
		zValidator(
			"json",
			z.object({
				dryRun: z.boolean().optional(),
				batchSize: z.number().int().min(10).max(200).optional(),
			}),
		),
		async (c) => {
			const { id } = c.req.param()
			const body = c.req.valid("json")
			const lang = await prisma.language.findUnique({ where: { id } })
			if (!lang) {
				return c.json({ error: "Language not found" }, 404)
			}

			const dryRun = body.dryRun === true
			const job = await prisma.ingestionJob.create({
				data: {
					type: "CURRICULUM_TESTABILITY_TRIM_RETRY",
					languageId: id,
					metadata: {
						dryRun,
						languageCode: lang.code,
						languageName: lang.name,
						...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
					},
				},
			})

			await sendIngestJob(INGEST_QUEUE.CURRICULUM_TESTABILITY_TRIM_RETRY, {
				jobId: job.id,
				languageId: id,
				dryRun,
				...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
			})

			return c.json({ id: lang.id, jobId: job.id }, 201)
		},
	)

	.post("/:id/clear-generated-clozes", async (c) => {
		const { id } = c.req.param()
		const lang = await prisma.language.findUnique({ where: { id } })
		if (!lang) {
			return c.json({ error: "Language not found" }, 404)
		}

		const activeJob = await prisma.ingestionJob.findFirst({
			where: {
				languageId: id,
				type: { in: ["CLOZE_GENERATION"] },
				status: { in: ["PENDING", "RUNNING"] },
			},
			select: { id: true, type: true, status: true },
		})
		if (activeJob) {
			return c.json(
				{
					error: `Cannot clear clozes while ${activeJob.type} job ${activeJob.id.slice(0, 8)} is ${activeJob.status}. Cancel or wait for it first.`,
				},
				409,
			)
		}

		const result = await prisma.$transaction(async (tx) => {
			const generated = await tx.generatedCloze.deleteMany({ where: { languageId: id } })
			const words = await tx.word.updateMany({
				where: { languageId: id },
				data: {
					testSentenceIds: [],
					aiSynonyms: [],
					clozeUnusableReason: null,
					clozeUnusableDetail: null,
				},
			})
			const sentenceWords = await tx.sentenceWord.updateMany({
				where: { sentence: { languageId: id } },
				data: {
					aiKeep: null,
					aiUsefulness: null,
					aiNaturalness: null,
					aiCompositionalityTier: null,
					aiClozePriority: null,
				},
			})
			const aiSentences = await tx.sentence.deleteMany({
				where: { languageId: id, source: "AI_GENERATED" },
			})
			return {
				generatedClozesDeleted: generated.count,
				wordsCleared: words.count,
				sentenceWordScoresCleared: sentenceWords.count,
				aiSentencesDeleted: aiSentences.count,
			}
		})

		return c.json({ id: lang.id, code: lang.code, name: lang.name, ...result })
	})

	.post("/:id/clear-vocabulary", async (c) => {
		const { id } = c.req.param()
		const lang = await prisma.language.findUnique({ where: { id } })
		if (!lang) {
			return c.json({ error: "Language not found" }, 404)
		}

		const activeJob = await prisma.ingestionJob.findFirst({
			where: {
				languageId: id,
				type: {
					in: [
						"KAIKKI_WORDS",
						"FREQUENCY_LIST",
						"TATOEBA_SENTENCES",
						"WORD_FORMS",
						"FIXED_EXPRESSIONS",
						"CLOZE_QUALITY_ASSESSMENT",
						"CLOZE_GENERATION",
						"VOCAB_UNITS_LLM",
						"VOCAB_CLEANUP",
						"WORDS_GLOSS_CLEANUP",
						"CURRICULUM_TESTABILITY_TRIM",
						"CURRICULUM_TESTABILITY_TRIM_RETRY",
					],
				},
				status: { in: ["PENDING", "RUNNING"] },
			},
			select: { id: true, type: true, status: true },
		})
		if (activeJob) {
			return c.json(
				{
					error: `Cannot clear vocabulary while ${activeJob.type} job ${activeJob.id.slice(0, 8)} is ${activeJob.status}. Cancel or wait for it first.`,
				},
				409,
			)
		}

		const result = await prisma.$transaction(
			async (tx) => {
				const generated = await tx.generatedCloze.deleteMany({ where: { languageId: id } })
				const reports = await tx.clozeIssueReport.deleteMany({
					where: {
						word: { languageId: id },
					},
				})
				const userKnowledge = await tx.userWordKnowledge.deleteMany({
					where: { word: { languageId: id } },
				})
				const sentenceWords = await tx.sentenceWord.deleteMany({
					where: { word: { languageId: id } },
				})
				const wordForms = await tx.wordForm.deleteMany({ where: { languageId: id } })
				const synonymPairs = await tx.wordSynonymPair.deleteMany({ where: { languageId: id } })
				const commonLemmas = await tx.languageCommonLemma.deleteMany({ where: { languageId: id } })
				const words = await tx.word.deleteMany({ where: { languageId: id } })
				return {
					wordsDeleted: words.count,
					generatedClozesDeleted: generated.count,
					clozeReportsDeleted: reports.count,
					userKnowledgeDeleted: userKnowledge.count,
					sentenceWordsDeleted: sentenceWords.count,
					wordFormsDeleted: wordForms.count,
					synonymPairsDeleted: synonymPairs.count,
					commonLemmasDeleted: commonLemmas.count,
				}
			},
			{ timeout: 300_000 },
		)

		return c.json({ id: lang.id, code: lang.code, name: lang.name, ...result })
	})

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
			select: { id: true, lemma: true, sortOrder: true, curriculumSource: true },
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
					data: { languageId: id, lemma, sortOrder, curriculumSource: "COMMON" },
					select: { id: true, lemma: true, sortOrder: true, curriculumSource: true },
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

	/**
	 * Delete every `sentence` row for this language and any `sentence_translation` involving those rows.
	 * Tatoeba and AI corpus text is removed until you re-import. `sentence_word` rows cascade away.
	 */
	.post("/:id/clear-sentence-corpus", async (c) => {
		const { id } = c.req.param()
		const lang = await prisma.language.findUnique({ where: { id } })
		if (!lang) {
			return c.json({ error: "Language not found" }, 404)
		}

		const activeJob = await prisma.ingestionJob.findFirst({
			where: {
				languageId: id,
				type: {
					in: [
						"KAIKKI_WORDS",
						"FREQUENCY_LIST",
						"TATOEBA_SENTENCES",
						"WORD_FORMS",
						"FIXED_EXPRESSIONS",
						"CLOZE_QUALITY_ASSESSMENT",
						"CLOZE_GENERATION",
						"VOCAB_UNITS_LLM",
						"VOCAB_CLEANUP",
						"WORDS_GLOSS_CLEANUP",
						"CURRICULUM_TESTABILITY_TRIM",
						"CURRICULUM_TESTABILITY_TRIM_RETRY",
					],
				},
				status: { in: ["PENDING", "RUNNING"] },
			},
			select: { id: true, type: true, status: true },
		})
		if (activeJob) {
			return c.json(
				{
					error: `Cannot clear sentences while ${activeJob.type} job ${activeJob.id.slice(0, 8)} is ${activeJob.status}. Cancel or wait for it first.`,
				},
				409,
			)
		}

		const result = await prisma.$transaction(
			async (tx) => {
				const translations = await tx.sentenceTranslation.deleteMany({
					where: {
						OR: [
							{ originalSentence: { languageId: id } },
							{ translatedSentence: { languageId: id } },
						],
					},
				})
				await tx.word.updateMany({
					where: { languageId: id },
					data: { testSentenceIds: [] },
				})
				const sentences = await tx.sentence.deleteMany({ where: { languageId: id } })
				return {
					sentenceTranslationsDeleted: translations.count,
					sentencesDeleted: sentences.count,
				}
			},
			{ timeout: 300_000 },
		)

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
