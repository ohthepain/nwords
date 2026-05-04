import type { Prisma } from "@nwords/db";
import { ClozeUnusableReason, prisma } from "@nwords/db";
import { type LanguageModel, Output, generateText } from "ai";
import type PgBoss from "pg-boss";
import { z } from "zod";
import { createModel } from "../lib/ai";
import { getAiConfig } from "../lib/app-settings";
import { COMMON_CURRICULUM_FREQUENCY_TAG, pgJsonArrayContainsScalar } from "../lib/common-curriculum-tags";
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel";
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs";
import { updateIngestionProgress } from "../lib/job-progress";

export interface ClozeGenerationJobData {
  jobId: string;
  languageId: string;
  unitsLimit?: number;
  candidatesPerUnit?: number;
  selectedPerUnit?: number;
  resetExisting?: boolean;
}

const DEFAULT_CANDIDATES_PER_UNIT = 10;
const DEFAULT_SELECTED_PER_UNIT = 5;
const CLOZE_PROGRESS_METADATA_INTERVAL = 10;

/** After the first call, retry this many times when: (1) parsed empty `candidates` with no rejection, or (2) only `NOT_FEASIBLE_SURFACE_FORM` rejection (often model confusion, e.g. common words). Other rejection codes return immediately. */
const CLOZE_EMPTY_CANDIDATES_MAX_RETRIES = 5;
const CLOZE_EMPTY_CANDIDATES_RETRY_BASE_MS = 1500;

/** Full primary generation attempts: first try plus further rounds when the validator asks to retry. */
const CLOZE_GENERATION_MAX_ROUNDS = 3;

const CLOZE_DETAIL_MAX_LEN = 4000;

const difficultySchema = z.enum(["easy", "medium", "hard"]);

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
});

const clozeUnitRejectionSchema = z.object({
  code: z.nativeEnum(ClozeUnusableReason),
  explanation: z.string().min(1),
});

const clozeGenerationSchema = z.object({
  candidates: z.array(clozeCandidateSchema),
  /** Required key for OpenAI strict `response_format`; use null when returning candidates. */
  unitRejection: clozeUnitRejectionSchema.nullable(),
});

const clozeValidatorVerdictSchema = z.enum(["RETRY_GENERATION", "FINALIZE_NOT_TESTABLE"]);

const clozeValidatorSchema = z.object({
  verdict: clozeValidatorVerdictSchema,
  explanation: z.string().min(1),
  /** Required key for strict JSON schema; use null when verdict is RETRY_GENERATION. */
  reasonCode: z.nativeEnum(ClozeUnusableReason).nullable(),
});

type ClozeCandidate = z.infer<typeof clozeCandidateSchema>;
type ClozeGenerationModelOutput = z.infer<typeof clozeGenerationSchema>;
export type ClozeUnitRejection = z.infer<typeof clozeUnitRejectionSchema>;
export type ClozeValidatorOutput = z.infer<typeof clozeValidatorSchema>;

/** If the model returns both rejection and candidates, treat as mistake and ignore rejection. */
function normalizePrimaryGenerationOutput(output: ClozeGenerationModelOutput): {
  candidates: ClozeCandidate[];
  unitRejection: ClozeUnitRejection | null;
} {
  const candidates = output.candidates;
  const raw = output.unitRejection;
  if (raw && candidates.length > 0) {
    return { candidates, unitRejection: null };
  }
  if (raw && candidates.length === 0) {
    return { candidates, unitRejection: raw };
  }
  return { candidates, unitRejection: null };
}

function clozeGenerationLlmConcurrency(): number {
  const raw = Number(process.env.CLOZE_GENERATION_LLM_CONCURRENCY);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
  return Math.max(1, Math.min(12, n));
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  shouldStop: () => Promise<boolean>,
): Promise<void> {
  let next = 0;
  const runWorker = async () => {
    for (;;) {
      if (await shouldStop()) return;
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, Math.max(1, items.length)));
  await Promise.all(Array.from({ length: workers }, () => runWorker()));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstGloss(definitions: unknown): string {
  if (!Array.isArray(definitions)) return "";
  const first = definitions.find((d): d is string => typeof d === "string" && d.trim().length > 0);
  return first?.trim() ?? "";
}

function normalizeText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Models often wrap the target in fake Markdown bold (__word__). Strip before blank normalization. */
function stripMarkdownBoldUnderscores(value: string): string {
  return value.replace(/__([\p{L}\p{N}]+)__/gu, "$1");
}

function normalizeBlank(value: string): string {
  const stripped = stripMarkdownBoldUnderscores(normalizeText(value));
  return stripped.replace(/_{1,}/g, "____");
}

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

function hasBlank(text: string): boolean {
  return text.includes("____");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalizeEllipsis(value: string): string {
  return value.replace(/…/g, "...");
}

function splitUnitParts(value: string): string[] {
  if (!/(?:\.{3}|…)/.test(value)) return [];
  return canonicalizeEllipsis(value).split("...").map(normalizeText).filter(Boolean);
}

function findExactPartRange(sentence: string, part: string, startIndex: number): { start: number; end: number } | null {
  const exact = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(part)})(?=$|[^\\p{L}\\p{N}])`, "giu");
  exact.lastIndex = startIndex;
  const match = exact.exec(sentence);
  if (!match) return null;
  const prefix = match[1] ?? "";
  const matchedPart = match[2] ?? "";
  const start = match.index + prefix.length;
  return { start, end: start + matchedPart.length };
}

function splitPartRanges(sentence: string, parts: string[]): Array<{ start: number; end: number }> | null {
  const ranges: Array<{ start: number; end: number }> = [];
  let nextStart = 0;
  for (const part of parts) {
    const range = findExactPartRange(sentence, part, nextStart);
    if (!range) return null;
    ranges.push(range);
    nextStart = range.end;
  }
  return ranges;
}

function clozeFromRanges(sentence: string, ranges: Array<{ start: number; end: number }>): string {
  let cloze = sentence;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    cloze = `${cloze.slice(0, range.start)}____${cloze.slice(range.end)}`;
  }
  return normalizeBlank(cloze);
}

function fallbackClozeFromAnswer(sentence: string, answer: string): string | null {
  const normalizedAnswer = normalizeText(answer);
  if (!normalizedAnswer || normalizedAnswer.includes("...")) return null;

  const exact = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(normalizedAnswer)})(?=$|[^\\p{L}\\p{N}])`, "iu");
  if (!exact.test(sentence)) return null;
  return sentence.replace(exact, (_match, prefix: string) => `${prefix}____`);
}

