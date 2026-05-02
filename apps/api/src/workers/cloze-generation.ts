import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { Output, generateText } from "ai"
import type PgBoss from "pg-boss"
import { z } from "zod"
import { createModel } from "../lib/ai"
import { getAiConfig } from "../lib/app-settings"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"

export interface ClozeGenerationJobData {
	jobId: string
	languageId: string
	unitsLimit?: number
	candidatesPerUnit?: number
	selectedPerUnit?: number
	resetExisting?: boolean
}

const DEFAULT_CANDIDATES_PER_UNIT = 10
const DEFAULT_SELECTED_PER_UNIT = 5
const CLOZE_PROGRESS_METADATA_INTERVAL = 10

const difficultySchema = z.enum(["easy", "medium", "hard"])

const clozeCandidateSchema = z.object({
	sentence: z.string().min(1),
	cloze: z.string().min(1),
	answer: z.string().min(1),
	alternatives: z.array(z.string()),
	difficulty: difficultySchema,
	tags: z.array(z.string()),
	naturalness: z.number().int().min(0).max(5),
	usefulness: z.number().int().min(0).max(5),
	modernness: z.number().int().min(0).max(5),
	fun: z.number().int().min(0).max(5),
	risk: z.number().int().min(0).max(5),
	selectionReason: z.string(),
})

const clozeGenerationSchema = z.object({
	candidates: z.array(clozeCandidateSchema),
})

type ClozeCandidate = z.infer<typeof clozeCandidateSchema>

function clozeGenerationLlmConcurrency(): number {
	const raw = Number(process.env.CLOZE_GENERATION_LLM_CONCURRENCY)
	const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4
	return Math.max(1, Math.min(12, n))
}

async function runPool<T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>,
	shouldStop: () => Promise<boolean>,
): Promise<void> {
	let next = 0
	const runWorker = async () => {
		for (;;) {
			if (await shouldStop()) return
			const i = next++
			if (i >= items.length) return
			await fn(items[i])
		}
	}
	const workers = Math.max(1, Math.min(concurrency, Math.max(1, items.length)))
	await Promise.all(Array.from({ length: workers }, () => runWorker()))
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}
}

function firstGloss(definitions: unknown): string {
	if (!Array.isArray(definitions)) return ""
	const first = definitions.find((d): d is string => typeof d === "string" && d.trim().length > 0)
	return first?.trim() ?? ""
}

function normalizeText(value: string): string {
	return value.normalize("NFC").trim().replace(/\s+/g, " ")
}

function normalizeBlank(value: string): string {
	return normalizeText(value).replace(/_{1,}/g, "____")
}

function wordCount(text: string): number {
	return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
}

