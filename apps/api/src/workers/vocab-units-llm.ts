import type { PartOfSpeech, Prisma } from "@nwords/db"
import { prisma } from "@nwords/db"
import { cefrLevelForFrequencyRank } from "@nwords/shared"
import { generateObject } from "ai"
import type PgBoss from "pg-boss"
import { z } from "zod"
import { createModel } from "../lib/ai"
import type { AiCurriculumUnitJson } from "../lib/ai-curriculum-definition"
import { getAiConfig } from "../lib/app-settings"
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel"
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs"
import { updateIngestionProgress } from "../lib/job-progress"
import { resolveWordOrder } from "../lib/resolve-word-order"

export interface VocabUnitsLlmJobData {
	jobId: string
	languageId: string
	requiredWords: string[]
	unitCount: number
	glossLanguageName?: string
	glossLanguageCode?: string
	chainPipeline?: boolean
}

const TESTABLE_POS = new Set<PartOfSpeech>(["NOUN", "VERB", "ADJECTIVE", "ADVERB"])

function asMetaRecord(metadata: unknown): Record<string, unknown> {
	if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
		return { ...(metadata as Record<string, unknown>) }
	}
	return {}
}

export function normalizeCurriculumText(s: string): string {
	return s.normalize("NFC").trim()
}

/** OpenAI: default `gpt-4.1-mini`; override with `VOCAB_UNITS_LLM_MODEL`. Other providers use admin model. */
function resolveVocabUnitsModel(provider: string, adminModel: string): string {
	const env = process.env.VOCAB_UNITS_LLM_MODEL?.trim()
	if (env) return env
	if (provider === "openai") return "gpt-4.1-mini"
	return adminModel
}

function mapDesignPos(pos: string): PartOfSpeech {
	switch (pos) {
		case "VERB":
			return "VERB"
		case "NOUN":
			return "NOUN"
		case "ADJ":
			return "ADJECTIVE"
		case "ADV":
			return "ADVERB"
		case "PRON":
			return "PRONOUN"
		case "PREP":
			return "PREPOSITION"
		case "CONJ":
			return "CONJUNCTION"
		case "DET":
			return "DETERMINER"
		default:
			// LLM catch-all must not become linguistics PARTICLE (confuses admin + learner word lists).
			return "INTERJECTION"
	}
}

const unitTypeSchema = z.enum(["WORD", "PARTICLE", "FIXED_EXPR", "SPLIT"])
const designPosSchema = z.enum([
	"VERB",
	"NOUN",
	"ADJ",
	"ADV",
	"PRON",
	"PREP",
	"CONJ",
	"DET",
	"OTHER",
])

/** OpenAI structured output rejects `additionalProperties` without a concrete `type`; use string values only. */
const candidateUnitSchema = z.object({
	text: z.string(),
	lang: z.string(),
	type: unitTypeSchema,
	pos: designPosSchema,
	form: z.record(z.string(), z.string()).optional(),
	gloss: z.string(),
	tags: z.array(z.string()),
})

const unitSchema = candidateUnitSchema.extend({
	rank: z.number().int(),
})

const vocabOutSchema = z.object({
	units: z.array(candidateUnitSchema),
})

type VocabCandidateUnit = z.infer<typeof candidateUnitSchema>
type VocabUnit = z.infer<typeof unitSchema>

function unitTokens(text: string): string[] {
	return text.match(/[\p{L}\p{N}]+/gu) ?? []
}

/** First-token pronouns / discourse that usually start a clause (SV + EN). */
const CLAUSE_START_TOKENS = new Set([
	"jag",
	"du",
	"han",
	"hon",
	"vi",
	"ni",
	"de",
	"dom",
	"det",
	"den",
	"man",
	"nu",
	"så",
	"i",
	"you",
	"he",
	"she",
	"we",
	"they",
	"it",
	"here",
	"there",
	"then",
])

/** WH / question-word starts on a multi-word unit — not a particle-verb lexical chunk. */
const WH_OR_QUESTION_START_TOKENS = new Set([
	"vad",
	"vem",
	"vilket",
	"vilken",
	"vilka",
	"varför",
	"hur",
	"när",
	"var",
	"vart",
	"how",
	"what",
	"who",
	"whom",
	"whose",
	"why",
	"when",
	"where",
	"which",
])

