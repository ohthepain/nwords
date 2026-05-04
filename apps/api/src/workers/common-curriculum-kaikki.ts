import { createInterface } from "node:readline";
import type { CurriculumSource, PartOfSpeech, Prisma } from "@nwords/db";
import { prisma } from "@nwords/db";
import { ABBREV_TITLE_LEMMAS, cefrLevelForFrequencyRank } from "@nwords/shared";
import type PgBoss from "pg-boss";
import type { AiCurriculumUnitJson } from "../lib/ai-curriculum-definition";
import { COMMON_CURRICULUM_FREQUENCY_TAG, pgJsonArrayContainsScalar } from "../lib/common-curriculum-tags";
import type { CurriculumFormCandidate } from "../lib/curriculum-form-selection";
import {
  plannedFormRank,
  selectCurriculumFormCandidates,
  selectSpokenColloquialFormCandidates,
} from "../lib/curriculum-form-selection";
import { isIngestionJobCancelled, tryMarkIngestionJobRunning } from "../lib/ingestion-job-cancel";
import { resolveKaikkiDownloadPlan } from "../lib/ingestion-urls";
import { appendJobLog, snapshotJobMetadata } from "../lib/job-logs";
import { updateIngestionProgress } from "../lib/job-progress";
import type { KaikkiEntry } from "../lib/kaikki-entry";
import {
  extractKaikkiGlossDefinitions,
  kaikkiEntryHasOffensiveSense,
  mapKaikkiPos,
  normalizeKaikkiLemma,
} from "../lib/kaikki-entry";
import { resolveVocabLlmSeed } from "../lib/language-common-lemmas";
import { nodeReadableFromWeb } from "../lib/node-streams";
import { resolveWordOrder } from "../lib/resolve-word-order";
import { chainWordsGlossCleanup } from "../lib/words-gloss-pipeline";

/** Same normalization as VOCAB lesson units (avoid importing the LLM worker). */
function normalizeCurriculumLemmaSurface(s: string): string {
  return s.normalize("NFC").trim();
}

const TESTABLE_POS = new Set<PartOfSpeech>(["NOUN", "VERB", "ADJECTIVE", "ADVERB"]);

const MAX_FORMS_PER_WORD = 200;

/** Larger gaps between frequency seeds leave room for inflection-promoted ranks. */
const SPARSE_RANK_STEP = 10_000;

const POS_RANK: Partial<Record<PartOfSpeech, number>> = {
  NOUN: 0,
  VERB: 10,
  ADJECTIVE: 20,
  ADVERB: 30,
  PRONOUN: 40,
  DETERMINER: 41,
  NUMERAL: 42,
  PREPOSITION: 50,
  CONJUNCTION: 51,
  PARTICLE: 52,
  INTERJECTION: 53,
  PROPER_NOUN: 54,
};

function sparseBaseRank(sortOrder: number, pos: PartOfSpeech): number {
  return (sortOrder + 1) * SPARSE_RANK_STEP + (POS_RANK[pos] ?? 90);
}

function posRank(pos: PartOfSpeech): number {
  return POS_RANK[pos] ?? 90;
}

export interface CommonCurriculumKaikkiJobData {
  jobId: string;
  languageId: string;
  /** When set, seed lemmas mirror this completed COMMON_WORDS_TOP row. */
  forceCommonWordsJobId?: string;
  chainPipeline?: boolean;
}

function asMetaRecord(metadata: unknown): Record<string, unknown> {
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    return { ...(metadata as Record<string, unknown>) };
  }
  return {};
}