function normalizedAnswerKey(value: string): string {
  return canonicalizeEllipsis(normalizeText(value)).toLocaleLowerCase();
}

function targetAtEdge(candidate: ClozeCandidate): boolean {
  const answer = candidate.answer.trim().toLocaleLowerCase();
  const runs = candidate.sentence.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (runs.length === 0) return false;
  const first = runs[0]?.toLocaleLowerCase();
  const last = runs[runs.length - 1]?.toLocaleLowerCase();
  return first === answer || last === answer;
}

export function normalizeCandidate(candidate: ClozeCandidate, targetText: string): ClozeCandidate | null {
  let sentence = normalizeBlank(candidate.sentence);
  let cloze = normalizeBlank(candidate.cloze);
  const answer = normalizeText(candidate.answer);
  const target = normalizeText(targetText);
  const splitParts = splitUnitParts(target);

  if (normalizedAnswerKey(answer) !== normalizedAnswerKey(target)) return null;

  if (splitParts.length >= 2) {
    if (hasBlank(sentence)) return null;
    const ranges = splitPartRanges(sentence, splitParts);
    if (!ranges) return null;
    cloze = clozeFromRanges(sentence, ranges);
    const n = wordCount(sentence);
    if (n < 2 || n > 24) return null;
    return {
      ...candidate,
      sentence,
      cloze,
      answer: target,
      alternatives: [],
      tags: candidate.tags.map(normalizeText).filter(Boolean),
      selectionReason: normalizeText(candidate.selectionReason),
    };
  }

  if (hasBlank(sentence) && !hasBlank(cloze)) {
    cloze = sentence;
    sentence = normalizeText(sentence.replace(/____/g, answer));
  }

  if (hasBlank(sentence)) {
    sentence = normalizeText(sentence.replace(/____/g, answer));
  }

  const exactCloze = fallbackClozeFromAnswer(sentence, answer);
  if (!exactCloze) return null;
  cloze = exactCloze;
  if (!hasBlank(cloze)) return null;
  if (hasBlank(sentence)) return null;
  const n = wordCount(sentence);
  if (n < 2 || n > 24) return null;

  return {
    ...candidate,
    sentence,
    cloze,
    answer,
    alternatives: [],
    tags: candidate.tags.map(normalizeText).filter(Boolean),
    selectionReason: normalizeText(candidate.selectionReason),
  };
}

function candidateScore(candidate: ClozeCandidate): number {
  const length = wordCount(candidate.sentence);
  const lengthPenalty = length < 5 ? 8 : length > 12 ? Math.min(12, length - 12) : 0;
  const edgePenalty = targetAtEdge(candidate) ? 7 : 0;
  return (
    candidate.naturalness * 10 +
    candidate.usefulness * 9 +
    candidate.modernness * 5 +
    candidate.fun * 2 -
    candidate.risk * 8 -
    lengthPenalty -
    edgePenalty
  );
}

function normalizeCandidates(candidates: ClozeCandidate[], targetText: string): ClozeCandidate[] {
  return candidates
    .map((candidate) => normalizeCandidate(candidate, targetText))
    .filter((candidate): candidate is ClozeCandidate => candidate !== null);
}