const FINITE_OR_AUXILIARY_TOKENS = new Set([
	// Swedish
	"är",
	"var",
	"har",
	"hade",
	"kommer",
	"kom",
	"ska",
	"skall",
	"vill",
	"kan",
	"måste",
	"får",
	"blev",
	"blir",
	"ha",
	// English: copula + auxiliaries (appearing in greetings / questions / light clauses)
	"am",
	"is",
	"are",
	"was",
	"were",
	"been",
	"being",
	"do",
	"does",
	"did",
	"done",
	"has",
	"have",
	"had",
	"will",
	"would",
	"shall",
	"should",
	"could",
	"might",
	"may",
	"must",
	"need",
])

/**
 * Keep the curriculum lexical. Multi-word units are allowed only for particle / split verbs.
 */
function rejectReasonForUnit(unit: Pick<VocabUnit, "text" | "type">): string | null {
	const text = normalizeCurriculumText(unit.text)
	const tokens = unitTokens(text)
	if (tokens.length <= 1) return null

	const lowerTokens = tokens.map((t) => t.toLowerCase())
	const first = lowerTokens[0]
	if (!first) return null

	if (unit.type === "WORD") return "multi-word WORD"
	if (unit.type === "SPLIT") {
		if (!text.includes("...")) return "SPLIT missing ellipsis"
		if (tokens.length > 3) return "SPLIT too long"
		return null
	}

	if (unit.type !== "PARTICLE") return "only particle/split verbs may be multi-word"
	if (tokens.length > 3) return "multi-word expression too long"
	if (/[?!]/.test(text)) return "sentence-like punctuation"
	if (WH_OR_QUESTION_START_TOKENS.has(first)) return "question or WH-led phrase"
	if (CLAUSE_START_TOKENS.has(first)) return "sentence-like phrase"
	if (lowerTokens.some((token) => FINITE_OR_AUXILIARY_TOKENS.has(token))) {
		return "ordinary verb phrase"
	}
	return null
}

/** OpenAI structured output often truncates huge JSON; batch to stay under output limits. */
function resolveVocabUnitsBatchSize(): number {
	const raw = process.env.VOCAB_UNITS_LLM_BATCH_SIZE?.trim()
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN
	if (Number.isFinite(n) && n >= 50 && n <= 500) return n
	return 200
}

/** Maximum candidate chunks before giving up if too many duplicates/missing seeds prevent reaching the target. */
function resolveVocabUnitsMaxChunks(unitCount: number, batchSize: number): number {
	const raw = process.env.VOCAB_UNITS_LLM_MAX_CHUNKS?.trim()
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN
	if (Number.isFinite(n) && n >= 1 && n <= 100) return n
	return Math.ceil(unitCount / batchSize) * 2 + 4
}

/**
 * We prefer the requested unitCount, but completing with a large-enough unique collection is better than
 * burning many slow LLM calls on low-yield tail chunks.
 */
function resolveVocabUnitsMinAcceptedCount(unitCount: number): number {
	const rawCount = process.env.VOCAB_UNITS_LLM_MIN_ACCEPTED_COUNT?.trim()
	const explicitCount = rawCount ? Number.parseInt(rawCount, 10) : Number.NaN
	if (Number.isFinite(explicitCount) && explicitCount > 0) {
		return Math.min(unitCount, Math.floor(explicitCount))
	}

	const rawRatio = process.env.VOCAB_UNITS_LLM_MIN_ACCEPTED_RATIO?.trim()
	const ratio = rawRatio ? Number.parseFloat(rawRatio) : Number.NaN
	const effectiveRatio = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.75
	return Math.max(1, Math.ceil(unitCount * effectiveRatio))
}

function buildForbiddenSurfaceHint(previousUnits: VocabUnit[], maxLines: number): string | null {
	if (previousUnits.length === 0 || maxLines <= 0) return null
	const seen = new Set<string>()
	for (const u of previousUnits) {
		const t = normalizeCurriculumText(u.text)
		if (t) seen.add(t)
	}
	const lines = [...seen].slice(0, maxLines)
	if (lines.length === 0) return null
	return lines.map((l) => `- ${l}`).join("\n")
}

function curriculumUnitKey(u: z.infer<typeof unitSchema>): string {
	return `${normalizeCurriculumText(u.text)}\0${mapDesignPos(u.pos)}`
}

