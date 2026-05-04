import type { PartOfSpeech, Prisma } from "@nwords/db";
import { prisma } from "@nwords/db";
import { generateObject } from "ai";
import type PgBoss from "pg-boss";
import { z } from "zod";
import { createModel } from "../lib/ai";
import { getAiConfig } from "../lib/app-settings";
import { COMMON_CURRICULUM_FREQUENCY_TAG, pgJsonArrayContainsScalar } from "../lib/common-curriculum-tags";
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel";
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs";
import { updateIngestionProgress } from "../lib/job-progress";
import { normalizeCommonLemma } from "../lib/language-common-lemmas";
import { heuristicMarksUntestable } from "../lib/word-gloss-heuristics";

export interface WordsGlossCleanupJobData {
  jobId: string;
  languageId: string;
}

const TX_CHUNK = 150;

const glossSenseOutSchema = z.object({
  pos: z.string(),
  gloss: z.string().nullable(),
  testable: z.boolean(),
});

const glossCleanupOutSchema = z.object({
  senses: z.array(glossSenseOutSchema),
});

function groupingKeyLemma(lemma: string): string {
  return normalizeCommonLemma(lemma).toLowerCase();
}

function glossCleanupConcurrency(): number {
  const raw = Number(process.env.WORDS_GLOSS_CLEANUP_LLM_CONCURRENCY);
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
      await fn(items[i]!);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, Math.max(1, items.length)));
  await Promise.all(Array.from({ length: workers }, () => runWorker()));
}