function selectBestClozes(usable: ClozeCandidate[], selectedPerUnit: number): ClozeCandidate[] {
  const byDifficulty = {
    easy: usable.filter((c) => c.difficulty === "easy").sort((a, b) => candidateScore(b) - candidateScore(a)),
    medium: usable.filter((c) => c.difficulty === "medium").sort((a, b) => candidateScore(b) - candidateScore(a)),
    hard: usable.filter((c) => c.difficulty === "hard").sort((a, b) => candidateScore(b) - candidateScore(a)),
  };

  const picked: ClozeCandidate[] = [];
  const take = (difficulty: keyof typeof byDifficulty, count: number) => {
    for (const candidate of byDifficulty[difficulty]) {
      if (picked.length >= selectedPerUnit) return;
      if (picked.some((p) => p.cloze === candidate.cloze || p.sentence === candidate.sentence)) continue;
      picked.push(candidate);
      if (picked.filter((p) => p.difficulty === difficulty).length >= count) return;
    }
  };

  take("easy", 2);
  take("medium", 2);
  take("hard", 1);

  if (picked.length < selectedPerUnit) {
    for (const candidate of [...usable].sort((a, b) => candidateScore(b) - candidateScore(a))) {
      if (picked.length >= selectedPerUnit) break;
      if (picked.some((p) => p.cloze === candidate.cloze || p.sentence === candidate.sentence)) continue;
      picked.push(candidate);
    }
  }

  const order = { easy: 0, medium: 1, hard: 2 } satisfies Record<ClozeCandidate["difficulty"], number>;
  return picked
    .slice(0, selectedPerUnit)
    .sort((a, b) => order[a.difficulty] - order[b.difficulty] || candidateScore(b) - candidateScore(a));
}

function countAnswerMatchesButMissingSurfaceForm(candidates: ClozeCandidate[], targetText: string): number {
  const target = normalizeText(targetText);
  if (!target || splitUnitParts(target).length >= 2) return 0;
  let n = 0;
  for (const c of candidates) {
    if (normalizedAnswerKey(c.answer) !== normalizedAnswerKey(target)) continue;
    const sentence = normalizeBlank(c.sentence);
    if (fallbackClozeFromAnswer(sentence, normalizeText(c.answer)) === null) n++;
  }
  return n;
}

function summarizeRejectedCandidates(
  candidates: ClozeCandidate[],
  usableCount: number,
  targetLemma: string,
): string {
  return JSON.stringify({
    returned: candidates.length,
    usable: usableCount,
    rowsAnswerOkButSentenceLacksExactSurface:
      countAnswerMatchesButMissingSurfaceForm(candidates, targetLemma),
    sample: candidates.slice(0, 3).map((candidate) => ({
      sentence: candidate.sentence,
      cloze: candidate.cloze,
      answer: candidate.answer,
      difficulty: candidate.difficulty,
      words: wordCount(candidate.sentence),
    })),
  });
}

function buildUnitJson(word: {
  lemma: string;
  pos: string;
  rank: number;
  definitions: Prisma.JsonValue;
  curriculumUnit: Prisma.JsonValue | null;
}) {
  const unit = asRecord(word.curriculumUnit);
  return {
    text: word.lemma,
    type: typeof unit.unitType === "string" ? unit.unitType : "WORD",
    pos: word.pos,
    form: asRecord(unit.form),
    gloss: firstGloss(word.definitions),
    tags: Array.isArray(unit.tags) ? unit.tags.filter((x): x is string => typeof x === "string") : [],
    rank: word.rank,
  };
}