function designPosFromDb(pos: PartOfSpeech): VocabCandidateUnit["pos"] {
	switch (pos) {
		case "VERB":
			return "VERB"
		case "NOUN":
			return "NOUN"
		case "ADJECTIVE":
			return "ADJ"
		case "ADVERB":
			return "ADV"
		case "PRONOUN":
			return "PRON"
		case "PREPOSITION":
			return "PREP"
		case "CONJUNCTION":
			return "CONJ"
		case "DETERMINER":
			return "DET"
		default:
			return "OTHER"
	}
}

function firstDefinitionAsGloss(definitions: unknown): string {
	if (Array.isArray(definitions) && typeof definitions[0] === "string" && definitions[0].trim()) {
		return definitions[0]
	}
	return ""
}

function existingAiWordToUnit(word: {
	lemma: string
	pos: PartOfSpeech
	rank: number
	definitions: Prisma.JsonValue
	curriculumUnit: Prisma.JsonValue | null
}): VocabUnit {
	const curriculumUnit = asMetaRecord(word.curriculumUnit)
	const parsedType = unitTypeSchema.safeParse(curriculumUnit.unitType)
	const parsedTags = z.array(z.string()).safeParse(curriculumUnit.tags)
	const parsedForm = z.record(z.string(), z.string()).safeParse(curriculumUnit.form)

	return {
		text: normalizeCurriculumText(word.lemma),
		lang: typeof curriculumUnit.lang === "string" ? curriculumUnit.lang : "",
		type: parsedType.success ? parsedType.data : "WORD",
		pos: designPosFromDb(word.pos),
		...(parsedForm.success ? { form: parsedForm.data } : {}),
		gloss: firstDefinitionAsGloss(word.definitions),
		tags: parsedTags.success ? parsedTags.data : [],
		rank: word.rank,
	}
}

function buildCandidateSystemPrompt(
	languageName: string,
	langCode: string,
	glossLocaleName: string,
	_glossLocaleCode: string,
): string {
	return `You are designing a vocabulary list for a language learning app.

Generate useful "learning units" for everyday spoken ${languageName}.

A learning unit is:
- usually a single word (in any useful form: plural, gendered, conjugated), OR
- rarely, a particle verb or split verb expression that must be memorised as a lexical unit.

Rules:
1. Prefer modern, spoken language.
2. Avoid literary, poetic, archaic, formal-only, rare, or domain-specific vocabulary.
3. Prefer single-word lexical units. At least 90% of the list should be single words.
4. Include a balanced mix of nouns, verbs, adjectives, adverbs, and function words.
5. Multi-word units are allowed ONLY as type PARTICLE (verb + particle/preposition you must memorise) or type SPLIT ("verb ... particle"). Never use type PARTICLE for greetings, questions, full clauses, or generic conversational formulas.
6. Do NOT include fixed phrases that are not particle verbs. Do NOT include ordinary clauses, sentence fragments, adjective+noun collocations, subject+verb phrases, verb+adverb phrases, greetings, adverbial phrases, or generic formulas.
7. Bad multi-word examples to avoid — do not output these at all, plus any text containing ? or !: "inte så mycket", "ledig dag", "så mycket bättre", "jag tänker", "jag vet inte", "ha en bra dag", "kommer snart", "nu är det bra", "kan du hjälpa mig", "vad heter du", "vi ses senare", "ha det bra", "how are you", "vad gör du".
8. Good multi-word examples: particle/preposition verbs like "tycka om", "tänka på", and split expressions like "se ... ut".
9. For split expressions, use the format "verb ... particle".
10. Avoid duplicates, near-duplicates, and multiple forms of the same word unless both are very common.
11. Keep multi-word units to 2-3 words. Single words may be any useful form.
12. Use lang="${langCode}".
13. Provide short glosses in ${glossLocaleName} (${_glossLocaleCode}).

Return ONLY a JSON object: { "units": [ ... ] }.
Each item: text, lang, type (WORD | PARTICLE | FIXED_EXPR | SPLIT), pos (VERB | NOUN | ADJ | ADV | PRON | PREP | CONJ | DET | OTHER), optional form, gloss, tags.
Use FIXED_EXPR only for single-token lexical items that genuinely do not fit another type; multi-word FIXED_EXPR items will be rejected.
Do not include ranks; the app assigns ranks after deduplication.`
}