async function* linesFromUrl(url: string): AsyncGenerator<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Kaikki download failed HTTP ${res.status}: ${url}`);
  }
  const input = nodeReadableFromWeb(res.body);
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

type PendingBase = {
  lemma: string;
  pos: PartOfSpeech;
  sortOrder: number;
  definitions: Prisma.InputJsonValue;
  isAbbreviation: boolean;
  isTestable: boolean;
  forms: Array<{ form: string; tags: Prisma.InputJsonValue }>;
};

function normSeedLemma(s: string): string {
  return normalizeCurriculumLemmaSurface(s).toLocaleLowerCase();
}

export async function processCommonCurriculumKaikkiJob(job: PgBoss.Job<CommonCurriculumKaikkiJobData>) {
  const { jobId, languageId } = job.data;

  const row = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
  const fileMeta = asMetaRecord(row?.metadata);
  const forceCommonWordsJobId =
    typeof job.data.forceCommonWordsJobId === "string"
      ? job.data.forceCommonWordsJobId
      : typeof fileMeta.forceCommonWordsJobId === "string"
        ? fileMeta.forceCommonWordsJobId
        : undefined;

  const started = await tryMarkIngestionJobRunning(jobId);
  if (!started) {
    const r = await prisma.ingestionJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    console.warn(`[common-curriculum-kaikki] skipped job ${jobId}: could not claim (status=${r?.status ?? "missing"})`);
    return;
  }

  let processedLines = 0;
  try {
    const language = await prisma.language.findUnique({ where: { id: languageId } });
    if (!language) throw new Error(`Language ${languageId} not found`);
    const lang = language;

    const seed = await resolveVocabLlmSeed(languageId, forceCommonWordsJobId ? { forceCommonWordsJobId } : undefined);

    const requiredWords = seed.requiredWords;
    if (!requiredWords.length) {
      throw new Error("No common lemmas to expand — edit LanguageCommonLemma or complete COMMON_WORDS_TOP first.");
    }

    const lemmaRows = await prisma.languageCommonLemma.findMany({
      where: { languageId },
      orderBy: { sortOrder: "asc" },
      select: { lemma: true, curriculumSource: true },
    });
    const lemmaWordSourceByNorm = new Map<string, CurriculumSource>();
    for (const r of lemmaRows) {
      const k = normSeedLemma(r.lemma);
      if (!k) continue;
      if (!lemmaWordSourceByNorm.has(k)) lemmaWordSourceByNorm.set(k, r.curriculumSource);
    }

    await appendJobLog(
      jobId,
      "out",
      `Common curriculum (Kaikki): expanding ${requiredWords.length} seed lemma(s) for ${lang.name}…`,
    );

    const lemmaSortOrder = new Map<string, number>();
    const lemmaSet = new Set<string>();
    for (let i = 0; i < requiredWords.length; i++) {
      const n = normSeedLemma(requiredWords[i] ?? "");
      if (!n) continue;
      lemmaSet.add(n);
      if (!lemmaSortOrder.has(n)) lemmaSortOrder.set(n, i);
    }

    const canonicalSeedFlow: string[] = [];
    const seenCanonical = new Set<string>();
    for (const w of requiredWords) {
      const n = normSeedLemma(w);
      if (!n || seenCanonical.has(n)) continue;
      seenCanonical.add(n);
      canonicalSeedFlow.push(n);
    }

    const dictionaryName = (lang.kaikkiDictionaryName ?? lang.name).trim();
    const plan = await resolveKaikkiDownloadPlan(dictionaryName);
    const downloadUrl = plan.downloadUrls[0];
    if (!downloadUrl) {
      throw new Error("resolveKaikkiDownloadPlan returned no URLs");
    }

    await appendJobLog(jobId, "out", `Streaming Kaikki monolith (${dictionaryName})…`);

    const pendingBasesByKey = new Map<string, PendingBase>();
    const lemmaPosMatched = new Map<string, Set<PartOfSpeech>>();
    const matchedSeeds = new Set<string>();

    await updateIngestionProgress(jobId, {
      totalItems: requiredWords.length,
      processedItems: 0,
    });

    for await (const line of linesFromUrl(downloadUrl)) {
      if (await isIngestionJobCancelled(jobId)) return;
      processedLines++;
      if (!line.trim()) continue;

      let entry: KaikkiEntry;
      try {
        entry = JSON.parse(line) as KaikkiEntry;
      } catch {
        continue;
      }

      const lemma = normalizeKaikkiLemma(entry.word);
      if (!lemmaSet.has(lemma)) continue;

      const pos = mapKaikkiPos(entry.pos ?? "");
      if (!pos || kaikkiEntryHasOffensiveSense(entry)) continue;

      const definitions = extractKaikkiGlossDefinitions(entry);
      if (definitions.length === 0) continue;

      const key = `${lemma}\t${pos}`;
      if (pendingBasesByKey.has(key)) continue;

      matchedSeeds.add(lemma);
      let senseSet = lemmaPosMatched.get(lemma);
      if (!senseSet) {
        senseSet = new Set();
        lemmaPosMatched.set(lemma, senseSet);
      }
      senseSet.add(pos);

      const isTitleAbbrev = ABBREV_TITLE_LEMMAS.has(lemma);

      const forms: Array<{ form: string; tags: Prisma.InputJsonValue }> = [];
      const rawForms = entry.forms ?? [];
      for (let fi = 0; fi < rawForms.length && forms.length < MAX_FORMS_PER_WORD; fi++) {
        const rf = rawForms[fi];
        const formSurf = rf?.form?.trim().toLocaleLowerCase();
        if (!formSurf) continue;
        const ftags = [...(rf.tags ?? [])].map((t) => t.toLocaleLowerCase());
        forms.push({ form: formSurf, tags: ftags });
      }

      const sortOrder = lemmaSortOrder.get(lemma) ?? 999999;

      pendingBasesByKey.set(key, {
        lemma,
        pos,
        sortOrder,
        definitions: definitions as Prisma.InputJsonValue,
        isAbbreviation: isTitleAbbrev,
        isTestable: TESTABLE_POS.has(pos) && !isTitleAbbrev,
        forms,
      });

      if (processedLines % 250_000 === 0) {
        await appendJobLog(
          jobId,
          "out",
          `… scanned ${processedLines.toLocaleString()} Kaikki line(s), ${matchedSeeds.size} seed lemmas matched`,
        );
      }
    }

    const pendingBases = [...pendingBasesByKey.values()].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      const pr = posRank(a.pos) - posRank(b.pos);
      if (pr !== 0) return pr;
      return a.lemma.localeCompare(b.lemma);
    });

    const missingLemmas = canonicalSeedFlow.filter((l) => !matchedSeeds.has(l));

    const multiPosLemmas = [...lemmaPosMatched.entries()].filter(([, poses]) => poses.size > 1).map(([lemma]) => lemma);

    await appendJobLog(
      jobId,
      "out",
      `Kaikki pass done — ${processedLines.toLocaleString()} lines, ${pendingBases.length} basesense row(s); missing ${missingLemmas.length} seed(s); ${multiPosLemmas.length} multi-POS lemma(s).`,
    );

    const keptWordIds = new Set<string>();
    const sortKeyByWordId = new Map<string, number>();
    let seq = 0;

    async function persistBase(pb: PendingBase): Promise<{ id: string; sparseRank: number }> {
      const sparseRank = sparseBaseRank(pb.sortOrder, pb.pos);

      const baseCurriculumSource = lemmaWordSourceByNorm.get(pb.lemma) ?? "COMMON";
      const curriculumUnit: AiCurriculumUnitJson = {
        unitType: "WORD",
        tags: [COMMON_CURRICULUM_FREQUENCY_TAG, `seedOrder:${pb.sortOrder}`],
        lang: lang.code,
        seedOrder: pb.sortOrder,
      };

      const upserted = await prisma.word.upsert({
        where: {
          languageId_lemma_pos: { languageId, lemma: pb.lemma, pos: pb.pos },
        },
        create: {
          languageId,
          lemma: pb.lemma,
          pos: pb.pos,
          curriculumSource: baseCurriculumSource,
          curriculumUnit: curriculumUnit as Prisma.InputJsonValue,
          rank: sparseRank,
          effectiveRank: sparseRank,
          definitions: pb.definitions,
          isAbbreviation: pb.isAbbreviation,
          isTestable: pb.isTestable,
          isOffensive: false,
          alternatePos: [],
          testSentenceIds: [],
          aiSynonyms: [],
        },
        update: {
          curriculumSource: baseCurriculumSource,
          curriculumUnit: curriculumUnit as Prisma.InputJsonValue,
          rank: sparseRank,
          effectiveRank: sparseRank,
          definitions: pb.definitions,
          isAbbreviation: pb.isAbbreviation,
          isTestable: pb.isTestable,
          isOffensive: false,
          alternatePos: [],
          cefrLevel: null,
        },
      });

      await prisma.wordForm.deleteMany({ where: { wordId: upserted.id } });
      if (pb.forms.length > 0) {
        await prisma.wordForm.createMany({
          data: pb.forms.map((f) => ({
            languageId,
            wordId: upserted.id,
            form: f.form,
            tags: f.tags as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        });
      }

      return { id: upserted.id, sparseRank };
    }

    async function upsertPromoted(
      form: CurriculumFormCandidate,
      definitions: Prisma.InputJsonValue,
      baseSparseRank: number,
      tagPrefix: readonly string[],
    ): Promise<string> {
      const lemma = normalizeCurriculumLemmaSurface(form.form).toLocaleLowerCase();
      const rank = plannedFormRank(baseSparseRank, form);
      const cefr = cefrLevelForFrequencyRank(rank);
      const curriculumUnit: AiCurriculumUnitJson = {
        unitType: "WORD",
        form: {
          key: form.formKey,
          baseLemma: form.baseLemma,
          tags: form.formTags,
        },
        baseLemma: form.baseLemma,
        formKey: form.formKey,
        formTags: form.formTags,
        formSource: "KAIKKI",
        tags: [...tagPrefix, `form:${form.formKey}`],
        lang: lang.code,
      };

      const promoted = await prisma.word.upsert({
        where: {
          languageId_lemma_pos: { languageId, lemma, pos: form.pos },
        },
        create: {
          languageId,
          lemma,
          pos: form.pos,
          curriculumSource: "KAIKKI",
          curriculumUnit: curriculumUnit as Prisma.InputJsonValue,
          rank,
          effectiveRank: rank,
          definitions,
          isAbbreviation: false,
          isTestable: TESTABLE_POS.has(form.pos),
          isOffensive: false,
          alternatePos: [],
          testSentenceIds: [],
          aiSynonyms: [],
          ...(cefr ? { cefrLevel: cefr } : {}),
        },
        update: {
          curriculumSource: "KAIKKI",
          curriculumUnit: curriculumUnit as Prisma.InputJsonValue,
          rank,
          effectiveRank: rank,
          definitions,
          isAbbreviation: false,
          isTestable: TESTABLE_POS.has(form.pos),
          cefrLevel: cefr ?? null,
        },
      });
      return promoted.id;
    }

    const lemmaToBases = new Map<string, PendingBase[]>();
    for (const pb of pendingBases) {
      const list = lemmaToBases.get(pb.lemma) ?? [];
      list.push(pb);
      lemmaToBases.set(pb.lemma, list);
    }

    let promotedWrites = 0;

    const acceptedBaseLemmaPosKeys = new Set<string>();
    const promotedLemmaPosKeys = new Set<string>();

    for (let si = 0; si < canonicalSeedFlow.length; si++) {
      if (canonicalSeedFlow[si] === undefined) {
        console.error(`[common-curriculum-kaikki] canonicalSeedFlow[${si}] is undefined`);
        continue;
      }
      const lemma = canonicalSeedFlow[si];
      if (await isIngestionJobCancelled(jobId)) return;
      const group = lemmaToBases.get(lemma);
      if (!group?.length) continue;
      group.sort((a, b) => posRank(a.pos) - posRank(b.pos));

      for (const pb of group) {
        const { id: baseId, sparseRank } = await persistBase(pb);

        const baseTagPrefix = [COMMON_CURRICULUM_FREQUENCY_TAG, `seedOrder:${pb.sortOrder}`] as const;

        const baseWordForForms = {
          id: baseId,
          lemma: pb.lemma,
          pos: pb.pos,
          rank: sparseRank,
        };

        const formRowsDb = pb.forms.map((f) => ({
          form: f.form,
          tags: f.tags as Prisma.JsonValue,
        }));
        const slotCandidates = selectCurriculumFormCandidates(baseWordForForms, formRowsDb);

        const excludeSurfaces = new Set<string>();
        for (const c of slotCandidates) excludeSurfaces.add(c.form);

        const spokenCandidates = selectSpokenColloquialFormCandidates(baseWordForForms, formRowsDb, excludeSurfaces);

        acceptedBaseLemmaPosKeys.add(`${pb.lemma}\0${pb.pos}`);

        for (const sc of spokenCandidates) {
          const key = `${normalizeCurriculumLemmaSurface(sc.form).toLocaleLowerCase()}\0${sc.pos}`;
          if (promotedLemmaPosKeys.has(key) || acceptedBaseLemmaPosKeys.has(`${sc.form}\0${sc.pos}`)) continue;
          const pid = await upsertPromoted(sc, pb.definitions, sparseRank, baseTagPrefix);
          promotedLemmaPosKeys.add(key);
          keptWordIds.add(pid);
          sortKeyByWordId.set(pid, seq++);
          promotedWrites++;
        }

        keptWordIds.add(baseId);
        sortKeyByWordId.set(baseId, seq++);

        for (const c of slotCandidates) {
          const key = `${normalizeCurriculumLemmaSurface(c.form).toLocaleLowerCase()}\0${c.pos}`;
          if (promotedLemmaPosKeys.has(key) || acceptedBaseLemmaPosKeys.has(`${c.form}\0${c.pos}`)) continue;
          const pid = await upsertPromoted(c, pb.definitions, sparseRank, baseTagPrefix);
          promotedLemmaPosKeys.add(key);
          keptWordIds.add(pid);
          sortKeyByWordId.set(pid, seq++);
          promotedWrites++;
        }
      }

      await updateIngestionProgress(jobId, {
        processedItems: si + 1,
        totalItems: canonicalSeedFlow.length,
      });
    }

    const missingSet = new Set(missingLemmas);
    for (let si = 0; si < canonicalSeedFlow.length; si++) {
      const lemma = canonicalSeedFlow[si]!;
      if (await isIngestionJobCancelled(jobId)) return;
      if (!missingSet.has(lemma)) continue;
      const seedOrderVal = lemmaSortOrder.get(lemma) ?? si;
      const stubSource = lemmaWordSourceByNorm.get(lemma) ?? "COMMON";
      const sparseRank = sparseBaseRank(seedOrderVal, "NOUN");
      const curriculumUnit: AiCurriculumUnitJson = {
        unitType: "WORD",
        tags: [COMMON_CURRICULUM_FREQUENCY_TAG, `seedOrder:${seedOrderVal}`, "kaikki-missing-seed"],
        lang: lang.code,
        seedOrder: seedOrderVal,
      };

      const upsertedMissing = await prisma.word.upsert({
        where: {
          languageId_lemma_pos: { languageId, lemma, pos: "NOUN" },
        },
        create: {
          languageId,
          lemma,
          pos: "NOUN",
          curriculumSource: stubSource,
          curriculumUnit: curriculumUnit as Prisma.InputJsonValue,
          rank: sparseRank,
          effectiveRank: sparseRank,
          definitions: [] as unknown as Prisma.InputJsonValue,
          isAbbreviation: false,
          isTestable: false,
          isOffensive: false,
          alternatePos: [],
          testSentenceIds: [],
          aiSynonyms: [],
        },
        update: {
          curriculumSource: stubSource,
          curriculumUnit: curriculumUnit as Prisma.InputJsonValue,
          rank: sparseRank,
          effectiveRank: sparseRank,
          isAbbreviation: false,
          isTestable: false,
          isOffensive: false,
          alternatePos: [],
          cefrLevel: null,
        },
      });
      keptWordIds.add(upsertedMissing.id);
      sortKeyByWordId.set(upsertedMissing.id, seq++);
    }

    const keptIdsUnique = [...keptWordIds];

    if (keptIdsUnique.length === 0) {
      throw new Error(
        `COMMON curriculum produced zero units — no Kaikki dictionary rows or stubs for seeds. Missing lemmas (sample): ${missingLemmas.slice(0, 40).join(", ") || "all"}`,
      );
    }

    await appendJobLog(
      jobId,
      "out",
      `Pruning prior ${COMMON_CURRICULUM_FREQUENCY_TAG} curriculum row(s) not in this output…`,
    );

    const containScalar = pgJsonArrayContainsScalar(COMMON_CURRICULUM_FREQUENCY_TAG);
    const delStaleRaw = await prisma.$executeRawUnsafe(
      `DELETE FROM "word" w
			WHERE w."languageId" = $1::uuid
			AND NOT (w.id = ANY($2::uuid[]))
			AND w."curriculumUnit" IS NOT NULL
			AND COALESCE(w."curriculumUnit"::jsonb->'tags', '[]'::jsonb) @> ${containScalar}`,
      languageId,
      keptIdsUnique,
    );
    const delStale = typeof delStaleRaw === "number" ? delStaleRaw : Number(delStaleRaw);

    await appendJobLog(jobId, "out", `Removed ${delStale} stale common-curriculum word row(s).`);

    const finalRows = await prisma.word.findMany({
      where: { languageId, id: { in: keptIdsUnique } },
      select: { id: true, rank: true, lemma: true },
    });

    const denseOrder = finalRows.sort((a, b) => {
      const ka = sortKeyByWordId.get(a.id) ?? a.rank * 1e6;
      const kb = sortKeyByWordId.get(b.id) ?? b.rank * 1e6;
      if (ka !== kb) return ka - kb;
      return a.lemma.localeCompare(b.lemma) || a.id.localeCompare(b.id);
    });

    const rankUpdates: ReturnType<typeof prisma.word.update>[] = [];
    for (let i = 0; i < denseOrder.length; i++) {
      const row = denseOrder[i]!;
      const newRank = i + 1;
      if (row.rank === newRank) continue;
      const cefr = cefrLevelForFrequencyRank(newRank);
      rankUpdates.push(
        prisma.word.update({
          where: { id: row.id },
          data: {
            rank: newRank,
            effectiveRank: newRank,
            positionAdjust: 0,
            cefrLevel: cefr ?? null,
          },
        }),
      );
    }
    for (let i = 0; i < rankUpdates.length; i += 150) {
      if (await isIngestionJobCancelled(jobId)) return;
      await prisma.$transaction(rankUpdates.slice(i, i + 150));
    }

    await resolveWordOrder(languageId);

    const metaPrev = await snapshotJobMetadata(jobId);

    await prisma.ingestionJob.updateMany({
      where: { id: jobId, status: "RUNNING" },
      data: {
        status: "COMPLETED",
        processedItems: pendingBases.length + promotedWrites,
        totalItems: pendingBases.length + promotedWrites,
        completedAt: new Date(),
        metadata: {
          ...metaPrev,
          missingLemmas,
          matchedLemmaCount: matchedSeeds.size,
          baseWordCount: pendingBases.length,
          promotedCount: promotedWrites,
          multiPosLemmas,
          processedKaikkiLines: processedLines,
          downloadUrl,
          requiredWordsLen: requiredWords.length,
        } as Prisma.InputJsonValue,
      },
    });

    await appendJobLog(
      jobId,
      "out",
      `COMMON curriculum complete — ${denseOrder.length} learning unit(s) (${promotedWrites} promoted); dense ranks applied.`,
    );

    await updateIngestionProgress(jobId, {
      processedItems: denseOrder.length,
      totalItems: denseOrder.length,
    });

    await chainWordsGlossCleanup(languageId);
  } catch (err) {
    console.error("[common-curriculum-kaikki]", err);
    if (await isIngestionJobCancelled(jobId)) return;
    await appendJobLog(jobId, "err", String(err));
    const metaPrev = await snapshotJobMetadata(jobId);
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        metadata: {
          ...metaPrev,
          error: err instanceof Error ? err.message : String(err),
          processedKaikkiLines: processedLines,
        } as Prisma.InputJsonValue,
      },
    });
    throw err;
  }
}