function optionalSurfaceFromCurriculumUnit(curriculumUnit: unknown): string | undefined {
  if (!curriculumUnit || typeof curriculumUnit !== "object") return undefined;
  const u = curriculumUnit as Record<string, unknown>;
  if (typeof u.text === "string" && u.text.trim()) return u.text.trim();
  const form = u.form;
  if (form && typeof form === "object") {
    const f = form as Record<string, unknown>;
    for (const k of ["surface", "word", "text"]) {
      const v = f[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

function validateSenseOrderOutput(entryCount: number, senses: z.infer<typeof glossSenseOutSchema>[]): boolean {
  return senses.length === entryCount && entryCount >= 0;
}

/** Bind model output to DB ids by index — avoids LLMs corrupting UUIDs in structured output. */
function zipSensesToEntryIds(
  entries: ReadonlyArray<{ id: string }>,
  senses: z.infer<typeof glossSenseOutSchema>[],
): Array<z.infer<typeof glossSenseOutSchema> & { id: string }> {
  return senses.map((sense, index) => ({
    id: entries[index]!.id,
    ...sense,
  }));
}

function glossCleanupMaxAttempts(): number {
  const raw = Number(process.env.WORDS_GLOSS_CLEANUP_LLM_MAX_ATTEMPTS);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
  return Math.max(2, Math.min(12, n));
}

const WORDS_GLOSS_SYSTEM = `You are cleaning and normalizing vocabulary data for a language learning app.

Your job is to:

keep only useful, modern, spoken-language meanings
remove dictionary metadata and rare senses
produce a short, clean gloss for each remaining entry

The goal is to REMOVE entries that are not
- useful in everyday conversation.
- among the first 2000 words that the user should learn

INPUT FORMAT

You will receive multiple entries for the SAME lemma, including:

different inflections (tenses, forms)
different parts of speech
multiple definitions (often noisy)

TASK

For each entry:

1. REMOVE BAD ENTRIES

Set "testable": false if ANY of the following:

definition contains:
"inflection of"
"plural of"
"comparative of"
"superlative of"
"predicative"
definition is grammatical metadata instead of meaning
definition is overly long or unclear
word is archaic, literary, or rare
POS is PROPER_NOUN
entry is not useful in everyday conversation
entry duplicates a better entry with same meaning

2. SELECT ONLY COMMON SENSES

Across all entries for the lemma:

keep ONLY the most common meaning(s) used in modern spoken language
usually 1 meaning, sometimes 2 if clearly distinct and common
discard niche, technical, or rare meanings

3. HANDLE INFLECTIONS (CRITICAL)

You will see multiple forms (tenses, plural, definite, etc.)

identify the base meaning shared across forms
assign the SAME gloss to all valid forms
mark only the most useful forms as "testable": true

Keep testable:

very common forms used in speech

Set "testable": false:

rare forms
redundant inflections
overly specific grammatical variants

4. FIX PART OF SPEECH (informational only)

Correct POS in your output if clearly wrong for reporting consistency.
Note: downstream storage may ignore POS changes.

5. GENERATE GLOSS

Create a gloss with these rules:

1–3 words max
lowercase
no punctuation except parentheses if needed
no "to" prefix
no explanations

GOOD:

"speed"
"no/none"
"look (appear)"

BAD:

"to move quickly through space"
"a concept relating to motion"

OUTPUT

Return JSON with a "senses" array.

CRITICAL — ORDER AND LENGTH:

- "senses" MUST have EXACTLY the same number of objects as "entries", IN THE SAME ORDER.
- senses[0] is for entries[0], senses[1] for entries[1], etc. Never reorder, merge, skip, or insert rows.
- Do NOT output entry ids; binding is by position only.

Each sense object fields: pos (string), gloss (short string or null), testable (boolean).
`;

function buildLemmaPayload(
  displayLemma: string,
  entries: Array<{
    id: string;
    pos: PartOfSpeech;
    definitions: unknown;
    surface?: string;
  }>,
): Record<string, unknown> {
  return {
    lemma: displayLemma,
    entries: entries.map((e) => ({
      id: e.id,
      pos: e.pos,
      definitions: Array.isArray(e.definitions) ? e.definitions : [],
      ...(e.surface ? { surface: e.surface } : {}),
    })),
  };
}

async function generateSensesForLemma(
  model: ReturnType<typeof createModel>,
  displayLemma: string,
  entries: Array<{
    id: string;
    pos: PartOfSpeech;
    definitions: unknown;
    surface?: string;
  }>,
): Promise<Array<z.infer<typeof glossSenseOutSchema> & { id: string }>> {
  const payload = buildLemmaPayload(displayLemma, entries);
  const n = entries.length;
  const promptBase = `Lemma batch JSON:\n${JSON.stringify(payload, null, 2)}\n\nRespond with JSON {"senses":[...]} where senses has exactly ${n} objects in the SAME ORDER as entries (position i ↔ entries[i]).`;

  const maxAttempts = glossCleanupMaxAttempts();
  let lastSenseCount = -1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const retryHint =
      attempt === 0
        ? ""
        : attempt === 1
          ? `\n\nREMINDER: senses.length must be exactly ${n} (currently entries length). Same order as entries — no reordering.`
          : `\n\nCRITICAL RETRY ${attempt + 1}/${maxAttempts}: Output exactly ${n} sense objects. Index alignment only (no ids). senses[k] corresponds to entries[k].`;

    const prompt = `${promptBase}${retryHint}`;

    const { object } = await generateObject({
      model,
      schema: glossCleanupOutSchema,
      system: WORDS_GLOSS_SYSTEM,
      prompt,
    });

    lastSenseCount = object.senses.length;
    if (validateSenseOrderOutput(n, object.senses)) {
      return zipSensesToEntryIds(entries, object.senses);
    }
  }

  throw new Error(
    `Invalid senses output for lemma "${displayLemma}" (expected ${n} senses in entry order, got ${lastSenseCount})`,
  );
}

export async function processWordsGlossCleanupJob(job: PgBoss.Job<WordsGlossCleanupJobData>) {
  const { jobId, languageId } = job.data;

  const started = await tryMarkIngestionJobRunning(jobId);
  if (!started) {
    const row = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    console.warn(`[words-gloss-cleanup] skipped job ${jobId}: could not claim (status=${row?.status ?? "missing"})`);
    return;
  }

  let heuristicMarked = 0;
  let lemmaGroupsProcessed = 0;
  let llmFailures = 0;

  try {
    const language = await prisma.language.findUnique({ where: { id: languageId } });
    if (!language) throw new Error(`Language ${languageId} not found`);

    const aiConfig = await getAiConfig();
    if (!aiConfig) {
      throw new Error("AI is not configured. Set provider, model, and API key in admin settings.");
    }
    const model = createModel(aiConfig);

    await appendJobLog(jobId, "out", `Words gloss cleanup: ${language.name} — loading curriculum rows…`);

    const commonFreqContain = pgJsonArrayContainsScalar(COMMON_CURRICULUM_FREQUENCY_TAG);

    const rows = (await prisma.$queryRawUnsafe(
      `SELECT w.id, w.lemma, w.pos::text AS pos, w.definitions, w."curriculumUnit", w."isTestable"
			FROM word w
			WHERE w."languageId" = $1::uuid
			AND w.rank > 0
			AND w."isAbbreviation" = false
			AND w."isOffensive" = false
			AND (
				w."curriculumSource" IN ('COMMON', 'HERMIT_DAVE')
				OR (
					w."curriculumSource" = 'KAIKKI'
					AND w."curriculumUnit" IS NOT NULL
					AND COALESCE(w."curriculumUnit"::jsonb->'tags', '[]'::jsonb) @> ${commonFreqContain}
				)
			)
			ORDER BY w."effectiveRank" ASC, w.rank ASC`,
      languageId,
    )) as Array<{
      id: string;
      lemma: string;
      pos: string;
      definitions: unknown;
      curriculumUnit: unknown;
      isTestable: boolean;
    }>;

    type Prepared = (typeof rows)[number] & {
      posEnum: PartOfSpeech;
      heuristicUntestable: boolean;
    };

    const prepared: Prepared[] = rows.map((r) => {
      const posEnum = r.pos as PartOfSpeech;
      return {
        ...r,
        posEnum,
        heuristicUntestable: heuristicMarksUntestable(posEnum, r.definitions),
      };
    });

    const heuristicIds = prepared.filter((p) => p.heuristicUntestable).map((p) => p.id);
    heuristicMarked = heuristicIds.length;

    for (let i = 0; i < heuristicIds.length; i += TX_CHUNK) {
      if (await isIngestionJobCancelled(jobId)) return;
      const slice = heuristicIds.slice(i, i + TX_CHUNK);
      await prisma.word.updateMany({
        where: { id: { in: slice }, languageId },
        data: { isTestable: false },
      });
    }

    await appendJobLog(
      jobId,
      "out",
      `Phase 1: ${rows.length.toLocaleString()} row(s); heuristic marked ${heuristicMarked.toLocaleString()} untestable.`,
    );

    const llmEligible = prepared.filter((p) => !p.heuristicUntestable && p.isTestable);
    const groups = new Map<string, Prepared[]>();
    for (const p of llmEligible) {
      const k = groupingKeyLemma(p.lemma);
      const list = groups.get(k) ?? [];
      list.push(p);
      groups.set(k, list);
    }

    const lemmaJobs = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    const skippedFromLlm = rows.length - llmEligible.length;
    await updateIngestionProgress(jobId, {
      totalItems: rows.length,
      processedItems: skippedFromLlm,
      errorCount: 0,
    });

    const concurrency = glossCleanupConcurrency();
    await appendJobLog(
      jobId,
      "out",
      `Phase 2: ${lemmaJobs.length.toLocaleString()} lemma group(s), ${llmEligible.length.toLocaleString()} LLM-eligible row(s); concurrency ${concurrency}.`,
    );

    const processLemmaGroup = async ([_key, groupRows]: [string, Prepared[]]) => {
      if (await isIngestionJobCancelled(jobId)) return;
      const sorted = [...groupRows].sort((a, b) => a.id.localeCompare(b.id));
      const displayLemma = sorted[0]?.lemma ?? "";
      const entries = sorted.map((r) => ({
        id: r.id,
        pos: r.posEnum,
        definitions: r.definitions,
        surface: optionalSurfaceFromCurriculumUnit(r.curriculumUnit),
      }));

      try {
        const senses = await generateSensesForLemma(model, displayLemma, entries);
        const updates = senses.map((s) => {
          const gloss = s.gloss !== null && s.gloss.trim().length > 0 ? s.gloss.trim() : null;
          return prisma.word.update({
            where: { id: s.id },
            data: {
              gloss,
              isTestable: s.testable,
            },
          });
        });
        await prisma.$transaction(updates);
        lemmaGroupsProcessed++;
        await updateIngestionProgress(jobId, {
          processedDelta: entries.length,
        });
      } catch (err) {
        llmFailures++;
        await appendJobLog(
          jobId,
          "err",
          `Lemma "${displayLemma}": ${err instanceof Error ? err.message : String(err)}`,
        );
        await updateIngestionProgress(jobId, {
          errorDelta: 1,
          processedDelta: entries.length,
        });
      }
    };

    await runPool(lemmaJobs, concurrency, processLemmaGroup, () => isIngestionJobCancelled(jobId));

    if (await isIngestionJobCancelled(jobId)) return;

    const metaPrev = await snapshotJobMetadata(jobId);

    await prisma.ingestionJob.updateMany({
      where: { id: jobId, status: "RUNNING" },
      data: {
        status: "COMPLETED",
        processedItems: rows.length,
        totalItems: rows.length,
        completedAt: new Date(),
        metadata: {
          ...metaPrev,
          wordsGlossCleanup: {
            rowsScoped: rows.length,
            heuristicMarkedUntestable: heuristicMarked,
            llmEligibleRows: llmEligible.length,
            lemmaGroupsProcessed,
            llmFailures,
          },
        } as Prisma.InputJsonValue,
      },
    });

    await appendJobLog(
      jobId,
      "out",
      `Words gloss cleanup complete — ${lemmaGroupsProcessed}/${lemmaJobs.length} lemma group(s) OK; ${llmFailures} failure(s); heuristic ${heuristicMarked.toLocaleString()} row(s).`,
    );
  } catch (err) {
    console.error("[words-gloss-cleanup] Fatal error:", err);
    if (await isIngestionJobCancelled(jobId)) return;
    await appendJobLog(jobId, "err", String(err));
    const snap = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      select: { metadata: true },
    });
    const meta = snap?.metadata;
    const prevMeta =
      meta !== null && typeof meta === "object" && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        metadata: {
          ...prevMeta,
          error: err instanceof Error ? err.message : String(err),
          wordsGlossCleanup: {
            heuristicMarkedUntestable: heuristicMarked,
            lemmaGroupsProcessed,
            llmFailures,
          },
        } as Prisma.InputJsonValue,
      },
    });
    throw err;
  }
}