function buildCandidateChunkPrompt(
	languageName: string,
	chunkIndex: number,
	chunkSize: number,
	acceptedCount: number,
	targetCount: number,
	requiredSeeds: string[],
	forbiddenSurfaceList: string | null,
): string {
	const requiredBlock =
		requiredSeeds.length > 0
			? `REQUIRED SEED LEMMAS still missing (${requiredSeeds.length} listed here):
Include every item below exactly as written in some unit's "text" field.
${requiredSeeds.map((w) => `- ${w}`).join("\n")}`
			: "No required seed lemmas are currently missing."

	const forbiddenBlock =
		forbiddenSurfaceList !== null
			? `

Already accepted surface forms — avoid reusing these exact "text" values:
${forbiddenSurfaceList}`
			: ""

	return `VOCABULARY CANDIDATE CHUNK ${chunkIndex} (${languageName}).

We have accepted ${acceptedCount}/${targetCount} unique units so far. Return about ${chunkSize} additional candidate units. It is fine if some are rejected later; focus on high-quality everyday vocabulary.

${requiredBlock}
${forbiddenBlock}

Fill the rest of the chunk with new high-utility spoken ${languageName} items. As the accepted count grows, move beyond the most obvious beginner/core words into still-common everyday words and useful inflected forms. Prefer single words; use multi-word units only for true particle verbs or split verb expressions. Avoid duplicate "text" + POS pairs within this response.`
}