function buildSystemPrompt(languageName: string): string {
  return `You are generating cloze sentences for a language learning app.

Generate sentence candidates for modern everyday spoken ${languageName}.

Each request is one curriculum row: INPUT UNIT JSON.text is the exact surface form the product chose for that row (spelling, tense, voice, agreement — already decided). You do not pick or invent a different inflection; other forms are separate curriculum entries the learner meets on their own schedule.

Goals:
- Prefer high-frequency conversational sentence shapes.
- Avoid literary, formal, archaic, translated, or textbook-sounding phrasing.
- Sentences should be realistic, natural, and useful for testing.
- Add light humour or personality when it still sounds natural.
- Each sentence should introduce only one new concept; surrounding words should be common.

Rules:
- You will be asked for up to N candidate(s). Return ONLY rows that fully satisfy every rule here — never pad with invalid or inconsistent clozes. Fewer valid rows (including none) is better than rows where the sentence uses a different surface form than INPUT UNIT JSON.text.
- Each candidate must use these fields exactly:
  - sentence: the full sentence with the answer visible and no blanks — never "____", underscores-as-blank, or Markdown emphasis here; put the blank only in cloze.
  - cloze: the same sentence with only the answer replaced by "____".
  - answer: the exact text removed from cloze (must equal INPUT UNIT JSON.text).
- alternatives: always return [].
- Most sentences should be 5-12 words. For very common function words or pronouns, 2-4 words is acceptable when the cloze is still unambiguous.
- When you return more than one candidate, vary questions, statements, and multi-sentence shapes when it does not break the exact-surface-form rule.
- Use "____" for blanks in cloze only, never in sentence.
- Do not wrap words in fake Markdown emphasis (e.g. __word__); write plain ${languageName} text only.
- The blank must be unambiguous and must not remove surrounding words.
- The visible sentence must literally contain INPUT UNIT JSON.text as written — not a lemma, synonym, or any other inflection. You are not generating "the verb" in abstract; you are placing this exact token in natural context.
- If you cannot produce natural ${languageName} sentences that contain that exact string as a real word, omit those candidates (or return an empty list) instead of substituting another form and copying the target into "answer".
- WORD (including verbs as surface forms): blank only that exact token in the sentence — never a different person, tense, or voice than INPUT UNIT JSON.text.
- PARTICLE/PREPOSITION: blank the particle or preposition that matches INPUT UNIT JSON.text.
- SPLIT: blank the fixed parts only. For "ser ... ut", sentence may be "Du ser pigg ut.", cloze must be "Du ____ pigg ____.", and answer must be "ser ... ut".
- FIXED_EXPR: blank the full expression given as INPUT UNIT JSON.text.
- NOUN: prefer object position when it fits naturally.

If you cannot produce valid candidates under these rules (exact surface form, natural ${languageName}, appropriate for a general learner — not a personal name, not a stray English/other-language token, not only archaic or offensive material, not broken curriculum JSON), do not invent fake rows. Instead return unitRejection:
- unitRejection.code must be one of: ARCHAIC, SELDOM_USED, INAPPROPRIATE_LANGUAGE, BAD_INPUT (curriculum row is malformed or inconsistent), POS_MISMATCH (INPUT UNIT JSON.pos is clearly wrong for this token in ${languageName} — e.g. an adverb labeled VERB; use only for obvious errors, not borderline grammar), NOT_FEASIBLE_SURFACE_FORM (only if the exact token genuinely cannot appear as a real ${languageName} word in natural prose — not for "hard to think of" or common words like everyday nouns; misuse this and output will be retried), PROPER_NOUN (name / unsuitable as general vocab), INCORRECT_LANGUAGE (target is not ${languageName}), OTHER.
- unitRejection.explanation: one or two short sentences (required; for OTHER be specific).
- When you return unitRejection, candidates must be an empty array [].
- If you return any valid candidates, set unitRejection to null. Never return both a non-null unitRejection and non-empty candidates.

Score every candidate:
- naturalness 0-5
- usefulness 0-5
- modernness 0-5
- fun 0-5
- risk 0-5, where risk means ambiguous, rare, abstract, unnatural, textbooky, over-idiomatic, or target first/last.

Return JSON only.`;
}

function buildPrompt(unitJson: unknown, candidatesPerUnit: number, languageName: string): string {
  return `INPUT UNIT JSON:
${JSON.stringify(unitJson, null, 2)}

Generate up to ${candidatesPerUnit} candidate clozes for this unit. Each returned row must be fully valid.

CRITICAL:
- INPUT UNIT JSON.text is the exact string this curriculum row tests (tense/voice/etc. are already chosen; do not substitute another form).
- The "answer" field must be exactly INPUT UNIT JSON.text.
- The full "sentence" must contain that exact same text as a real token (whole word boundaries), not a related form with the same lemma.
- Example: text "hämtas" requires the substring "hämtas" in the sentence. A sentence with only "hämta" and answer "hämtas" is INVALID — that would be a different curriculum row.
- Return alternatives as [] because only the exact learning unit is accepted.
- Do not generate clozes for another useful word in the sentence.
- If INPUT UNIT JSON.text is "skulle", answer must be "skulle", not a nearby verb like "åka".
- If INPUT UNIT JSON.text is "då", answer must be "då", not a connector like "så".
- If INPUT UNIT JSON.pos is clearly wrong for this surface form in ${languageName} (you are sure the token is not that part of speech in normal use), return candidates: [] and unitRejection with code POS_MISMATCH — not NOT_FEASIBLE_SURFACE_FORM. Do not use POS_MISMATCH when POS could plausibly be argued; only clear curriculum mistakes.
- If you cannot comply otherwise, return candidates: [] and a non-null unitRejection with code + explanation instead of padding invalid rows. Otherwise set unitRejection to null.`;
}

function buildClozeValidatorSystemPrompt(languageName: string): string {
  return `You validate cloze-generation attempts for a ${languageName} learning app.

The generator was asked for sentences where INPUT UNIT JSON.text appears exactly as a token; answers must match that string; cloze uses "____" for the blank.

Your job: decide whether the shortfall (too few usable rows after deterministic validation) is likely a bad model run / fixable inconsistency (RETRY_GENERATION) or the unit is genuinely unsuitable / bad input (FINALIZE_NOT_TESTABLE).

For FINALIZE_NOT_TESTABLE, set reasonCode to one of: ARCHAIC, SELDOM_USED, INAPPROPRIATE_LANGUAGE, BAD_INPUT, POS_MISMATCH, NOT_FEASIBLE_SURFACE_FORM, PROPER_NOUN, INCORRECT_LANGUAGE, OTHER — matching the root cause. explanation must be concise.

For RETRY_GENERATION, set reasonCode to null; explanation should say what looks wrong (e.g. systematic wrong inflection in sentences, obvious flake).

Return JSON only.`;
}

