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

export interface FixedExpressionsJobData {
	jobId: string
	languageId: string
}

/** Zod schema for the LLM's structured output. */
const fixedExpressionRuleSchema = z.object({
	trigger: z.string().describe("A word that must appear in the cloze sentence for this rule to fire (e.g. 'tycker')"),
	required: z.string().describe("The correct particle/preposition the exercise expects (e.g. 'om')"),
	invalid: z.array(z.string()).describe("Common wrong guesses a learner might enter instead"),
	expression: z.string().describe("The full fixed expression in dictionary form (e.g. 'tycka om')"),
	meaning: z.string().describe("Brief English meaning of the expression (e.g. 'to like')"),
})

const rulesArraySchema = z.object({
	rules: z.array(fixedExpressionRuleSchema),
})

export async function processFixedExpressionsJob(job: PgBoss.Job<FixedExpressionsJobData>) {
	const { jobId, languageId } = job.data

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const row = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[fixed-expressions] skipped job ${jobId}: could not claim (status=${row?.status ?? "missing"})`,
		)
		return
	}

	try {
		const language = await prisma.language.findUnique({ where: { id: languageId } })
		if (!language) {
			throw new Error(`Language ${languageId} not found`)
		}

		await appendJobLog(jobId, "out", `Generating fixed expression rules for ${language.name}…`)

		// ── Get AI config ──
		const aiConfig = await getAiConfig()
		if (!aiConfig) {
			throw new Error(
				"AI is not configured. Set provider, model, and API key in admin settings.",
			)
		}

		const model = createModel(aiConfig)

		// ── Call the LLM ──
		await appendJobLog(jobId, "out", `Calling ${aiConfig.provider}/${aiConfig.model}…`)

		const { object } = await generateObject({
			model,
			schema: rulesArraySchema,
			system: `You are a linguistics expert specialising in ${language.name}. Generate fixed expression rules for a language-learning app's grammar feedback engine.

A "fixed expression" is a multi-word unit (usually verb + preposition/particle) where the preposition is NOT predictable from general grammar rules and must be memorised. Common examples in Swedish: "tycka om" (to like), "tänka på" (to think about).

Rules are used to detect when a learner enters the WRONG preposition in a cloze (fill-in-the-blank) exercise and provide a helpful hint.

Guidelines:
- Include only modern, commonly used expressions — nothing archaic or literary
- Focus on verb + preposition/particle combinations that learners frequently get wrong
- The "trigger" should be a conjugated form that appears in real sentences (e.g. "tycker" not "tycka")
- For verbs with multiple common conjugation forms, create separate rules for each (e.g. "tycker", "tyckte" for "tycka om")
- The "invalid" array should contain prepositions learners commonly confuse — usually 1-3 items
- The "meaning" should be a brief English translation
- Aim for roughly 40-80 rules — enough to cover the most common cases without being exhaustive
- Quality over quantity: each rule should represent a genuinely tricky fixed expression`,
			prompt: `Generate fixed expression rules for ${language.name}.

Here are 3 example rules (Swedish) showing the exact format:

{ "trigger": "tycker", "required": "om", "invalid": ["än", "på"], "expression": "tycka om", "meaning": "to like" }
{ "trigger": "tänker", "required": "på", "invalid": ["om"], "expression": "tänka på", "meaning": "to think about" }
{ "trigger": "bra", "required": "på", "invalid": ["i"], "expression": "vara bra på", "meaning": "to be good at" }

Now generate the rules for ${language.name}. Return them as a JSON object with a "rules" array.`,
		})

		const rules = object.rules
		await appendJobLog(jobId, "out", `LLM returned ${rules.length} rules`)

		// Store raw LLM output in metadata for auditability
		await updateIngestionProgress(jobId, {
			totalItems: rules.length,
			extraMetadata: { generatedRules: rules },
		})

		if (await isIngestionJobCancelled(jobId)) return

		// ── Upsert into DB ──
		let upserted = 0
		let errors = 0

		for (const rule of rules) {
			if (await isIngestionJobCancelled(jobId)) return

			try {
				await prisma.fixedExpressionRule.upsert({
					where: {
						languageId_trigger_required: {
							languageId,
							trigger: rule.trigger,
							required: rule.required,
						},
					},
					update: {
						invalid: rule.invalid,
						expression: rule.expression,
						meaning: rule.meaning,
					},
					create: {
						languageId,
						trigger: rule.trigger,
						required: rule.required,
						invalid: rule.invalid,
						expression: rule.expression,
						meaning: rule.meaning,
					},
				})
				upserted++
			} catch (err) {
				errors++
				await appendJobLog(
					jobId,
					"err",
					`Failed to upsert rule "${rule.expression}": ${err instanceof Error ? err.message : String(err)}`,
				)
			}

			await updateIngestionProgress(jobId, {
				processedItems: upserted + errors,
				errorCount: errors,
			})
		}

		await appendJobLog(
			jobId,
			"out",
			`Done: ${upserted} rules upserted, ${errors} errors`,
		)

		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: { status: "COMPLETED", completedAt: new Date() },
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.error(`[fixed-expressions] job ${jobId} failed:`, message)
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
