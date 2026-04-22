import type { Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { generateObject } from "ai"
import type PgBoss from "pg-boss"
import { z } from "zod"
import { createModel } from "../lib/ai"
import { getAiConfig } from "../lib/app-settings"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"

export interface ClozeQualityJobData {
	jobId: string
	languageId: string
}

const sentenceAssessmentSchema = z.object({
	keep: z.boolean().describe("Whether this sentence is suitable as a cloze test item"),
	usefulness: z
		.number()
		.int()
		.min(0)
		.max(5)
		.describe("How well the sentence tests knowledge of the target word (0=useless, 5=excellent)"),
	naturalness: z
		.number()
		.int()
		.min(0)
		.max(5)
		.describe("How natural and realistic the sentence sounds (0=unnatural, 5=very natural)"),
	reason: z.string().describe("Short explanation, especially if keep=false"),
})

const clozeAssessmentSchema = z.object({
	sentences: z
		.array(sentenceAssessmentSchema)
		.describe("One assessment per sentence, in the same order as the input"),
	synonyms: z
		.array(z.string())
		.describe(
			"Up to 3 alternative answers (synonyms) that work naturally in ALL of the best kept sentences. Be strict — only include answers that clearly fit every sentence. Prefer 0–2 if unsure.",
		),
})

function buildClozeText(sentenceText: string, lemma: string): string {
	const wordForms = new RegExp(`\\b${lemma}\\b`, "gi")
	const blanked = sentenceText.replace(wordForms, "___")
	return blanked === sentenceText ? `${sentenceText} [target: ${lemma}]` : blanked
}

export async function processClozeQualityJob(job: PgBoss.Job<ClozeQualityJobData>) {
	const { jobId, languageId } = job.data

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const row = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[cloze-quality] skipped job ${jobId}: could not claim (status=${row?.status ?? "missing"})`,
		)
		return
	}

	try {
		const language = await prisma.language.findUnique({ where: { id: languageId } })
		if (!language) throw new Error(`Language ${languageId} not found`)

		await appendJobLog(jobId, "out", `Starting cloze quality assessment for ${language.name}…`)

		const aiConfig = await getAiConfig()
		if (!aiConfig) {
			throw new Error("AI is not configured. Set provider, model, and API key in admin settings.")
		}

		const model = createModel(aiConfig)

		// Fetch top-1000 testable words ordered by frequency rank (rank > 0 excludes unranked words).
		// Multiple Word rows can share the same lemma (different POS), so we group them after fetching
		// and keep the lowest rank (most common) as the canonical word for storing synonyms.
		const rawWords = await prisma.word.findMany({
			where: { languageId, isTestable: true, rank: { gt: 0 } },
			orderBy: { rank: "asc" },
			take: 1000,
			select: {
				id: true,
				lemma: true,
				rank: true,
				sentenceWords: {
					select: {
						id: true,
						sentenceId: true,
						sentence: { select: { id: true, text: true } },
					},
				},
			},
		})

		// Deduplicate by lemma: merge sentence words, use the lowest-rank row as canonical.
		type RawWord = (typeof rawWords)[number]
		const lemmaMap = new Map<
			string,
			{ canonical: RawWord; allSentenceWords: RawWord["sentenceWords"] }
		>()
		for (const word of rawWords) {
			const existing = lemmaMap.get(word.lemma)
			if (!existing) {
				lemmaMap.set(word.lemma, {
					canonical: word,
					allSentenceWords: [...word.sentenceWords],
				})
			} else {
				// Merge sentences; canonical is already the lowest rank (list is sorted asc)
				existing.allSentenceWords.push(...word.sentenceWords)
			}
		}
		const words = Array.from(lemmaMap.values())

		const totalWords = words.length
		await updateIngestionProgress(jobId, { totalItems: totalWords })
		await appendJobLog(
			jobId,
			"out",
			`Found ${totalWords} distinct lemmas. Assessing cloze quality…`,
		)

		let processed = 0
		let errors = 0

		for (const { canonical: word, allSentenceWords } of words) {
			if (await isIngestionJobCancelled(jobId)) return

			if (allSentenceWords.length === 0) {
				processed++
				await updateIngestionProgress(jobId, { processedItems: processed, errorCount: errors })
				continue
			}

			// Deduplicate sentences by sentenceId (the same sentence may appear via multiple POS rows)
			const seenSentenceIds = new Set<string>()
			const uniqueSentenceWords = allSentenceWords.filter((sw) => {
				if (seenSentenceIds.has(sw.sentenceId)) return false
				seenSentenceIds.add(sw.sentenceId)
				return true
			})

			const sentences = uniqueSentenceWords.map((sw, i) => ({
				index: i + 1,
				sentenceWordId: sw.id,
				sentenceId: sw.sentenceId,
				clozeText: buildClozeText(sw.sentence.text, word.lemma),
			}))

			const numberedList = sentences
				.map((s) => `${s.index}. ${s.clozeText}`)
				.join("\n")

			try {
				await appendJobLog(
					jobId,
					"out",
					`Assessing "${word.lemma}" (${sentences.length} sentences)…`,
				)

				const { object } = await generateObject({
					model,
					schema: clozeAssessmentSchema,
					system: `You are a designer of a language learning system. You are evaluating cloze sentences for their suitability in testing whether a user knows a specific vocabulary word.

Your goal is NOT to judge general sentence quality.
Your goal is to detect whether each sentence is a clean and reliable test of the target word.

Evaluation criteria:

A GOOD test sentence:
- Clearly requires knowing the target word (cannot be guessed easily)
- Has exactly one natural answer in context
- Is not too long or cognitively complex
- Does not rely on idioms or strong collocations that give away the answer
- Does not contain the target word elsewhere
- Is natural and realistic

A BAD test sentence:
- Multiple valid answers (e.g. synonyms fit)
- Too vague or underspecified
- Too easy to guess from context alone
- Too long or structurally complex relative to the word
- Contains the target word elsewhere
- Feels unnatural or translated`,
					prompt: `Lemma: "${word.lemma}"

Sentences:
${numberedList}

Tasks:

1. For each sentence, return:
- "keep": true/false
- "usefulness": 0–5 (how well it tests knowledge of the word)
- "naturalness": 0–5
- "reason": short explanation (especially if rejected)

2. Given only the sentences where keep=true (up to the best 3 by usefulness):
List up to 3 alternative answers (synonyms) that work naturally in ALL of them.
- Be strict: only include answers that clearly fit every kept sentence
- Prefer 0–2 if unsure
- Do NOT include rare or awkward alternatives

Return JSON only.`,
				})

				// Persist sentence-level assessments
				for (let i = 0; i < sentences.length; i++) {
					const assessment = object.sentences[i]
					if (!assessment) continue
					await prisma.sentenceWord.update({
						where: { id: sentences[i].sentenceWordId },
						data: {
							aiKeep: assessment.keep,
							aiUsefulness: assessment.usefulness,
							aiNaturalness: assessment.naturalness,
						},
					})
				}

				// Persist synonyms on the word
				await prisma.word.update({
					where: { id: word.id },
					data: { aiSynonyms: object.synonyms },
				})
			} catch (err) {
				errors++
				await appendJobLog(
					jobId,
					"err",
					`Failed for "${word.lemma}": ${err instanceof Error ? err.message : String(err)}`,
				)
			}

			processed++
			await updateIngestionProgress(jobId, { processedItems: processed, errorCount: errors })
		}

		await appendJobLog(
			jobId,
			"out",
			`Done: ${processed} words assessed, ${errors} errors`,
		)

		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: { status: "COMPLETED", completedAt: new Date() },
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error(`[cloze-quality] job ${jobId} failed:`, message)
		await appendJobLog(jobId, "err", message)

		const row = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true },
		})
		const prev = (row?.metadata ?? {}) as Record<string, unknown>

		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: { ...prev, error: message } as Prisma.InputJsonValue,
			},
		})
	}
}