function buildClozeValidatorUserPrompt(parts: {
  unitJson: unknown;
  targetLemma: string;
  candidatesJson: string;
  returned: number;
  usable: number;
  selected: number;
  selectedPerUnit: number;
  candidateSummaryJson: string;
}): string {
  return `INPUT UNIT JSON:
${JSON.stringify(parts.unitJson, null, 2)}

targetLemma (expected answer surface): ${JSON.stringify(parts.targetLemma)}

Counts: returned=${parts.returned}, usableAfterValidation=${parts.usable}, selectedBest=${parts.selected}, requiredSelected=${parts.selectedPerUnit}

Summary: ${parts.candidateSummaryJson}

Raw candidate rows JSON from the generator:
${parts.candidatesJson}

Verdict: RETRY_GENERATION if another generation attempt could reasonably fix this. FINALIZE_NOT_TESTABLE if the unit or input is the real problem.`;
}

async function runClozeValidatorLlm(options: {
  model: LanguageModel;
  languageName: string;
  unitJson: unknown;
  targetLemma: string;
  candidates: ClozeCandidate[];
  usableCount: number;
  selectedCount: number;
  selectedPerUnit: number;
  candidateSummaryJson: string;
}): Promise<ClozeValidatorOutput> {
  const {
    model,
    languageName,
    unitJson,
    targetLemma,
    candidates,
    usableCount,
    selectedCount,
    selectedPerUnit,
    candidateSummaryJson,
  } = options;

  const { output } = await generateText({
    model,
    output: Output.object({ schema: clozeValidatorSchema }),
    system: buildClozeValidatorSystemPrompt(languageName),
    prompt: buildClozeValidatorUserPrompt({
      unitJson,
      targetLemma,
      candidatesJson: JSON.stringify(candidates, null, 2),
      returned: candidates.length,
      usable: usableCount,
      selected: selectedCount,
      selectedPerUnit,
      candidateSummaryJson,
    }),
  });
  return output;
}

async function markWordNonTestableForCloze(
  wordId: string,
  reason: ClozeUnusableReason,
  detail: string,
): Promise<void> {
  const trimmed = detail.trim().slice(0, CLOZE_DETAIL_MAX_LEN);
  await prisma.$transaction([
    prisma.generatedCloze.deleteMany({ where: { wordId } }),
    prisma.word.update({
      where: { id: wordId },
      data: {
        isTestable: false,
        testSentenceIds: [],
        aiSynonyms: [],
        clozeUnusableReason: reason,
        clozeUnusableDetail: trimmed || null,
      },
    }),
  ]);
}

async function generateClozeLlmStructuredOutput(options: {
  model: LanguageModel;
  system: string;
  prompt: string;
  onEmptyCandidatesRetry?: (info: {
    attempt: number;
    finishReason: string;
    cause: "empty_candidates" | "not_feasible_rejection";
  }) => void | Promise<void>;
}) {
  const { model, system, prompt, onEmptyCandidatesRetry } = options;
  let lastResult!: Awaited<ReturnType<typeof generateText>>;
  for (let attempt = 0; attempt <= CLOZE_EMPTY_CANDIDATES_MAX_RETRIES; attempt++) {
    lastResult = await generateText({
      model,
      output: Output.object({ schema: clozeGenerationSchema }),
      system,
      prompt,
    });
    const out = lastResult.output;
    if (out.candidates.length > 0) {
      return lastResult;
    }

    if (out.unitRejection == null) {
      if (attempt < CLOZE_EMPTY_CANDIDATES_MAX_RETRIES) {
        await onEmptyCandidatesRetry?.({
          attempt: attempt + 1,
          finishReason: lastResult.finishReason,
          cause: "empty_candidates",
        });
        await new Promise<void>((resolve) =>
          setTimeout(resolve, CLOZE_EMPTY_CANDIDATES_RETRY_BASE_MS * (attempt + 1)),
        );
      }
      continue;
    }

    if (out.unitRejection.code === ClozeUnusableReason.NOT_FEASIBLE_SURFACE_FORM) {
      if (attempt < CLOZE_EMPTY_CANDIDATES_MAX_RETRIES) {
        await onEmptyCandidatesRetry?.({
          attempt: attempt + 1,
          finishReason: lastResult.finishReason,
          cause: "not_feasible_rejection",
        });
        await new Promise<void>((resolve) =>
          setTimeout(resolve, CLOZE_EMPTY_CANDIDATES_RETRY_BASE_MS * (attempt + 1)),
        );
        continue;
      }
      return lastResult;
    }

    return lastResult;
  }
  return lastResult;
}

async function generatedClozeCountsByWordId(wordIds: string[]): Promise<Map<string, number>> {
  if (wordIds.length === 0) return new Map();
  const rows = await prisma.generatedCloze.groupBy({
    by: ["wordId"],
    where: { wordId: { in: wordIds } },
    _count: true,
  });
  return new Map(rows.map((row) => [row.wordId, row._count]));
}