export async function processVocabUnitsLlmJob(job: PgBoss.Job<VocabUnitsLlmJobData>) {
	const { jobId, languageId } = job.data

	const row = await prisma.ingestionJob.findUnique({ where: { id: jobId } })
	const fileMeta = asMetaRecord(row?.metadata)

	let requiredWords = job.data.requiredWords
	if (!requiredWords?.length && Array.isArray(fileMeta.requiredWords)) {
		requiredWords = fileMeta.requiredWords.filter((x): x is string => typeof x === "string")
	}
	const unitCount =
		typeof job.data.unitCount === "number" && job.data.unitCount > 0
			? job.data.unitCount
			: typeof fileMeta.unitCount === "number" && fileMeta.unitCount > 0
				? fileMeta.unitCount
				: 2000

	const glossLanguageName =
		typeof job.data.glossLanguageName === "string"
			? job.data.glossLanguageName
			: typeof fileMeta.glossLanguageName === "string"
				? fileMeta.glossLanguageName
				: "English"
	const glossLanguageCode =
		typeof job.data.glossLanguageCode === "string"
			? job.data.glossLanguageCode
			: typeof fileMeta.glossLanguageCode === "string"
				? fileMeta.glossLanguageCode
				: "en"

	if (!requiredWords.length) {
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: {
					error:
						"requiredWords missing — run COMMON_WORDS_TOP first or pass requiredWords in job metadata",
				},
			},
		})
		return
	}

	const started = await tryMarkIngestionJobRunning(jobId)
	if (!started) {
		const r = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { status: true },
		})
		console.warn(
			`[vocab-units-llm] skipped job ${jobId}: could not claim (ingestion status=${r?.status ?? "missing"})`,
		)
		return
	}

	try {
		const language = await prisma.language.findUnique({ where: { id: languageId } })
		if (!language) throw new Error(`Language ${languageId} not found`)

		await appendJobLog(
			jobId,
			"out",
			`Vocabulary units (LLM): ${language.name} — ${unitCount} units, ${requiredWords.length} required seeds…`,
		)

		const aiConfig = await getAiConfig()
		if (!aiConfig) {
			throw new Error("AI is not configured. Set provider, model, and API key in admin settings.")
		}

		const modelId = resolveVocabUnitsModel(aiConfig.provider, aiConfig.model)
		const model = createModel({ ...aiConfig, model: modelId })

		const batchSize = resolveVocabUnitsBatchSize()
		const maxChunks = resolveVocabUnitsMaxChunks(unitCount, batchSize)
		const minAcceptedCount = resolveVocabUnitsMinAcceptedCount(unitCount)

		await appendJobLog(
			jobId,
			"out",
			`Calling ${aiConfig.provider}/${modelId} for candidate chunks (batch size ${batchSize}; target ${unitCount}; minimum ${minAcceptedCount}; max chunks ${maxChunks}; VOCAB_UNITS_LLM_BATCH_SIZE / VOCAB_UNITS_LLM_MIN_ACCEPTED_RATIO / VOCAB_UNITS_LLM_MAX_CHUNKS)…`,
		)

		await updateIngestionProgress(jobId, { totalItems: unitCount })

		const allUnits: VocabUnit[] = []
		const acceptedKeys = new Set<string>()
		const missingRequired = new Set(
			requiredWords.map((w) => normalizeCurriculumText(w)).filter((w) => w.length > 0),
		)
		const keptIds: string[] = []
		let rejectedBadMultiword = 0

		const existingWords = await prisma.word.findMany({
			where: { languageId, curriculumSource: "AI_CURRICULUM" },
			orderBy: [{ rank: "asc" }, { lemma: "asc" }],
			select: {
				id: true,
				lemma: true,
				pos: true,
				rank: true,
				definitions: true,
				curriculumUnit: true,
			},
		})

		for (const word of existingWords) {
			const unit = existingAiWordToUnit(word)
			if (!unit.text) continue
			const rejectReason = rejectReasonForUnit(unit)
			if (rejectReason) {
				rejectedBadMultiword++
				continue
			}
			const key = curriculumUnitKey(unit)
			if (acceptedKeys.has(key)) continue

			allUnits.push(unit)
			acceptedKeys.add(key)
			keptIds.push(word.id)
			missingRequired.delete(unit.text)
		}

		if (allUnits.length > 0) {
			await appendJobLog(
				jobId,
				"out",
				`Resuming from ${allUnits.length} existing AI curriculum unit(s). Rejected ${rejectedBadMultiword} existing sentence-like multi-word unit(s). Required seeds remaining: ${missingRequired.size}.`,
			)
			await updateIngestionProgress(jobId, {
				processedItems: Math.min(allUnits.length, unitCount),
			})
		}

		async function upsertUnit(unit: VocabUnit): Promise<string> {
			const pos = mapDesignPos(unit.pos)
			const lemma = normalizeCurriculumText(unit.text)
			const definitions: Prisma.InputJsonValue = [unit.gloss]
			const curriculumUnit: AiCurriculumUnitJson = {
				unitType: unit.type,
				...(unit.form && Object.keys(unit.form).length > 0
					? { form: unit.form as Record<string, unknown> }
					: {}),
				tags: unit.tags,
				lang: unit.lang,
			}
			const cefr = cefrLevelForFrequencyRank(unit.rank)

			const w = await prisma.word.upsert({
				where: {
					languageId_lemma_pos: { languageId, lemma, pos },
				},
				create: {
					languageId,
					lemma,
					pos,
					curriculumSource: "AI_CURRICULUM",
					curriculumUnit: curriculumUnit as Prisma.InputJsonValue,
					rank: unit.rank,
					effectiveRank: unit.rank,
					definitions,
					isAbbreviation: false,
					isTestable: TESTABLE_POS.has(pos),
					isOffensive: false,
					alternatePos: [],
					testSentenceIds: [],
					aiSynonyms: [],
					...(cefr ? { cefrLevel: cefr } : {}),
				},
				update: {
					curriculumSource: "AI_CURRICULUM",
					curriculumUnit: curriculumUnit as Prisma.InputJsonValue,
					rank: unit.rank,
					effectiveRank: unit.rank,
					definitions,
					isAbbreviation: false,
					isTestable: TESTABLE_POS.has(pos),
					...(cefr ? { cefrLevel: cefr } : {}),
				},
			})
			return w.id
		}

		const system = buildCandidateSystemPrompt(
			language.name,
			language.code,
			glossLanguageName,
			glossLanguageCode,
		)

		for (let chunk = 1; chunk <= maxChunks; chunk++) {
			if (await isIngestionJobCancelled(jobId)) return
			if (allUnits.length >= unitCount && missingRequired.size === 0) break

			const requiredSeeds = [...missingRequired].slice(0, Math.min(batchSize, 200))
			const forbiddenLines = buildForbiddenSurfaceHint(allUnits, 1500)
			const prompt = buildCandidateChunkPrompt(
				language.name,
				chunk,
				batchSize,
				allUnits.length,
				unitCount,
				requiredSeeds,
				forbiddenLines,
			)

			const { object } = await generateObject({
				model,
				schema: vocabOutSchema,
				system,
				prompt,
			})

			let acceptedThisChunk = 0
			let duplicateSkipped = 0
			let emptySkipped = 0
			let badMultiwordSkipped = 0

			for (const candidate of object.units) {
				if (await isIngestionJobCancelled(jobId)) return

				const text = normalizeCurriculumText(candidate.text)
				if (!text) {
					emptySkipped++
					continue
				}
				const rejectReason = rejectReasonForUnit({ text, type: candidate.type })
				if (rejectReason) {
					badMultiwordSkipped++
					rejectedBadMultiword++
					continue
				}

				const nextRank = allUnits.length + 1
				const unit: VocabUnit = {
					...candidate,
					text,
					lang: language.code,
					rank: nextRank,
				}
				const key = curriculumUnitKey(unit)
				if (acceptedKeys.has(key)) {
					duplicateSkipped++
					continue
				}

				const id = await upsertUnit(unit)
				keptIds.push(id)
				allUnits.push(unit)
				acceptedKeys.add(key)
				missingRequired.delete(text)
				acceptedThisChunk++
			}

			await appendJobLog(
				jobId,
				"out",
				`Chunk ${chunk}/${maxChunks}: accepted ${acceptedThisChunk}/${object.units.length} candidate unit(s); skipped ${duplicateSkipped} duplicate(s), ${emptySkipped} empty item(s), ${badMultiwordSkipped} sentence-like multi-word item(s). Total accepted: ${allUnits.length}/${unitCount} (minimum ${minAcceptedCount}). Required seeds remaining: ${missingRequired.size}.`,
			)
			await updateIngestionProgress(jobId, {
				processedItems: Math.min(allUnits.length, unitCount),
			})
		}

		if (await isIngestionJobCancelled(jobId)) return

		if (allUnits.length < minAcceptedCount || missingRequired.size > 0) {
			throw new Error(
				`Accepted ${allUnits.length}/${unitCount} unique units after ${maxChunks} chunk(s), below minimum ${minAcceptedCount}; required seeds still missing: ${[...missingRequired].slice(0, 20).join(", ") || "none"}`,
			)
		}

		await appendJobLog(
			jobId,
			"out",
			`Candidate generation complete — accepted ${allUnits.length} unique unit(s); pruning stale AI curriculum rows…`,
		)

		const del = await prisma.word.deleteMany({
			where: {
				languageId,
				curriculumSource: "AI_CURRICULUM",
				id: { notIn: keptIds },
			},
		})
		await appendJobLog(
			jobId,
			"out",
			`Removed ${del.count} prior AI curriculum word row(s) not present in this run.`,
		)

		await resolveWordOrder(languageId)

		const prev = await snapshotJobMetadata(jobId)
		await prisma.ingestionJob.updateMany({
			where: { id: jobId, status: "RUNNING" },
			data: {
				status: "COMPLETED",
				processedItems: allUnits.length,
				totalItems: allUnits.length,
				completedAt: new Date(),
				metadata: {
					...prev,
					unitsUpserted: allUnits.length,
					aiCurriculumDeletedOrphans: del.count,
					rejectedSentenceLikeMultiwordUnits: rejectedBadMultiword,
				} as Prisma.InputJsonValue,
			},
		})

		await appendJobLog(
			jobId,
			"out",
			"Vocabulary units complete. Add cloze sentences (future job) then run cloze-quality if needed.",
		)
	} catch (err) {
		console.error("[vocab-units-llm] Fatal error:", err)
		if (await isIngestionJobCancelled(jobId)) return
		await appendJobLog(jobId, "err", String(err))
		const snap = await prisma.ingestionJob.findUnique({
			where: { id: jobId },
			select: { metadata: true, processedItems: true },
		})
		const prevMeta = asMetaRecord(snap?.metadata)
		await prisma.ingestionJob.update({
			where: { id: jobId },
			data: {
				status: "FAILED",
				completedAt: new Date(),
				metadata: {
					...prevMeta,
					error: err instanceof Error ? err.message : String(err),
				} as Prisma.InputJsonValue,
			},
		})
		throw err
	}
}