function hasBlank(text: string): boolean {
	return text.includes("____")
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function fallbackClozeFromAnswer(sentence: string, answer: string): string | null {
	const normalizedAnswer = normalizeText(answer)
	if (!normalizedAnswer || normalizedAnswer.includes("...")) return null

	const exact = new RegExp(
		`(^|[^\\p{L}\\p{N}])(${escapeRegExp(normalizedAnswer)})(?=$|[^\\p{L}\\p{N}])`,
		"iu",
	)
	if (!exact.test(sentence)) return null
	return sentence.replace(exact, (_match, prefix: string) => `${prefix}____`)
}

function normalizedAnswerKey(value: string): string {
	return normalizeText(value).toLocaleLowerCase()
}

function targetAtEdge(candidate: ClozeCandidate): boolean {
	const answer = candidate.answer.trim().toLocaleLowerCase()
	const runs = candidate.sentence.match(/[\p{L}\p{N}]+/gu) ?? []
	if (runs.length === 0) return false
	const first = runs[0]?.toLocaleLowerCase()
	const last = runs[runs.length - 1]?.toLocaleLowerCase()
	return first === answer || last === answer
}

function normalizeCandidate(candidate: ClozeCandidate, targetText: string): ClozeCandidate | null {
	let sentence = normalizeBlank(candidate.sentence)
	let cloze = normalizeBlank(candidate.cloze)
	const answer = normalizeText(candidate.answer)
	const target = normalizeText(targetText)

	if (normalizedAnswerKey(answer) !== normalizedAnswerKey(target)) return null

	if (hasBlank(sentence) && !hasBlank(cloze)) {
		cloze = sentence
		sentence = normalizeText(sentence.replace(/____/g, answer))
	}

	if (hasBlank(sentence)) {
		sentence = normalizeText(sentence.replace(/____/g, answer))
	}

	if (!hasBlank(cloze)) {
		cloze = fallbackClozeFromAnswer(sentence, answer) ?? cloze
	}

	if (!hasBlank(cloze)) return null
	if (hasBlank(sentence)) return null
	const n = wordCount(sentence)
	if (n < 2 || n > 24) return null

	return {
		...candidate,
		sentence,
		cloze,
		answer,
		alternatives: candidate.alternatives.map(normalizeText).filter(Boolean),
		tags: candidate.tags.map(normalizeText).filter(Boolean),
		selectionReason: normalizeText(candidate.selectionReason),
	}
}

function candidateScore(candidate: ClozeCandidate): number {
	const length = wordCount(candidate.sentence)
	const lengthPenalty = length < 5 ? 8 : length > 12 ? Math.min(12, length - 12) : 0
	const edgePenalty = targetAtEdge(candidate) ? 7 : 0
	return (
		candidate.naturalness * 10 +
		candidate.usefulness * 9 +
		candidate.modernness * 5 +
		candidate.fun * 2 -
		candidate.risk * 8 -
		lengthPenalty -
		edgePenalty
	)
}

function normalizeCandidates(candidates: ClozeCandidate[], targetText: string): ClozeCandidate[] {
	return candidates
		.map((candidate) => normalizeCandidate(candidate, targetText))
		.filter((candidate): candidate is ClozeCandidate => candidate !== null)
}

function selectBestClozes(usable: ClozeCandidate[], selectedPerUnit: number): ClozeCandidate[] {
	const byDifficulty = {
		easy: usable
			.filter((c) => c.difficulty === "easy")
			.sort((a, b) => candidateScore(b) - candidateScore(a)),
		medium: usable
			.filter((c) => c.difficulty === "medium")
			.sort((a, b) => candidateScore(b) - candidateScore(a)),
		hard: usable
			.filter((c) => c.difficulty === "hard")
			.sort((a, b) => candidateScore(b) - candidateScore(a)),
	}

	const picked: ClozeCandidate[] = []
	const take = (difficulty: keyof typeof byDifficulty, count: number) => {
		for (const candidate of byDifficulty[difficulty]) {
			if (picked.length >= selectedPerUnit) return
			if (picked.some((p) => p.cloze === candidate.cloze || p.sentence === candidate.sentence))
				continue
			picked.push(candidate)
			if (picked.filter((p) => p.difficulty === difficulty).length >= count) return
		}
	}

	take("easy", 2)
	take("medium", 2)
	take("hard", 1)

	if (picked.length < selectedPerUnit) {
		for (const candidate of [...usable].sort((a, b) => candidateScore(b) - candidateScore(a))) {
			if (picked.length >= selectedPerUnit) break
			if (picked.some((p) => p.cloze === candidate.cloze || p.sentence === candidate.sentence))
				continue
			picked.push(candidate)
		}
	}

	const order = { easy: 0, medium: 1, hard: 2 } satisfies Record<
		ClozeCandidate["difficulty"],
		number
	>
	return picked
		.slice(0, selectedPerUnit)
		.sort(
			(a, b) => order[a.difficulty] - order[b.difficulty] || candidateScore(b) - candidateScore(a),
		)
}

function summarizeRejectedCandidates(candidates: ClozeCandidate[], usableCount: number): string {
	return JSON.stringify({
		returned: candidates.length,
		usable: usableCount,
		sample: candidates.slice(0, 3).map((candidate) => ({
			sentence: candidate.sentence,
			cloze: candidate.cloze,
			answer: candidate.answer,
			difficulty: candidate.difficulty,
			words: wordCount(candidate.sentence),
		})),
	})
}

function buildUnitJson(word: {
	lemma: string
	pos: string
	rank: number
	definitions: Prisma.JsonValue
	curriculumUnit: Prisma.JsonValue | null
}) {
	const unit = asRecord(word.curriculumUnit)
	return {
		text: word.lemma,
		type: typeof unit.unitType === "string" ? unit.unitType : "WORD",
		pos: word.pos,
		form: asRecord(unit.form),
		gloss: firstGloss(word.definitions),
		tags: Array.isArray(unit.tags)
			? unit.tags.filter((x): x is string => typeof x === "string")
			: [],
		rank: word.rank,
	}
}

function buildSystemPrompt(languageName: string): string {
	return `You are generating cloze sentences for a language learning app.

Generate sentence candidates for modern everyday spoken ${languageName}.

Goals:
- Prefer high-frequency conversational sentence shapes.
- Avoid literary, formal, archaic, translated, or textbook-sounding phrasing.
- Sentences should be realistic, natural, and useful for testing.
- Add light humour or personality when it still sounds natural.
- Each sentence should introduce only one new concept; surrounding words should be common.

Rules:
- Return exactly the requested number of candidates.
- Each candidate must use these fields exactly:
  - sentence: the full sentence with the answer visible and no blanks.
  - cloze: the same sentence with only the answer replaced by "____".
  - answer: the exact text removed from cloze.
- Most sentences should be 5-12 words. For very common function words or pronouns, 2-4 words is acceptable when the cloze is still unambiguous.
- Include at least 2 questions, at least 2 statements, and at least 1 multi-sentence candidate.
- Use "____" for blanks in cloze only, never in sentence.
- The blank must be unambiguous and must not remove surrounding words.
- VERB: cloze the main verb.
- PARTICLE/PREPOSITION: cloze the particle or preposition.
- SPLIT: cloze both parts.
- FIXED_EXPR: cloze the full expression.
- NOUN: prefer object position.

Score every candidate:
- naturalness 0-5
- usefulness 0-5
- modernness 0-5
- fun 0-5
- risk 0-5, where risk means ambiguous, rare, abstract, unnatural, textbooky, over-idiomatic, or target first/last.

Return JSON only.`
}

function buildPrompt(unitJson: unknown, candidatesPerUnit: number): string {
	return `INPUT UNIT JSON:
${JSON.stringify(unitJson, null, 2)}

Generate ${candidatesPerUnit} candidate clozes for this unit.

CRITICAL:
- The "answer" field must be exactly INPUT UNIT JSON.text.
- Do not generate clozes for another useful word in the sentence.
- If INPUT UNIT JSON.text is "skulle", answer must be "skulle", not a nearby verb like "åka".
- If INPUT UNIT JSON.text is "då", answer must be "då", not a connector like "så".`
}

async function generatedClozeCountsByWordId(wordIds: string[]): Promise<Map<string, number>> {
	if (wordIds.length === 0) return new Map()
	const rows = await prisma.generatedCloze.groupBy({
		by: ["wordId"],
		where: { wordId: { in: wordIds } },
		_count: true,
	})
	return new Map(rows.map((row) => [row.wordId, row._count]))
}

async function resetClozeMaterial(languageId: string, jobId: string) {
	await appendJobLog(jobId, "out", "Resetting existing cloze material for this language…")
	const [generated, words, sentenceWords, aiSentences] = await prisma.$transaction([
		prisma.generatedCloze.deleteMany({ where: { languageId } }),
		prisma.word.updateMany({
			where: { languageId },
			data: { testSentenceIds: [], aiSynonyms: [] },
		}),
		prisma.sentenceWord.updateMany({
			where: { sentence: { languageId } },
			data: {
				aiKeep: null,
				aiUsefulness: null,
				aiNaturalness: null,
				aiCompositionalityTier: null,
				aiClozePriority: null,
			},
		}),
		prisma.sentence.deleteMany({ where: { languageId, source: "AI_GENERATED" } }),
	])
	await appendJobLog(
		jobId,
		"out",
		`Reset complete: deleted ${generated.count} generated cloze(s), cleared ${words.count} word row(s), reset ${sentenceWords.count} sentence link score(s), deleted ${aiSentences.count} AI sentence row(s).`,
	)
}

export async function processClozeGenerationJob(job: PgBoss.Job<ClozeGenerationJobData>) {
	const {
		jobId,
		languageId,
		unitsLimit,
		candidatesPerUnit = DEFAULT_CANDIDATES_PER_UNIT,
		selectedPerUnit = DEFAULT_SELECTED_PER_UNIT,
		resetExisting = true,
	} = job.data

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const row = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[cloze-generation] skipped job ${jobId}: could not claim (status=${row?.status ?? "missing"})`,
		)
		return
	}

	try {
		const language = await prisma.language.findUnique({ where: { id: languageId } })
		if (!language) throw new Error(`Language ${languageId} not found`)

		const aiConfig = await getAiConfig()
		if (!aiConfig) {
			throw new Error("AI is not configured. Set provider, model, and API key in admin settings.")
		}
		const model = createModel(aiConfig)

		await appendJobLog(
			jobId,
			"out",
			`Starting cloze generation for ${language.name}: ${candidatesPerUnit} candidate(s), selecting ${selectedPerUnit} per unit…`,
		)

		if (resetExisting) {
			await resetClozeMaterial(languageId, jobId)
		}

		const words = await prisma.word.findMany({
			where: {
				languageId,
				curriculumSource: "AI_CURRICULUM",
				rank: { gt: 0 },
				isAbbreviation: false,
				isOffensive: false,
			},
			orderBy: [{ effectiveRank: "asc" }, { rank: "asc" }],
			...(unitsLimit && unitsLimit > 0 ? { take: unitsLimit } : {}),
			select: {
				id: true,
				lemma: true,
				pos: true,
				rank: true,
				effectiveRank: true,
				definitions: true,
				curriculumUnit: true,
			},
		})

		const wordIds = words.map((word) => word.id)
		const existingCounts = resetExisting
			? new Map<string, number>()
			: await generatedClozeCountsByWordId(wordIds)
		const skippedExisting = resetExisting
			? 0
			: words.filter((word) => (existingCounts.get(word.id) ?? 0) >= selectedPerUnit).length
		const existingGeneratedClozes = resetExisting
			? 0
			: words.reduce((sum, word) => {
					const count = existingCounts.get(word.id) ?? 0
					return count >= selectedPerUnit ? sum + count : sum
				}, 0)
		const remainingWords = resetExisting
			? words
			: words.filter((word) => (existingCounts.get(word.id) ?? 0) < selectedPerUnit)

		await updateIngestionProgress(jobId, {
			totalItems: words.length,
			processedItems: skippedExisting,
			extraMetadata: {
				generatedClozes: existingGeneratedClozes,
				clozeGeneration: {
					completedWords: skippedExisting,
					skippedExisting,
					generatedClozes: existingGeneratedClozes,
					remainingWords: remainingWords.length,
				},
			},
		})
		const concurrency = clozeGenerationLlmConcurrency()
		await appendJobLog(
			jobId,
			"out",
			resetExisting
				? `Found ${words.length} AI curriculum unit(s). Generating with ${concurrency} parallel LLM task(s)…`
				: `Found ${words.length} AI curriculum unit(s). Resuming: ${skippedExisting} complete, ${remainingWords.length} remaining. Generating with ${concurrency} parallel LLM task(s)…`,
		)

		let generatedThisRun = 0
		let processedThisRun = 0

		const processWord = async (word: (typeof words)[number]) => {
			if (await isIngestionJobCancelled(jobId)) return
			let errorThisWord = 0
			try {
				const unitJson = buildUnitJson(word)
				const { output } = await generateText({
					model,
					output: Output.object({ schema: clozeGenerationSchema }),
					system: buildSystemPrompt(language.name),
					prompt: buildPrompt(unitJson, candidatesPerUnit),
				})

				const usableCandidates = normalizeCandidates(output.candidates, word.lemma)
				const selected = selectBestClozes(usableCandidates, selectedPerUnit)
				if (selected.length < selectedPerUnit) {
					throw new Error(
						`Only ${selected.length}/${selectedPerUnit} usable cloze(s) returned after validation. Candidate summary: ${summarizeRejectedCandidates(output.candidates, usableCandidates.length)}`,
					)
				}

				await prisma.$transaction([
					prisma.generatedCloze.deleteMany({ where: { wordId: word.id } }),
					...selected.map((candidate, index) =>
						prisma.generatedCloze.create({
							data: {
								languageId,
								wordId: word.id,
								sentence: candidate.sentence,
								cloze: candidate.cloze,
								answer: candidate.answer,
								alternatives: candidate.alternatives,
								difficulty: candidate.difficulty,
								tags: candidate.tags,
								sortOrder: index + 1,
								sourceCandidates: output.candidates as Prisma.InputJsonValue,
								selectionReason: candidate.selectionReason,
							},
						}),
					),
					prisma.word.update({
						where: { id: word.id },
						data: {
							isTestable: true,
							aiSynonyms: selected[0]?.alternatives ?? [],
						},
					}),
				])

				generatedThisRun += selected.length
				if (word.effectiveRank <= 50 || generatedThisRun % 100 === 0) {
					await appendJobLog(jobId, "out", `"${word.lemma}": stored ${selected.length} cloze(s).`)
				}
			} catch (err) {
				errorThisWord = 1
				await appendJobLog(
					jobId,
					"err",
					`Failed for "${word.lemma}": ${err instanceof Error ? err.message : String(err)}`,
				)
			}

			processedThisRun += 1
			const completedWords = skippedExisting + processedThisRun
			const generatedClozes = existingGeneratedClozes + generatedThisRun
			const shouldWriteMetadata =
				processedThisRun === remainingWords.length ||
				processedThisRun % CLOZE_PROGRESS_METADATA_INTERVAL === 0 ||
				word.effectiveRank <= 50
			await updateIngestionProgress(jobId, {
				processedDelta: 1,
				...(errorThisWord ? { errorDelta: 1 } : {}),
				...(shouldWriteMetadata
					? {
							extraMetadata: {
								generatedClozes,
								clozeGeneration: {
									completedWords,
									skippedExisting,
									generatedClozes,
									lastWord: word.lemma,
									remainingWords: Math.max(words.length - completedWords, 0),
								},
							},
						}
					: {}),
			})
		}

		await runPool(remainingWords, concurrency, processWord, () => isIngestionJobCancelled(jobId))
		if (await isIngestionJobCancelled(jobId)) return

		const finalGeneratedClozes = await prisma.generatedCloze.count({
			where: {
				languageId,
				wordId: { in: wordIds },
			},
		})
		const doneRow = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { processedItems: true, errorCount: true },
		})
		const metadata = await snapshotJobMetadata(jobId)
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "COMPLETED",
				completedAt: new Date(),
				metadata: {
					...metadata,
					generatedClozes: finalGeneratedClozes,
					clozeGeneration: {
						completedWords: doneRow?.processedItems ?? skippedExisting + processedThisRun,
						skippedExisting,
						generatedClozes: finalGeneratedClozes,
						remainingWords: 0,
					},
					candidatesPerUnit,
					selectedPerUnit,
				} as Prisma.InputJsonValue,
			},
		})
		await appendJobLog(
			jobId,
			"out",
			`Done: ${doneRow?.processedItems ?? 0} unit(s) processed, ${finalGeneratedClozes} cloze(s) available, ${doneRow?.errorCount ?? 0} error(s).`,
		)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error(`[cloze-generation] job ${jobId} failed:`, message)
		await appendJobLog(jobId, "err", message)
		const metadata = await snapshotJobMetadata(jobId)
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: { ...metadata, error: message } as Prisma.InputJsonValue,
			},
		})
	}
}