async function resetClozeMaterial(languageId: string, jobId: string) {
  await appendJobLog(jobId, "out", "Resetting existing cloze material for this language…");
  const [generated, words, sentenceWords, aiSentences] = await prisma.$transaction([
    prisma.generatedCloze.deleteMany({ where: { languageId } }),
    prisma.word.updateMany({
      where: { languageId },
      data: {
        testSentenceIds: [],
        aiSynonyms: [],
        clozeUnusableReason: null,
        clozeUnusableDetail: null,
      },
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
  ]);
  await appendJobLog(
    jobId,
    "out",
    `Reset complete: deleted ${generated.count} generated cloze(s), cleared ${words.count} word row(s), reset ${sentenceWords.count} sentence link score(s), deleted ${aiSentences.count} AI sentence row(s).`,
  );
}

export async function processClozeGenerationJob(job: PgBoss.Job<ClozeGenerationJobData>) {
  const {
    jobId,
    languageId,
    unitsLimit,
    candidatesPerUnit = DEFAULT_CANDIDATES_PER_UNIT,
    selectedPerUnit = DEFAULT_SELECTED_PER_UNIT,
    resetExisting = true,
  } = job.data;

  const started = await tryMarkIngestionJobRunning(jobId);
  if (!started) {
    const row = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    console.warn(`[cloze-generation] skipped job ${jobId}: could not claim (status=${row?.status ?? "missing"})`);
    return;
  }

  try {
    const language = await prisma.language.findUnique({ where: { id: languageId } });
    if (!language) throw new Error(`Language ${languageId} not found`);

    const aiConfig = await getAiConfig();
    if (!aiConfig) {
      throw new Error("AI is not configured. Set provider, model, and API key in admin settings.");
    }
    const model = createModel(aiConfig);

    await appendJobLog(
      jobId,
      "out",
      `Starting cloze generation for ${language.name}: ${candidatesPerUnit} candidate(s), selecting ${selectedPerUnit} per unit…`,
    );

    if (resetExisting) {
      await resetClozeMaterial(languageId, jobId);
    }

    const commonFreqContain = pgJsonArrayContainsScalar(COMMON_CURRICULUM_FREQUENCY_TAG);
    const takeCap = unitsLimit && unitsLimit > 0 ? Math.min(Math.floor(unitsLimit), 100_000) : null;
    const limitSql = takeCap != null ? ` LIMIT ${takeCap}` : "";

    const words = (await prisma.$queryRawUnsafe(
      `SELECT w.id, w.lemma, w.pos, w.rank, w."effectiveRank", w.definitions, w."curriculumUnit"
			FROM word w
			WHERE w."languageId" = $1::uuid
			AND w.rank > 0
			AND w."isAbbreviation" = false
			AND w."isOffensive" = false
			AND (
				w."curriculumSource" IN ('AI_CURRICULUM', 'COMMON', 'HERMIT_DAVE')
				OR (
					w."curriculumSource" = 'KAIKKI'
					AND w."curriculumUnit" IS NOT NULL
					AND COALESCE(w."curriculumUnit"::jsonb->'tags', '[]'::jsonb) @> ${commonFreqContain}
				)
			)
			ORDER BY w."effectiveRank" ASC, w.rank ASC${limitSql}`,
      languageId,
    )) as Array<{
      id: string;
      lemma: string;
      pos: string;
      rank: number;
      effectiveRank: number;
      definitions: unknown;
      curriculumUnit: unknown;
    }>;

    const wordIds = words.map((word) => word.id);
    const existingCounts = resetExisting ? new Map<string, number>() : await generatedClozeCountsByWordId(wordIds);
    const skippedExisting = resetExisting
      ? 0
      : words.filter((word) => (existingCounts.get(word.id) ?? 0) >= selectedPerUnit).length;
    const existingGeneratedClozes = resetExisting
      ? 0
      : words.reduce((sum, word) => {
          const count = existingCounts.get(word.id) ?? 0;
          return count >= selectedPerUnit ? sum + count : sum;
        }, 0);
    const remainingWords = resetExisting
      ? words
      : words.filter((word) => (existingCounts.get(word.id) ?? 0) < selectedPerUnit);

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
    });
    const concurrency = clozeGenerationLlmConcurrency();
    await appendJobLog(
      jobId,
      "out",
      resetExisting
        ? `Found ${words.length} curriculum unit(s) (AI / frequency / common-curriculum Kaikki). Generating with ${concurrency} parallel LLM task(s)…`
        : `Found ${words.length} curriculum unit(s) (AI / frequency / common-curriculum Kaikki). Resuming: ${skippedExisting} complete, ${remainingWords.length} remaining. Generating with ${concurrency} parallel LLM task(s)…`,
    );

    let generatedThisRun = 0;
    let processedThisRun = 0;
    let markedNonTestableThisRun = 0;

    const processWord = async (word: (typeof words)[number]) => {
      if (await isIngestionJobCancelled(jobId)) return;
      let errorThisWord = 0;
      try {
        const unitJson = buildUnitJson({
          lemma: word.lemma,
          pos: word.pos,
          rank: word.rank,
          definitions: word.definitions as Prisma.JsonValue,
          curriculumUnit: (word.curriculumUnit ?? null) as Prisma.JsonValue | null,
        });

        let successOutput: ClozeGenerationModelOutput | null = null;
        let successSelected: ClozeCandidate[] = [];

        wordLoop: for (let round = 0; round < CLOZE_GENERATION_MAX_ROUNDS; round++) {
          const { output: rawOutput } = await generateClozeLlmStructuredOutput({
            model,
            system: buildSystemPrompt(language.name),
            prompt: buildPrompt(unitJson, candidatesPerUnit, language.name),
            onEmptyCandidatesRetry: async ({ attempt, finishReason, cause }) => {
              const msg =
                cause === "not_feasible_rejection"
                  ? `NOT_FEASIBLE_SURFACE_FORM (often model confusion); retry ${attempt}/${CLOZE_EMPTY_CANDIDATES_MAX_RETRIES}…`
                  : `empty LLM candidate list (finish: ${finishReason}), retry ${attempt}/${CLOZE_EMPTY_CANDIDATES_MAX_RETRIES}…`;
              await appendJobLog(jobId, "out", `"${word.lemma} (${word.pos})": ${msg}`);
            },
          });

          if (rawOutput.unitRejection != null && rawOutput.candidates.length > 0) {
            await appendJobLog(
              jobId,
              "out",
              `"${word.lemma} (${word.pos})": LLM returned unitRejection with non-empty candidates — ignoring rejection.`,
            );
          }

          const { candidates, unitRejection } = normalizePrimaryGenerationOutput(rawOutput);

          if (unitRejection != null) {
            errorThisWord = 1;
            const explain = unitRejection.explanation.trim();
            await markWordNonTestableForCloze(word.id, unitRejection.code, explain);
            markedNonTestableThisRun += 1;
            await appendJobLog(
              jobId,
              "out",
              `"${word.lemma} (${word.pos})": unit rejected by generator — ${unitRejection.code}: ${explain}`,
            );
            break wordLoop;
          }

          const usableCandidates = normalizeCandidates(candidates, word.lemma);
          const selected = selectBestClozes(usableCandidates, selectedPerUnit);

          if (selected.length >= selectedPerUnit) {
            successOutput = rawOutput;
            successSelected = selected;
            break wordLoop;
          }

          const isLastRound = round === CLOZE_GENERATION_MAX_ROUNDS - 1;
          const summaryJson = summarizeRejectedCandidates(candidates, usableCandidates.length, word.lemma);
          const validator = await runClozeValidatorLlm({
            model,
            languageName: language.name,
            unitJson,
            targetLemma: word.lemma,
            candidates,
            usableCount: usableCandidates.length,
            selectedCount: selected.length,
            selectedPerUnit,
            candidateSummaryJson: summaryJson,
          });

          if (validator.verdict === "RETRY_GENERATION" && !isLastRound) {
            await appendJobLog(
              jobId,
              "out",
              `"${word.lemma} (${word.pos})": validator → RETRY_GENERATION (round ${round + 1}/${CLOZE_GENERATION_MAX_ROUNDS}): ${validator.explanation.trim()}`,
            );
            continue;
          }

          errorThisWord = 1;
          const exhausted = isLastRound && validator.verdict === "RETRY_GENERATION";
          const reasonCode =
            validator.verdict === "FINALIZE_NOT_TESTABLE"
              ? (validator.reasonCode ?? ClozeUnusableReason.OTHER)
              : ClozeUnusableReason.OTHER;
          const detail = exhausted
            ? `${validator.explanation.trim()} (exhausted ${CLOZE_GENERATION_MAX_ROUNDS} generation round(s))`
            : validator.explanation.trim();
          await markWordNonTestableForCloze(word.id, reasonCode, detail);
          markedNonTestableThisRun += 1;
          await appendJobLog(
            jobId,
            "out",
            `"${word.lemma} (${word.pos})": ${validator.verdict} — ${reasonCode}: ${detail}. Candidate summary: ${summaryJson}`,
          );
          break wordLoop;
        }

        if (successOutput && successSelected.length >= selectedPerUnit) {
          await prisma.$transaction([
            prisma.generatedCloze.deleteMany({ where: { wordId: word.id } }),
            ...successSelected.map((candidate, index) =>
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
                  sourceCandidates: successOutput.candidates as Prisma.InputJsonValue,
                  selectionReason: candidate.selectionReason,
                },
              }),
            ),
            prisma.word.update({
              where: { id: word.id },
              data: {
                isTestable: true,
                aiSynonyms: [],
                clozeUnusableReason: null,
                clozeUnusableDetail: null,
              },
            }),
          ]);

          generatedThisRun += successSelected.length;
          if (word.effectiveRank <= 50 || generatedThisRun % 100 === 0) {
            await appendJobLog(jobId, "out", `"${word.lemma}": stored ${successSelected.length} cloze(s).`);
          }
        }
      } catch (err) {
        errorThisWord = 1;
        await appendJobLog(
          jobId,
          "err",
          `Failed for "${word.lemma}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      processedThisRun += 1;
      const completedWords = skippedExisting + processedThisRun;
      const generatedClozes = existingGeneratedClozes + generatedThisRun;
      const shouldWriteMetadata =
        processedThisRun === remainingWords.length ||
        processedThisRun % CLOZE_PROGRESS_METADATA_INTERVAL === 0 ||
        word.effectiveRank <= 50;
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
                  markedNonTestable: markedNonTestableThisRun,
                  lastWord: word.lemma,
                  remainingWords: Math.max(words.length - completedWords, 0),
                },
              },
            }
          : {}),
      });
    };

    await runPool(remainingWords, concurrency, processWord, () => isIngestionJobCancelled(jobId));
    if (await isIngestionJobCancelled(jobId)) return;

    const finalGeneratedClozes = await prisma.generatedCloze.count({
      where: {
        languageId,
        wordId: { in: wordIds },
      },
    });
    const doneRow = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      select: { processedItems: true, errorCount: true },
    });
    const metadata = await snapshotJobMetadata(jobId);
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
            markedNonTestable: markedNonTestableThisRun,
            remainingWords: 0,
          },
          candidatesPerUnit,
          selectedPerUnit,
        } as Prisma.InputJsonValue,
      },
    });
    await appendJobLog(
      jobId,
      "out",
      `Done: ${doneRow?.processedItems ?? 0} unit(s) processed, ${finalGeneratedClozes} cloze(s) available, ${markedNonTestableThisRun} word(s) marked non-testable, ${doneRow?.errorCount ?? 0} error(s).`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cloze-generation] job ${jobId} failed:`, message);
    await appendJobLog(jobId, "err", message);
    const metadata = await snapshotJobMetadata(jobId);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        metadata: { ...metadata, error: message } as Prisma.InputJsonValue,
      },
    });
  }
}

/** Admin-only: run one primary LLM call (and optional validator) with the same prompts/schemas as batch cloze generation (no DB writes). */
export async function runClozeGenerationPromptPreview(options: {
  model: LanguageModel;
  languageName: string;
  lemma: string;
  pos: string;
  unitType: string;
  gloss: string;
  rank: number;
  tags: string[];
  form: Record<string, unknown> | null;
  candidatesPerUnit: number;
  selectedPerUnit: number;
  /** Extra LLM call when selection falls short and there is no primary unitRejection. */
  runValidator?: boolean;
}): Promise<{
  unitJson: ReturnType<typeof buildUnitJson>;
  systemPrompt: string;
  userPrompt: string;
  rawLlmCandidates: ClozeCandidate[];
  unitRejection: ClozeUnitRejection | null;
  candidatePreviewRows: Array<{ llmRaw: ClozeCandidate; afterValidation: ClozeCandidate | null }>;
  usableCandidates: ClozeCandidate[];
  selectedCandidates: ClozeCandidate[];
  validator: ClozeValidatorOutput | null;
}> {
  const {
    model,
    languageName,
    lemma,
    pos,
    unitType,
    gloss,
    rank,
    tags,
    form,
    candidatesPerUnit,
    selectedPerUnit,
    runValidator = false,
  } = options;

  const trimmedGloss = gloss.trim();
  const definitions = (trimmedGloss ? [trimmedGloss] : []) as unknown as Prisma.JsonValue;
  const curriculumUnit: Prisma.JsonValue = {
    unitType,
    form: (form ?? {}) as Prisma.JsonValue,
    tags,
  };

  const unitJson = buildUnitJson({
    lemma,
    pos,
    rank,
    definitions,
    curriculumUnit,
  });
  const systemPrompt = buildSystemPrompt(languageName);
  const userPrompt = buildPrompt(unitJson, candidatesPerUnit, languageName);

  const { output } = await generateClozeLlmStructuredOutput({
    model,
    system: systemPrompt,
    prompt: userPrompt,
  });

  const { candidates, unitRejection } = normalizePrimaryGenerationOutput(output);

  const candidatePreviewRows = candidates.map((llmRaw: ClozeCandidate) => ({
    llmRaw,
    afterValidation: normalizeCandidate(llmRaw, lemma),
  }));
  const usableCandidates = candidatePreviewRows
    .map((row: { llmRaw: ClozeCandidate; afterValidation: ClozeCandidate | null }) => row.afterValidation)
    .filter((c: ClozeCandidate | null): c is ClozeCandidate => c !== null);
  const selectedCandidates = selectBestClozes(usableCandidates, selectedPerUnit);

  let validator: ClozeValidatorOutput | null = null;
  if (
    runValidator &&
    unitRejection == null &&
    selectedCandidates.length < selectedPerUnit
  ) {
    const summaryJson = summarizeRejectedCandidates(candidates, usableCandidates.length, lemma);
    validator = await runClozeValidatorLlm({
      model,
      languageName,
      unitJson,
      targetLemma: lemma,
      candidates,
      usableCount: usableCandidates.length,
      selectedCount: selectedCandidates.length,
      selectedPerUnit,
      candidateSummaryJson: summaryJson,
    });
  }

  return {
    unitJson,
    systemPrompt,
    userPrompt,
    rawLlmCandidates: candidates,
    unitRejection,
    candidatePreviewRows,
    usableCandidates,
    selectedCandidates,
    validator,
  };
}
