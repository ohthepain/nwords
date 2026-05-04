import { app } from "@nwords/api";
import { prisma } from "@nwords/db";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useEffect, useMemo, useState } from "react";
import { JobOutputViewer } from "~/components/job-output-viewer";
import { Button } from "~/components/ui/button";
import { JOB_TYPE_LABELS, STATUS_STYLES, formatJobRelativeTime, jobMetadataError } from "~/lib/admin-ingest-jobs";
import { forwardedAdminApiHeaders } from "~/lib/server-admin-api";

const JOBS_PER_LANGUAGE = 20;

/** Matches `adminPartOfSpeechSchema` in API `admin/jobs` (Prisma `PartOfSpeech`). */
const CLOZE_PROMPT_TEST_POS = [
  "NOUN",
  "VERB",
  "ADJECTIVE",
  "ADVERB",
  "PRONOUN",
  "DETERMINER",
  "PREPOSITION",
  "CONJUNCTION",
  "PARTICLE",
  "INTERJECTION",
  "NUMERAL",
  "PROPER_NOUN",
] as const;

type ClozePromptTestPos = (typeof CLOZE_PROMPT_TEST_POS)[number];

const CLOZE_PROMPT_TEST_UNIT_TYPES = ["WORD", "PARTICLE", "FIXED_EXPR", "SPLIT"] as const;

type ClozePromptTestUnitType = (typeof CLOZE_PROMPT_TEST_UNIT_TYPES)[number];

type ClozePromptTestFields = {
  lemma: string;
  pos: ClozePromptTestPos;
  unitType: ClozePromptTestUnitType;
  gloss: string;
  rank: string;
  tags: string;
  candidatesPerUnit: string;
  selectedPerUnit: string;
};

function defaultClozePromptTestFields(): ClozePromptTestFields {
  return {
    lemma: "",
    pos: "VERB",
    unitType: "WORD",
    gloss: "",
    rank: "100",
    tags: "",
    candidatesPerUnit: "10",
    selectedPerUnit: "5",
  };
}

type ClozePromptPreviewResult = {
  languageCode?: string;
  languageName?: string;
  systemPrompt?: string;
  userPrompt?: string;
  unitJson?: object;
  candidates?: object[];
  usableCandidates?: object[];
  selectedCandidates?: object[];
  summary?: { returned: number; usable: number; selected: number };
};

type LanguageAdminRow = {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  wordCount: number;
  aiWordCount: number;
  commonWordCount: number;
  sentenceCount: number;
};

type LanguageIngestJobRow = {
  id: string;
  type: string;
  status: string;
  totalItems: number;
  processedItems: number;
  errorCount: number;
  progress: number | null;
  createdAt: string;
  chainPipeline: boolean;
  /** Populated from `metadata.error` when the worker records a failure. */
  errorMessage: string | null;
};

/** Newest first; break ties by id so list order is stable across refreshes. */
function compareIngestJobsForDisplay(a: LanguageIngestJobRow, b: LanguageIngestJobRow): number {
  if (a.createdAt > b.createdAt) return -1;
  if (a.createdAt < b.createdAt) return 1;
  if (a.id > b.id) return -1;
  if (a.id < b.id) return 1;
  return 0;
}

const loadAdminLanguagesPage = createServerFn({ method: "GET" }).handler(async () => {
  const [languagesRaw, wordSourceCounts, commonCurriculumCohortRows] = await Promise.all([
    prisma.language.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: { select: { words: true, sentences: true } },
      },
    }),
    prisma.word.groupBy({
      by: ["languageId", "curriculumSource"],
      _count: { _all: true },
    }),
    prisma.$queryRawUnsafe<Array<{ languageId: string; c: bigint }>>(`
			SELECT w."languageId"::text AS "languageId", COUNT(*)::bigint AS c
			FROM "word" w
			WHERE
				w."curriculumSource" IN ('COMMON', 'HERMIT_DAVE')
				OR (
					w."curriculumSource" = 'KAIKKI'
					AND w."curriculumUnit" IS NOT NULL
					AND COALESCE(w."curriculumUnit"::jsonb->'tags', '[]'::jsonb) @> '"common-frequency"'::jsonb
				)
			GROUP BY w."languageId"
		`),
  ]);
  const aiWordCountsByLanguageId = new Map(
    wordSourceCounts
      .filter((row) => row.curriculumSource === "AI_CURRICULUM")
      .map((row) => [row.languageId, row._count._all]),
  );
  const commonWordCountsByLanguageId = new Map(
    commonCurriculumCohortRows.map((row) => [row.languageId, Number(row.c)]),
  );

  const languages: LanguageAdminRow[] = languagesRaw.map((l) => ({
    id: l.id,
    code: l.code,
    name: l.name,
    enabled: l.enabled,
    wordCount: l._count.words,
    aiWordCount: aiWordCountsByLanguageId.get(l.id) ?? 0,
    commonWordCount: commonWordCountsByLanguageId.get(l.id) ?? 0,
    sentenceCount: l._count.sentences,
  }));

  // Show recent jobs under every listed language — not only toggled-On — so admins
  // aren’t fooled into thinking enqueue failed when the language toggle is Off.
  const languageIds = languagesRaw.map((l) => l.id);
  const jobsByLanguageId: Record<string, LanguageIngestJobRow[]> = {};
  for (const id of languageIds) {
    jobsByLanguageId[id] = [];
  }

  if (languageIds.length > 0) {
    // One capped query per language (not one global LIMIT). Otherwise the newest 400 jobs
    // across *all* languages can omit quieter languages entirely, so admins see “no job”.
    const jobRowsPerLang = await Promise.all(
      languageIds.map((lid) =>
        prisma.ingestionJob.findMany({
          where: { languageId: lid },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: JOBS_PER_LANGUAGE,
        }),
      ),
    );

    for (let i = 0; i < languageIds.length; i++) {
      if (!languageIds[i]) continue;
      const lid = languageIds[i];
      const jobs = jobRowsPerLang[i] ?? [];
      for (const j of jobs) {
        const progressPct = j.totalItems > 0 ? Math.round((j.processedItems / j.totalItems) * 100) : null;
        const jmeta = j.metadata as Record<string, unknown> | null;
        jobsByLanguageId[lid].push({
          id: j.id,
          type: j.type,
          status: j.status,
          totalItems: j.totalItems,
          processedItems: j.processedItems,
          errorCount: j.errorCount,
          progress: progressPct,
          createdAt: j.createdAt.toISOString(),
          chainPipeline: jmeta?.chainPipeline === true,
          errorMessage: jobMetadataError(j.metadata),
        });
      }
      jobsByLanguageId[lid].sort(compareIngestJobsForDisplay);
    }
  }

  return { languages, jobsByLanguageId };
});

const toggleLanguage = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; enabled: boolean }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const json = JSON.stringify({ enabled: data.enabled });
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/toggle`, {
        method: "PATCH",
        headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
        body: json,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      pipelineJobId?: string | null;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Toggle failed (${res.status})`);
    }
    return { success: true, pipelineJobId: body.pipelineJobId ?? null };
  });

const runLanguagePipeline = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/run-pipeline`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      pipelineJobId?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Pipeline failed (${res.status})`);
    }
    return { success: true, pipelineJobId: body.pipelineJobId };
  });

const runAiVocabPipeline = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/run-ai-vocab-pipeline`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      pipelineJobId?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Common words job failed (${res.status})`);
    }
    return { success: true, pipelineJobId: body.pipelineJobId };
  });

const runLlmVocabFromCommonWords = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const json = JSON.stringify({});
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/run-llm-vocab-from-common-words`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
        body: json,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      pipelineJobId?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `LLM vocabulary job failed (${res.status})`);
    }
    return { success: true, pipelineJobId: body.pipelineJobId };
  });

const runCommonCurriculumFromCommonWords = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const json = JSON.stringify({});
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/run-common-curriculum-from-common-words`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
        body: json,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      pipelineJobId?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Common curriculum job failed (${res.status})`);
    }
    return { success: true, pipelineJobId: body.pipelineJobId };
  });

const runHermitDaveCommonLemmas = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const json = JSON.stringify({});
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/run-hermit-dave-common-lemmas`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
        body: json,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      pipelineJobId?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Hermit Dave lemmas job failed (${res.status})`);
    }
    return { success: true, pipelineJobId: body.pipelineJobId };
  });

const runVocabCleanup = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; dryRun: boolean }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const json = JSON.stringify({ dryRun: data.dryRun });
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/run-vocab-cleanup`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
        body: json,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string; jobId?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `Vocab cleanup failed (${res.status})`);
    }
    return { success: true, jobId: body.jobId ?? null };
  });

const runCurriculumTestabilityTrim = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const json = JSON.stringify({});
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/run-curriculum-testability-trim`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
        body: json,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string; jobId?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `Curriculum testability trim failed (${res.status})`);
    }
    return { success: true, jobId: body.jobId ?? null };
  });

const generateFixedExpressions = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const json = JSON.stringify({ languageId: data.id });
    const res = await app.fetch(
      new Request(`${origin}/api/admin/jobs/fixed-expressions`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
        body: json,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `Fixed expressions job failed (${res.status})`);
    }
    return { success: true, jobId: body.id ?? null };
  });

const generateClozes = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; unitsLimit?: number }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const json = JSON.stringify({
      languageId: data.id,
      ...(data.unitsLimit !== undefined ? { unitsLimit: data.unitsLimit } : {}),
      resetExisting: false,
    });
    const res = await app.fetch(
      new Request(`${origin}/api/admin/jobs/cloze-generation`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
        body: json,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `Cloze generation job failed (${res.status})`);
    }
    return { success: true, jobId: body.id ?? null };
  });

const previewClozeGenerationPrompt = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      languageId: string;
      lemma: string;
      pos: ClozePromptTestPos;
      unitType: ClozePromptTestUnitType;
      gloss?: string;
      rank?: number;
      tags?: string[];
      candidatesPerUnit?: number;
      selectedPerUnit?: number;
    }) => data,
  )
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const payload = {
      languageId: data.languageId,
      lemma: data.lemma,
      pos: data.pos,
      unitType: data.unitType,
      gloss: data.gloss ?? "",
      rank: data.rank ?? 100,
      tags: data.tags ?? [],
      candidatesPerUnit: data.candidatesPerUnit ?? 10,
      selectedPerUnit: data.selectedPerUnit ?? 5,
    };
    const jsonBody = JSON.stringify(payload);
    const res = await app.fetch(
      new Request(`${origin}/api/admin/jobs/cloze-generation-prompt-preview`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request, { jsonBody: jsonBody }),
        body: jsonBody,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as ClozePromptPreviewResult & {
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Cloze prompt preview failed (${res.status})`);
    }
    return body;
  });

const clearLanguageSentenceLinks = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/clear-sentence-links`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      sentenceWordsRemoved?: number;
      sentencesReset?: number;
      wordsCleared?: number;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Clear failed (${res.status})`);
    }
    return {
      sentenceWordsRemoved: body.sentenceWordsRemoved ?? 0,
      sentencesReset: body.sentencesReset ?? 0,
      wordsCleared: body.wordsCleared ?? 0,
    };
  });

const clearGeneratedClozes = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/clear-generated-clozes`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      generatedClozesDeleted?: number;
      wordsCleared?: number;
      sentenceWordScoresCleared?: number;
      aiSentencesDeleted?: number;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Clear clozes failed (${res.status})`);
    }
    return {
      generatedClozesDeleted: body.generatedClozesDeleted ?? 0,
      wordsCleared: body.wordsCleared ?? 0,
      sentenceWordScoresCleared: body.sentenceWordScoresCleared ?? 0,
      aiSentencesDeleted: body.aiSentencesDeleted ?? 0,
    };
  });

const clearVocabulary = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/clear-vocabulary`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      wordsDeleted?: number;
      generatedClozesDeleted?: number;
      clozeReportsDeleted?: number;
      userKnowledgeDeleted?: number;
      sentenceWordsDeleted?: number;
      wordFormsDeleted?: number;
      synonymPairsDeleted?: number;
      commonLemmasDeleted?: number;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Clear vocabulary failed (${res.status})`);
    }
    return {
      wordsDeleted: body.wordsDeleted ?? 0,
      generatedClozesDeleted: body.generatedClozesDeleted ?? 0,
      clozeReportsDeleted: body.clozeReportsDeleted ?? 0,
      userKnowledgeDeleted: body.userKnowledgeDeleted ?? 0,
      sentenceWordsDeleted: body.sentenceWordsDeleted ?? 0,
      wordFormsDeleted: body.wordFormsDeleted ?? 0,
      synonymPairsDeleted: body.synonymPairsDeleted ?? 0,
      commonLemmasDeleted: body.commonLemmasDeleted ?? 0,
    };
  });

const clearSentenceCorpus = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const request = getRequest();
    if (!request) {
      throw new Error("Missing request context");
    }
    const origin = new URL(request.url).origin;
    const res = await app.fetch(
      new Request(`${origin}/api/admin/languages/${data.id}/clear-sentence-corpus`, {
        method: "POST",
        headers: forwardedAdminApiHeaders(request),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      sentenceTranslationsDeleted?: number;
      sentencesDeleted?: number;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `Clear sentence corpus failed (${res.status})`);
    }
    return {
      sentenceTranslationsDeleted: body.sentenceTranslationsDeleted ?? 0,
      sentencesDeleted: body.sentencesDeleted ?? 0,
    };
  });

export const Route = createFileRoute("/_authed/_admin/admin/languages")({
  loader: () => loadAdminLanguagesPage(),
  component: AdminLanguagesPage,
});

function AdminLanguagesPage() {
  const router = useRouter();
  const { languages, jobsByLanguageId } = Route.useLoaderData();
  const [toggling, setToggling] = useState<string | null>(null);
  const [runningPipeline, setRunningPipeline] = useState<string | null>(null);
  const [runningAiVocab, setRunningAiVocab] = useState<string | null>(null);
  const [runningCommonCurriculum, setRunningCommonCurriculum] = useState<string | null>(null);
  const [runningHermitDaveLemmas, setRunningHermitDaveLemmas] = useState<string | null>(null);
  const [runningLlmVocab, setRunningLlmVocab] = useState<string | null>(null);
  const [generatingFixedExpr, setGeneratingFixedExpr] = useState<string | null>(null);
  const [generatingClozes, setGeneratingClozes] = useState<string | null>(null);
  const [clozeUnitsLimit, setClozeUnitsLimit] = useState("");
  const [runningVocabCleanup, setRunningVocabCleanup] = useState<{
    langId: string;
    dryRun: boolean;
  } | null>(null);
  const [runningCurriculumTrim, setRunningCurriculumTrim] = useState<string | null>(null);
  const [clearingLinksId, setClearingLinksId] = useState<string | null>(null);
  const [clearingCorpusId, setClearingCorpusId] = useState<string | null>(null);
  const [clearingClozesId, setClearingClozesId] = useState<string | null>(null);
  const [clearingVocabId, setClearingVocabId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [jobActionError, setJobActionError] = useState<string | null>(null);
  const [requeueJobId, setRequeueJobId] = useState<string | null>(null);
  const [skippingJobId, setSkippingJobId] = useState<string | null>(null);
  const [skipJobError, setSkipJobError] = useState<string | null>(null);
  const [outputJob, setOutputJob] = useState<{ id: string; title: string } | null>(null);
  const [clozePromptTestByLang, setClozePromptTestByLang] = useState<
    Partial<Record<string, Partial<ClozePromptTestFields>>>
  >({});
  const [clozePromptPreviewByLang, setClozePromptPreviewByLang] = useState<Record<string, ClozePromptPreviewResult>>(
    {},
  );
  const [clozePromptPreviewLoading, setClozePromptPreviewLoading] = useState<string | null>(null);

  function getClozePromptTest(langId: string): ClozePromptTestFields {
    return { ...defaultClozePromptTestFields(), ...clozePromptTestByLang[langId] };
  }

  function patchClozePromptTest(langId: string, patch: Partial<ClozePromptTestFields>) {
    setClozePromptTestByLang((m) => ({
      ...m,
      [langId]: { ...defaultClozePromptTestFields(), ...m[langId], ...patch },
    }));
  }

  const enabledJobsFlat = useMemo(() => {
    const out: LanguageIngestJobRow[] = [];
    for (const lang of languages) {
      if (!lang.enabled) continue;
      out.push(...(jobsByLanguageId[lang.id] ?? []));
    }
    return out;
  }, [languages, jobsByLanguageId]);

  const hasActiveIngestJobs = enabledJobsFlat.some((j) => j.status === "RUNNING" || j.status === "PENDING");

  useEffect(() => {
    if (!hasActiveIngestJobs) return;
    const interval = setInterval(() => {
      router.invalidate();
    }, 3000);
    return () => clearInterval(interval);
  }, [hasActiveIngestJobs, router]);

  const enabledCount = languages.filter((l) => l.enabled).length;
  const withWords = languages.filter((l) => l.wordCount > 0).length;

  async function handleToggle(id: string, currentlyEnabled: boolean) {
    setNotice(null);
    setToggling(id);
    try {
      const out = await toggleLanguage({ data: { id, enabled: !currentlyEnabled } });
      if (out.pipelineJobId) {
        setNotice({
          kind: "ok",
          text: `Ingestion started — job ${out.pipelineJobId.slice(0, 8)}… See jobs below (when this language is on) or the full list on Jobs.`,
        });
      }
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Toggle failed" });
    } finally {
      setToggling(null);
    }
    await router.invalidate();
  }

  async function handleRunPipeline(id: string) {
    setNotice(null);
    setRunningPipeline(id);
    try {
      const out = await runLanguagePipeline({ data: { id } });
      setNotice({
        kind: "ok",
        text: out.pipelineJobId
          ? `Pipeline queued — job ${out.pipelineJobId.slice(0, 8)}… Progress appears below and on Jobs.`
          : "Pipeline queued. Progress appears below and on Jobs.",
      });
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Pipeline failed" });
    } finally {
      setRunningPipeline(null);
    }
    await router.invalidate();
  }

  async function handleRunAiVocab(id: string) {
    setNotice(null);
    setRunningAiVocab(id);
    try {
      const out = await runAiVocabPipeline({ data: { id } });
      setNotice({
        kind: "ok",
        text: out.pipelineJobId
          ? `Common words job queued — ${out.pipelineJobId.slice(0, 8)}… Review lemma list / job metadata; then Common curriculum (Kaikki) or optional LLM vocabulary.`
          : "Common words job queued.",
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Common words job failed",
      });
    } finally {
      setRunningAiVocab(null);
    }
    await router.invalidate();
  }

  async function handleRunHermitDaveCommonLemmas(id: string) {
    setNotice(null);
    setRunningHermitDaveLemmas(id);
    try {
      const out = await runHermitDaveCommonLemmas({ data: { id } });
      setNotice({
        kind: "ok",
        text: out.pipelineJobId
          ? `Hermit Dave lemmas queued — ${out.pipelineJobId.slice(0, 8)}… Scans top 2000 HermitDave lines; appends missing entries to common lemmas.`
          : "Hermit Dave lemmas job queued.",
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Hermit Dave lemmas job failed",
      });
    } finally {
      setRunningHermitDaveLemmas(null);
    }
    await router.invalidate();
  }

  async function handleRunCommonCurriculum(id: string) {
    setNotice(null);
    setRunningCommonCurriculum(id);
    try {
      const out = await runCommonCurriculumFromCommonWords({ data: { id } });
      setNotice({
        kind: "ok",
        text: out.pipelineJobId
          ? `Common curriculum (Kaikki) queued — ${out.pipelineJobId.slice(0, 8)}… Uses curated common lemmas for this language.`
          : "Common curriculum job queued.",
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Common curriculum job failed",
      });
    } finally {
      setRunningCommonCurriculum(null);
    }
    await router.invalidate();
  }

  async function handleRunLlmVocab(id: string) {
    setNotice(null);
    setRunningLlmVocab(id);
    try {
      const out = await runLlmVocabFromCommonWords({ data: { id } });
      setNotice({
        kind: "ok",
        text: out.pipelineJobId
          ? `LLM vocabulary queued — ${out.pipelineJobId.slice(0, 8)}… Uses the latest completed Common words job for this language.`
          : "LLM vocabulary queued.",
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "LLM vocabulary job failed",
      });
    } finally {
      setRunningLlmVocab(null);
    }
    await router.invalidate();
  }

  async function handleGenerateFixedExpressions(id: string) {
    setNotice(null);
    setGeneratingFixedExpr(id);
    try {
      const out = await generateFixedExpressions({ data: { id } });
      setNotice({
        kind: "ok",
        text: out.jobId
          ? `Fixed expressions job queued — ${out.jobId.slice(0, 8)}… Progress appears below and on Jobs.`
          : "Fixed expressions job queued.",
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Fixed expressions job failed",
      });
    } finally {
      setGeneratingFixedExpr(null);
    }
    await router.invalidate();
  }

  async function handleGenerateClozes(id: string) {
    setNotice(null);
    setGeneratingClozes(id);
    try {
      const parsedLimit = Number.parseInt(clozeUnitsLimit, 10);
      const out = await generateClozes({
        data: {
          id,
          ...(Number.isFinite(parsedLimit) && parsedLimit > 0 ? { unitsLimit: parsedLimit } : {}),
        },
      });
      setNotice({
        kind: "ok",
        text: out.jobId
          ? `Cloze generation queued — ${out.jobId.slice(0, 8)}… Progress appears below and on Jobs.`
          : "Cloze generation queued.",
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Cloze generation failed",
      });
    } finally {
      setGeneratingClozes(null);
    }
    await router.invalidate();
  }

  async function handlePreviewClozePrompt(langId: string) {
    const t = getClozePromptTest(langId);
    if (!t.lemma.trim()) {
      setNotice({
        kind: "err",
        text: "Enter the learning-unit text (same string the job expects as the cloze answer).",
      });
      return;
    }
    const rank = Number.parseInt(t.rank, 10);
    const cPer = Number.parseInt(t.candidatesPerUnit, 10);
    const sPer = Number.parseInt(t.selectedPerUnit, 10);
    if (!Number.isFinite(cPer) || cPer < 5 || cPer > 20) {
      setNotice({
        kind: "err",
        text: "Candidates per unit must be a number from 5 to 20 (same limits as batch generation).",
      });
      return;
    }
    if (!Number.isFinite(sPer) || sPer < 1 || sPer > 10) {
      setNotice({
        kind: "err",
        text: "Selected per unit must be a number from 1 to 10.",
      });
      return;
    }
    setNotice(null);
    setClozePromptPreviewLoading(langId);
    try {
      const out = await previewClozeGenerationPrompt({
        data: {
          languageId: langId,
          lemma: t.lemma.trim(),
          pos: t.pos,
          unitType: t.unitType,
          gloss: t.gloss.trim() || undefined,
          rank: Number.isFinite(rank) ? rank : 100,
          tags: t.tags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          candidatesPerUnit: cPer,
          selectedPerUnit: sPer,
        },
      });
      setClozePromptPreviewByLang((m) => ({ ...m, [langId]: out }));
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Cloze prompt preview failed",
      });
    } finally {
      setClozePromptPreviewLoading(null);
    }
  }

  async function handleVocabCleanup(id: string, dryRun: boolean) {
    setNotice(null);
    setRunningVocabCleanup({ langId: id, dryRun });
    try {
      const out = await runVocabCleanup({ data: { id, dryRun } });
      setNotice({
        kind: "ok",
        text: out.jobId
          ? dryRun
            ? `Vocab cleanup preview queued — ${out.jobId.slice(0, 8)}… Open Output → Preview when done.`
            : `Vocab cleanup (apply) queued — ${out.jobId.slice(0, 8)}… Updates ranks when done.`
          : "Vocab cleanup queued.",
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Vocab cleanup failed",
      });
    } finally {
      setRunningVocabCleanup(null);
    }
    await router.invalidate();
  }

  async function handleCurriculumTestabilityTrim(id: string) {
    setNotice(null);
    setRunningCurriculumTrim(id);
    try {
      const out = await runCurriculumTestabilityTrim({ data: { id } });
      setNotice({
        kind: "ok",
        text: out.jobId
          ? `Curriculum testability trim queued — ${out.jobId.slice(0, 8)}… LLM batches (~100 rows each by default). Tune CURRICULUM_TESTABILITY_TRIM_BATCH_SIZE / CURRICULUM_TESTABILITY_TRIM_LLM_CONCURRENCY on API if needed.`
          : "Curriculum testability trim queued.",
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Curriculum testability trim failed",
      });
    } finally {
      setRunningCurriculumTrim(null);
    }
    await router.invalidate();
  }

  async function handleClearSentenceLinks(id: string, name: string) {
    if (
      !globalThis.confirm(
        `Clear sentence links for ${name}? This removes word↔sentence links, resets sentence test scores, and empties curated test sentences on every word in this language. Tatoeba sentence text and translation pairs are kept. Run Re-import (or enqueue Tatoeba Sentences with linking) afterward to rebuild links.`,
      )
    ) {
      return;
    }
    setNotice(null);
    setClearingLinksId(id);
    try {
      const out = await clearLanguageSentenceLinks({ data: { id } });
      setNotice({
        kind: "ok",
        text: `Cleared ${out.sentenceWordsRemoved.toLocaleString()} word–sentence links; reset ${out.sentencesReset.toLocaleString()} sentences; updated ${out.wordsCleared.toLocaleString()} words. Queue Tatoeba / Re-import to relink.`,
      });
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Clear failed" });
    } finally {
      setClearingLinksId(null);
    }
    await router.invalidate();
  }

  async function handleClearSentenceCorpus(id: string, name: string) {
    if (
      !globalThis.confirm(
        `Delete ALL sentences for ${name}? This removes every Tatoeba/AI sentence row for this language, every translation pair that touches them, all word↔sentence links (via cascades), and clears curated test sentence IDs on words. Re-run Tatoeba (or AI sentence import) afterward. This cannot be undone.`,
      )
    ) {
      return;
    }
    setNotice(null);
    setClearingCorpusId(id);
    try {
      const out = await clearSentenceCorpus({ data: { id } });
      setNotice({
        kind: "ok",
        text: `Deleted ${out.sentencesDeleted.toLocaleString()} sentence(s) and ${out.sentenceTranslationsDeleted.toLocaleString()} translation pair(s). Re-import corpus when ready.`,
      });
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Clear corpus failed" });
    } finally {
      setClearingCorpusId(null);
    }
    await router.invalidate();
  }

  async function handleClearGeneratedClozes(id: string, name: string) {
    if (
      !globalThis.confirm(
        `Clear generated clozes for ${name}? This deletes generated cloze rows and clears cloze-generation metadata, so the next cloze generation run starts fresh.`,
      )
    ) {
      return;
    }
    setNotice(null);
    setClearingClozesId(id);
    try {
      const out = await clearGeneratedClozes({ data: { id } });
      setNotice({
        kind: "ok",
        text: `Cleared ${out.generatedClozesDeleted.toLocaleString()} generated cloze(s); reset ${out.wordsCleared.toLocaleString()} word row(s).`,
      });
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Clear clozes failed" });
    } finally {
      setClearingClozesId(null);
    }
    await router.invalidate();
  }

  async function handleClearVocabulary(id: string, name: string) {
    if (
      !globalThis.confirm(
        `Clear ALL vocabulary for ${name}? This deletes every word row for this language, the curated common-words seed list (used for LLM vocabulary), generated clozes, word forms, sentence links, user knowledge, synonym pairs, and cloze issue reports tied to those words. This cannot be undone.`,
      )
    ) {
      return;
    }
    setNotice(null);
    setClearingVocabId(id);
    try {
      const out = await clearVocabulary({ data: { id } });
      setNotice({
        kind: "ok",
        text: `Deleted ${out.wordsDeleted.toLocaleString()} vocabulary word(s), ${out.commonLemmasDeleted.toLocaleString()} common-word seed row(s), ${out.generatedClozesDeleted.toLocaleString()} generated cloze(s), ${out.wordFormsDeleted.toLocaleString()} word form(s), ${out.sentenceWordsDeleted.toLocaleString()} sentence link(s), ${out.userKnowledgeDeleted.toLocaleString()} user knowledge row(s), ${out.synonymPairsDeleted.toLocaleString()} synonym pair(s), and ${out.clozeReportsDeleted.toLocaleString()} cloze report(s).`,
      });
    } catch (e) {
      setNotice({
        kind: "err",
        text: e instanceof Error ? e.message : "Clear vocabulary failed",
      });
    } finally {
      setClearingVocabId(null);
    }
    await router.invalidate();
  }

  async function handleJobCancel(jobId: string) {
    setJobActionError(null);
    await fetch(`/api/admin/jobs/${jobId}/cancel`, {
      method: "POST",
      credentials: "include",
    });
    await router.invalidate();
  }

  async function handleJobSkipAndChain(jobId: string) {
    setJobActionError(null);
    setSkipJobError(null);
    if (
      !globalThis.confirm(
        "Mark this job complete (assume data is already in the database) and continue the pipeline when chaining is enabled? The worker stops on its next check.",
      )
    ) {
      return;
    }
    setSkippingJobId(jobId);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/skip-and-chain`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSkipJobError(body.error ?? `Skip failed (${res.status})`);
        return;
      }
      await router.invalidate();
    } finally {
      setSkippingJobId(null);
    }
  }

  async function handleJobRetry(jobId: string) {
    setJobActionError(null);
    setRequeueJobId(jobId);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/retry`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setJobActionError(body.error ?? `Retry failed (${res.status})`);
        return;
      }
      await router.invalidate();
    } finally {
      setRequeueJobId(null);
    }
  }

  async function handleJobRerun(jobId: string) {
    if (!globalThis.confirm("Queue a new run using this job’s saved file/URLs? The completed job stays in the list.")) {
      return;
    }
    setJobActionError(null);
    setRequeueJobId(jobId);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/rerun`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setJobActionError(body.error ?? `Re-run failed (${res.status})`);
        return;
      }
      await router.invalidate();
    } finally {
      setRequeueJobId(null);
    }
  }

  return (
    <div className="p-6 space-y-6 relative">
      <JobOutputViewer
        jobId={outputJob?.id ?? null}
        title={outputJob?.title ?? ""}
        open={outputJob !== null}
        onClose={() => setOutputJob(null)}
      />
      <div className="text-sm text-muted-foreground space-y-1">
        <p>Manage which languages are available to users.</p>
        <p className="text-xs">
          Recent <strong className="text-foreground font-medium">ingestion jobs</strong> appear under each row (Output /
          Skip → next / Cancel / Retry / Re-run). <strong className="text-foreground font-medium">Kaikki vocab</strong>{" "}
          only runs after you have lemmas: finish <strong className="text-foreground font-medium">Common words</strong>{" "}
          or add words in{" "}
          <Link
            to="/admin/common-words"
            className="underline underline-offset-2 hover:text-foreground font-medium text-foreground/90"
          >
            Common words (editor)
          </Link>
          . For a full job list see{" "}
          <Link
            to="/admin/jobs"
            className="underline underline-offset-2 hover:text-foreground font-medium text-foreground/90"
          >
            Jobs
          </Link>
          . With a language on and no words yet, ingestion may start automatically; otherwise use{" "}
          <strong className="text-foreground font-medium">Common words</strong> then{" "}
          <strong className="text-foreground font-medium">Kaikki vocab</strong> (chains words gloss cleanup). Optionally{" "}
          <strong className="text-foreground font-medium">Trim testability</strong> (LLM: drop rare tenses/archaic
          senses), or use <strong className="text-foreground font-medium">LLM vocabulary</strong>. Or use{" "}
          <strong className="text-foreground font-medium">Legacy</strong> (Kaikki → frequency → Tatoeba when{" "}
          <code className="text-xs">VOCAB_PIPELINE=legacy</code>). Turning a language on with no words starts{" "}
          <strong className="text-foreground font-medium">Common words</strong> by default.
        </p>
        <p className="text-xs">
          Legacy pipeline: Kaikki.org JSONL → frequency ranks (HermitDave or bnpd) → Tatoeba when{" "}
          <code className="text-xs">VOCAB_PIPELINE=legacy</code>.
        </p>
      </div>

      {notice ? (
        <output
          className={`text-sm rounded-md border px-3 py-2 block ${
            notice.kind === "ok"
              ? "border-known/50 bg-known/10 text-foreground"
              : "border-destructive/50 bg-destructive/10 text-destructive"
          }`}
        >
          {notice.text}
        </output>
      ) : null}

      {jobActionError ? (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
          {jobActionError}
        </div>
      ) : null}
      {skipJobError ? (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
          {skipJobError}
        </div>
      ) : null}

      {/* Summary stats */}
      <div className="flex items-center gap-6 text-sm">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-muted-foreground" />
          <span className="text-muted-foreground">
            <span className="font-mono font-medium text-foreground">{languages.length}</span> total
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-known" />
          <span className="text-muted-foreground">
            <span className="font-mono font-medium text-foreground">{enabledCount}</span> enabled
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-brand" />
          <span className="text-muted-foreground">
            <span className="font-mono font-medium text-foreground">{withWords}</span> with words
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/25 px-4 py-3 space-y-2">
        <p className="text-sm font-semibold text-foreground">Vocabulary cleanup</p>
        <p className="text-xs text-muted-foreground leading-relaxed max-w-3xl">
          Re-order <strong className="text-foreground font-medium">AI curriculum</strong> units so the same spelling
          with different parts of speech (different senses) are spaced apart in the list. Uses your curated{" "}
          <strong className="text-foreground font-medium">common words</strong> order to pick the primary sense when
          needed. In the <strong className="text-foreground font-medium">Import</strong> column, use{" "}
          <strong className="text-foreground font-medium">Cleanup preview</strong> (no DB changes; open{" "}
          <strong className="text-foreground">Output → Preview</strong> when done) or{" "}
          <strong className="text-foreground font-medium">Cleanup apply</strong> to write new ranks.
        </p>
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="grid grid-cols-[1fr_90px_90px_100px_minmax(14rem,1fr)] gap-4 text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em] px-4 py-2.5 bg-muted/50 border-b border-border">
          <span>Language</span>
          <span className="text-right">Words</span>
          <span className="text-right">Sentences</span>
          <span className="text-right">On</span>
          <span className="text-right">Import</span>
        </div>
        <div className="divide-y divide-border">
          {languages.map((lang) => {
            const langJobs = jobsByLanguageId[lang.id] ?? [];
            return (
              <div key={lang.id} className="bg-background">
                <div className="grid grid-cols-[1fr_90px_90px_100px_minmax(14rem,1fr)] gap-4 items-center px-4 py-2.5 hover:bg-muted/30 transition-colors">
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-sm font-medium truncate">{lang.name}</span>
                      <span className="text-xs font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5 shrink-0">
                        {lang.code}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                      <Link
                        to="/admin/common-words"
                        search={{ languageId: lang.id }}
                        className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                      >
                        Common words
                      </Link>
                      <span className="text-border select-none">·</span>
                      <Link
                        to="/admin/words"
                        search={{ languageId: lang.id }}
                        className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                      >
                        Words
                      </Link>
                      <span className="text-border select-none">·</span>
                      <Link
                        to="/admin/sentences"
                        search={{ languageId: lang.id }}
                        className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                      >
                        Sentences
                      </Link>
                      <span className="text-border select-none">·</span>
                      <button
                        type="button"
                        disabled={
                          clearingLinksId === lang.id ||
                          clearingCorpusId === lang.id ||
                          clearingClozesId === lang.id ||
                          clearingVocabId === lang.id ||
                          toggling === lang.id ||
                          runningPipeline === lang.id ||
                          runningAiVocab === lang.id ||
                          runningLlmVocab === lang.id ||
                          runningHermitDaveLemmas === lang.id ||
                          runningCommonCurriculum === lang.id ||
                          runningCurriculumTrim === lang.id ||
                          runningVocabCleanup?.langId === lang.id ||
                          lang.sentenceCount === 0
                        }
                        className="text-destructive/90 hover:text-destructive hover:underline underline-offset-2 disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                        onClick={() => handleClearSentenceLinks(lang.id, lang.name)}
                      >
                        {clearingLinksId === lang.id ? "Clearing…" : "Clear sentence links"}
                      </button>
                      <span className="text-border select-none">·</span>
                      <button
                        type="button"
                        disabled={
                          clearingLinksId === lang.id ||
                          clearingCorpusId === lang.id ||
                          clearingClozesId === lang.id ||
                          clearingVocabId === lang.id ||
                          toggling === lang.id ||
                          runningPipeline === lang.id ||
                          runningAiVocab === lang.id ||
                          runningLlmVocab === lang.id ||
                          runningHermitDaveLemmas === lang.id ||
                          runningCommonCurriculum === lang.id ||
                          runningCurriculumTrim === lang.id ||
                          runningVocabCleanup?.langId === lang.id ||
                          generatingClozes === lang.id ||
                          lang.sentenceCount === 0
                        }
                        className="text-destructive/90 hover:text-destructive hover:underline underline-offset-2 disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                        onClick={() => handleClearSentenceCorpus(lang.id, lang.name)}
                      >
                        {clearingCorpusId === lang.id ? "Clearing…" : "Delete sentences"}
                      </button>
                      <span className="text-border select-none">·</span>
                      <button
                        type="button"
                        disabled={
                          clearingLinksId === lang.id ||
                          clearingCorpusId === lang.id ||
                          clearingClozesId === lang.id ||
                          clearingVocabId === lang.id ||
                          generatingClozes === lang.id ||
                          toggling === lang.id
                        }
                        className="text-destructive/90 hover:text-destructive hover:underline underline-offset-2 disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                        onClick={() => handleClearGeneratedClozes(lang.id, lang.name)}
                      >
                        {clearingClozesId === lang.id ? "Clearing…" : "Clear clozes"}
                      </button>
                      <span className="text-border select-none">·</span>
                      <button
                        type="button"
                        disabled={
                          clearingLinksId === lang.id ||
                          clearingCorpusId === lang.id ||
                          clearingClozesId === lang.id ||
                          clearingVocabId === lang.id ||
                          runningAiVocab === lang.id ||
                          runningLlmVocab === lang.id ||
                          runningHermitDaveLemmas === lang.id ||
                          runningCommonCurriculum === lang.id ||
                          runningCurriculumTrim === lang.id ||
                          runningVocabCleanup?.langId === lang.id ||
                          generatingClozes === lang.id ||
                          toggling === lang.id
                        }
                        className="text-destructive/90 hover:text-destructive hover:underline underline-offset-2 disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                        onClick={() => handleClearVocabulary(lang.id, lang.name)}
                      >
                        {clearingVocabId === lang.id ? "Clearing…" : "Clear vocab"}
                      </button>
                    </div>
                  </div>
                  <span className="text-right tabular-nums">
                    <span className="block text-sm font-mono">
                      {lang.wordCount > 0 ? (
                        lang.wordCount.toLocaleString()
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                    <span
                      className="block text-[10px] text-muted-foreground"
                      title="AI = AI_CURRICULUM. Curr = frequency-seed COMMON/HERMIT + Kaikki common-curriculum (common-frequency tag)."
                    >
                      AI {lang.aiWordCount.toLocaleString()} · Curr {lang.commonWordCount.toLocaleString()}
                    </span>
                  </span>
                  <span className="text-sm font-mono text-right tabular-nums">
                    {lang.sentenceCount > 0 ? (
                      lang.sentenceCount.toLocaleString()
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                  <div className="flex justify-end">
                    <Button
                      variant={lang.enabled ? "default" : "outline"}
                      size="sm"
                      className="h-7 text-xs w-20 font-mono"
                      disabled={
                        toggling === lang.id ||
                        runningPipeline === lang.id ||
                        runningAiVocab === lang.id ||
                        runningLlmVocab === lang.id ||
                        runningHermitDaveLemmas === lang.id ||
                        runningCommonCurriculum === lang.id ||
                        runningCurriculumTrim === lang.id ||
                        runningVocabCleanup?.langId === lang.id
                      }
                      onClick={() => handleToggle(lang.id, lang.enabled)}
                    >
                      {lang.enabled ? "On" : "Off"}
                    </Button>
                  </div>
                  <div className="flex flex-col gap-1 items-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs px-2 font-mono w-full max-w-[11rem]"
                      disabled={
                        runningPipeline === lang.id ||
                        runningAiVocab === lang.id ||
                        runningLlmVocab === lang.id ||
                        runningHermitDaveLemmas === lang.id ||
                        runningCommonCurriculum === lang.id ||
                        runningCurriculumTrim === lang.id ||
                        runningVocabCleanup?.langId === lang.id ||
                        toggling === lang.id
                      }
                      onClick={() => handleRunAiVocab(lang.id)}
                    >
                      {runningAiVocab === lang.id ? "…" : "Common words"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs px-2 font-mono w-full max-w-[11rem]"
                      disabled={
                        runningPipeline === lang.id ||
                        runningAiVocab === lang.id ||
                        runningLlmVocab === lang.id ||
                        runningHermitDaveLemmas === lang.id ||
                        runningCommonCurriculum === lang.id ||
                        runningCurriculumTrim === lang.id ||
                        runningVocabCleanup?.langId === lang.id ||
                        toggling === lang.id
                      }
                      title="HermitDave only: reads top 2000 ranked lines from hermitdave/FrequencyWords (no BNPD fold-in). Adds lemmas not already present in Common lemmas."
                      onClick={() => void handleRunHermitDaveCommonLemmas(lang.id)}
                    >
                      {runningHermitDaveLemmas === lang.id ? "…" : "Hermit Dave lemmas"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs px-2 font-mono w-full max-w-[11rem]"
                      disabled={
                        runningPipeline === lang.id ||
                        runningAiVocab === lang.id ||
                        runningLlmVocab === lang.id ||
                        runningHermitDaveLemmas === lang.id ||
                        runningCommonCurriculum === lang.id ||
                        runningCurriculumTrim === lang.id ||
                        runningVocabCleanup?.langId === lang.id ||
                        toggling === lang.id
                      }
                      title="Needs curated common lemmas (editor) or a completed Common words job, then streams Kaikki and writes COMMON curriculum rows."
                      onClick={() => handleRunCommonCurriculum(lang.id)}
                    >
                      {runningCommonCurriculum === lang.id ? "…" : "Kaikki vocab"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs px-2 font-mono w-full max-w-[11rem]"
                      disabled={
                        runningPipeline === lang.id ||
                        runningAiVocab === lang.id ||
                        runningLlmVocab === lang.id ||
                        runningHermitDaveLemmas === lang.id ||
                        runningCommonCurriculum === lang.id ||
                        runningCurriculumTrim === lang.id ||
                        runningVocabCleanup?.langId === lang.id ||
                        toggling === lang.id
                      }
                      title="After gloss cleanup: LLM reads batches of scoped curriculum rows (~100 per request by default; CURRICULUM_TESTABILITY_TRIM_BATCH_SIZE) and sets isTestable=false for peripheral senses/forms (archaic, rare tenses). Uses CURRICULUM_TESTABILITY_TRIM_LLM_CONCURRENCY parallel batches."
                      onClick={() => void handleCurriculumTestabilityTrim(lang.id)}
                    >
                      {runningCurriculumTrim === lang.id ? "…" : "Trim testability"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs px-2 font-mono w-full max-w-[11rem]"
                      disabled={
                        runningPipeline === lang.id ||
                        runningAiVocab === lang.id ||
                        runningLlmVocab === lang.id ||
                        runningHermitDaveLemmas === lang.id ||
                        runningCommonCurriculum === lang.id ||
                        runningCurriculumTrim === lang.id ||
                        runningVocabCleanup?.langId === lang.id ||
                        toggling === lang.id
                      }
                      onClick={() => handleRunLlmVocab(lang.id)}
                    >
                      {runningLlmVocab === lang.id ? "…" : "LLM vocabulary"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs px-2 font-mono w-full max-w-[11rem]"
                      disabled={
                        runningPipeline === lang.id ||
                        runningAiVocab === lang.id ||
                        runningLlmVocab === lang.id ||
                        runningHermitDaveLemmas === lang.id ||
                        runningCommonCurriculum === lang.id ||
                        runningCurriculumTrim === lang.id ||
                        runningVocabCleanup?.langId === lang.id ||
                        toggling === lang.id
                      }
                      onClick={() => handleRunPipeline(lang.id)}
                    >
                      {runningPipeline === lang.id ? "…" : "Legacy"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs px-2 font-mono w-full max-w-[11rem]"
                      disabled={
                        runningPipeline === lang.id ||
                        runningAiVocab === lang.id ||
                        runningLlmVocab === lang.id ||
                        runningHermitDaveLemmas === lang.id ||
                        runningCommonCurriculum === lang.id ||
                        runningCurriculumTrim === lang.id ||
                        runningVocabCleanup?.langId === lang.id ||
                        toggling === lang.id
                      }
                      onClick={() => void handleVocabCleanup(lang.id, true)}
                    >
                      {runningVocabCleanup?.langId === lang.id && runningVocabCleanup.dryRun ? "…" : "Cleanup preview"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs px-2 font-mono w-full max-w-[11rem]"
                      disabled={
                        runningPipeline === lang.id ||
                        runningAiVocab === lang.id ||
                        runningLlmVocab === lang.id ||
                        runningHermitDaveLemmas === lang.id ||
                        runningCommonCurriculum === lang.id ||
                        runningCurriculumTrim === lang.id ||
                        runningVocabCleanup?.langId === lang.id ||
                        toggling === lang.id
                      }
                      onClick={() => {
                        if (!window.confirm("Apply vocabulary cleanup? This updates word ranks in the database."))
                          return;
                        void handleVocabCleanup(lang.id, false);
                      }}
                    >
                      {runningVocabCleanup?.langId === lang.id && !runningVocabCleanup.dryRun ? "…" : "Cleanup apply"}
                    </Button>
                  </div>
                </div>

                {lang.enabled ? (
                  <div className="px-4 py-3 bg-muted/20 border-t border-border/70">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em]">
                        Ingestion jobs (latest {JOBS_PER_LANGUAGE})
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[11px] px-2 font-mono"
                          disabled={generatingFixedExpr === lang.id}
                          onClick={() => handleGenerateFixedExpressions(lang.id)}
                        >
                          {generatingFixedExpr === lang.id ? "Generating…" : "Generate fixed expressions"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[11px] px-2 font-mono"
                          disabled={generatingClozes === lang.id}
                          onClick={() => handleGenerateClozes(lang.id)}
                        >
                          {generatingClozes === lang.id ? "Queuing…" : "Generate clozes"}
                        </Button>
                      </div>
                    </div>
                    <div className="px-4 pb-3 bg-muted/20 border-t border-border/40">
                      <div className="flex items-start gap-3 pt-3">
                        <div className="flex items-center gap-1.5 shrink-0">
                          <label
                            htmlFor={`cloze-max-${lang.id}`}
                            className="text-[11px] font-mono text-muted-foreground whitespace-nowrap"
                          >
                            Unit limit
                          </label>
                          <input
                            id={`cloze-max-${lang.id}`}
                            type="number"
                            min={1}
                            max={10000}
                            placeholder="all"
                            value={clozeUnitsLimit}
                            onChange={(e) => setClozeUnitsLimit(e.target.value)}
                            className="w-16 h-6 rounded border border-input bg-background px-2 text-xs font-mono text-center tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          />
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          Generates 10 candidate clozes per AI curriculum unit, stores the best 5, and skips units that
                          already have enough generated clozes. Leave blank to process all units; set a small limit for
                          a smoke test.
                        </p>
                      </div>
                      <div className="mt-4 pt-3 border-t border-border/40 space-y-2">
                        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-[0.12em]">
                          Cloze prompt tester
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          Runs a single LLM call with the same system prompt, user prompt, and JSON schema as{" "}
                          <span className="font-mono">Generate clozes</span>. Optional fields mirror a real row&apos;s{" "}
                          <span className="font-mono">curriculumUnit</span> (gloss → definitions, tags, rank, unit
                          type). Nothing is written to the database.
                        </p>
                        <div className="flex flex-wrap items-end gap-2 gap-y-2">
                          <div className="flex flex-col gap-0.5 min-w-[8rem] flex-1">
                            <label
                              htmlFor={`cloze-test-word-${lang.id}`}
                              className="text-[10px] font-mono text-muted-foreground"
                            >
                              Learning unit text
                            </label>
                            <input
                              id={`cloze-test-word-${lang.id}`}
                              type="text"
                              placeholder="e.g. skulle"
                              value={getClozePromptTest(lang.id).lemma}
                              onChange={(e) => patchClozePromptTest(lang.id, { lemma: e.target.value })}
                              className="h-7 rounded border border-input bg-background px-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            />
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <label
                              htmlFor={`cloze-test-pos-${lang.id}`}
                              className="text-[10px] font-mono text-muted-foreground"
                            >
                              POS
                            </label>
                            <select
                              id={`cloze-test-pos-${lang.id}`}
                              value={getClozePromptTest(lang.id).pos}
                              onChange={(e) =>
                                patchClozePromptTest(lang.id, {
                                  pos: e.target.value as ClozePromptTestPos,
                                })
                              }
                              className="h-7 rounded border border-input bg-background px-2 text-xs font-mono max-w-[9.5rem] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              {CLOZE_PROMPT_TEST_POS.map((p) => (
                                <option key={p} value={p}>
                                  {p}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <label
                              htmlFor={`cloze-test-ut-${lang.id}`}
                              className="text-[10px] font-mono text-muted-foreground"
                            >
                              Unit type
                            </label>
                            <select
                              id={`cloze-test-ut-${lang.id}`}
                              value={getClozePromptTest(lang.id).unitType}
                              onChange={(e) =>
                                patchClozePromptTest(lang.id, {
                                  unitType: e.target.value as ClozePromptTestUnitType,
                                })
                              }
                              className="h-7 rounded border border-input bg-background px-2 text-xs font-mono max-w-[8.5rem] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              {CLOZE_PROMPT_TEST_UNIT_TYPES.map((u) => (
                                <option key={u} value={u}>
                                  {u}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex flex-col gap-0.5 flex-1 min-w-[10rem]">
                            <label
                              htmlFor={`cloze-test-gloss-${lang.id}`}
                              className="text-[10px] font-mono text-muted-foreground"
                            >
                              Gloss (optional)
                            </label>
                            <input
                              id={`cloze-test-gloss-${lang.id}`}
                              type="text"
                              placeholder="English hint / first definition line"
                              value={getClozePromptTest(lang.id).gloss}
                              onChange={(e) => patchClozePromptTest(lang.id, { gloss: e.target.value })}
                              className="h-7 rounded border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <div className="flex flex-col gap-0.5 w-14">
                              <label
                                htmlFor={`cloze-test-rank-${lang.id}`}
                                className="text-[10px] font-mono text-muted-foreground"
                              >
                                Rank
                              </label>
                              <input
                                id={`cloze-test-rank-${lang.id}`}
                                type="number"
                                min={0}
                                value={getClozePromptTest(lang.id).rank}
                                onChange={(e) => patchClozePromptTest(lang.id, { rank: e.target.value })}
                                className="h-7 w-full rounded border border-input bg-background px-1 text-xs font-mono tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              />
                            </div>
                            <div className="flex flex-col gap-0.5 min-w-[5.5rem]">
                              <label
                                htmlFor={`cloze-test-n-cand-${lang.id}`}
                                className="text-[10px] font-mono text-muted-foreground"
                              >
                                N cand
                              </label>
                              <input
                                id={`cloze-test-n-cand-${lang.id}`}
                                type="number"
                                min={5}
                                max={20}
                                value={getClozePromptTest(lang.id).candidatesPerUnit}
                                onChange={(e) =>
                                  patchClozePromptTest(lang.id, {
                                    candidatesPerUnit: e.target.value,
                                  })
                                }
                                className="h-7 w-full rounded border border-input bg-background px-1 text-xs font-mono tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              />
                            </div>
                            <div className="flex flex-col gap-0.5 min-w-[5.5rem]">
                              <label
                                htmlFor={`cloze-test-n-sel-${lang.id}`}
                                className="text-[10px] font-mono text-muted-foreground"
                              >
                                N pick
                              </label>
                              <input
                                id={`cloze-test-n-sel-${lang.id}`}
                                type="number"
                                min={1}
                                max={10}
                                value={getClozePromptTest(lang.id).selectedPerUnit}
                                onChange={(e) =>
                                  patchClozePromptTest(lang.id, {
                                    selectedPerUnit: e.target.value,
                                  })
                                }
                                className="h-7 w-full rounded border border-input bg-background px-1 text-xs font-mono tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              />
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <label
                            htmlFor={`cloze-test-tags-${lang.id}`}
                            className="text-[10px] font-mono text-muted-foreground"
                          >
                            Tags (optional, comma-separated)
                          </label>
                          <input
                            id={`cloze-test-tags-${lang.id}`}
                            type="text"
                            placeholder="e.g. common-frequency"
                            value={getClozePromptTest(lang.id).tags}
                            onChange={(e) => patchClozePromptTest(lang.id, { tags: e.target.value })}
                            className="h-7 rounded border border-input bg-background px-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          />
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 text-[11px] px-2 font-mono"
                          disabled={clozePromptPreviewLoading === lang.id || generatingClozes === lang.id}
                          onClick={() => void handlePreviewClozePrompt(lang.id)}
                        >
                          {clozePromptPreviewLoading === lang.id ? "Running…" : "Run prompt preview"}
                        </Button>
                        {clozePromptPreviewByLang[lang.id]?.summary ? (
                          <div className="rounded border border-border/70 bg-background/80 p-2 space-y-2 text-[11px]">
                            <p className="font-mono text-muted-foreground tabular-nums">
                              LLM returned {clozePromptPreviewByLang[lang.id].summary?.returned ?? "—"}; after normalize{" "}
                              {clozePromptPreviewByLang[lang.id].summary?.usable ?? "—"} usable; selection would keep{" "}
                              {clozePromptPreviewByLang[lang.id].summary?.selected ?? "—"}.
                            </p>
                            <details className="group">
                              <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
                                System + user prompts
                              </summary>
                              <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-snug whitespace-pre-wrap break-words">
                                {`--- system ---\n${clozePromptPreviewByLang[lang.id].systemPrompt ?? ""}\n\n--- user ---\n${clozePromptPreviewByLang[lang.id].userPrompt ?? ""}`}
                              </pre>
                            </details>
                            <details className="group">
                              <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
                                Unit JSON sent to the model
                              </summary>
                              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-snug whitespace-pre-wrap break-words">
                                {JSON.stringify(clozePromptPreviewByLang[lang.id].unitJson, null, 2)}
                              </pre>
                            </details>
                            <details className="group">
                              <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
                                Raw candidates
                              </summary>
                              <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-snug whitespace-pre-wrap break-words">
                                {JSON.stringify(clozePromptPreviewByLang[lang.id].candidates, null, 2)}
                              </pre>
                            </details>
                            <details className="group">
                              <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
                                Usable after validation
                              </summary>
                              <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-snug whitespace-pre-wrap break-words">
                                {JSON.stringify(clozePromptPreviewByLang[lang.id].usableCandidates, null, 2)}
                              </pre>
                            </details>
                            <details className="group">
                              <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
                                Selected (job scoring)
                              </summary>
                              <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-snug whitespace-pre-wrap break-words">
                                {JSON.stringify(clozePromptPreviewByLang[lang.id].selectedCandidates, null, 2)}
                              </pre>
                            </details>
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {langJobs.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No jobs yet for this language.</p>
                    ) : (
                      <ul className="space-y-2">
                        {langJobs.map((job) => (
                          <li
                            key={job.id}
                            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs rounded-md border border-border/80 bg-background/60 px-3 py-2"
                          >
                            <span className="font-medium text-foreground">{JOB_TYPE_LABELS[job.type] ?? job.type}</span>
                            <span
                              className={`inline-flex items-center gap-1 font-mono px-2 py-0.5 rounded-full ${STATUS_STYLES[job.status] ?? ""}`}
                            >
                              {job.status === "RUNNING" && (
                                <span className="size-1.5 rounded-full bg-current animate-pulse" />
                              )}
                              {job.status.toLowerCase()}
                            </span>
                            <span className="text-muted-foreground font-mono tabular-nums">
                              {job.totalItems > 0 && job.progress !== null ? (
                                <>{job.progress}%</>
                              ) : job.processedItems > 0 ? (
                                <>{job.processedItems.toLocaleString()} processed</>
                              ) : (
                                "—"
                              )}
                            </span>
                            {job.errorCount > 0 ? (
                              <span className="text-destructive font-mono tabular-nums">err {job.errorCount}</span>
                            ) : null}
                            <span className="text-muted-foreground/80 ml-auto sm:ml-0">
                              {formatJobRelativeTime(job.createdAt)}
                            </span>
                            {job.errorMessage ? (
                              <p
                                className="w-full text-[11px] text-destructive/90 font-mono leading-snug break-all line-clamp-2"
                                title={job.errorMessage}
                              >
                                {job.errorMessage}
                              </p>
                            ) : null}
                            <div className="flex flex-wrap items-center gap-1 w-full sm:w-auto sm:ml-auto justify-end">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px] px-2 font-mono"
                                onClick={() =>
                                  setOutputJob({
                                    id: job.id,
                                    title: JOB_TYPE_LABELS[job.type] ?? job.type,
                                  })
                                }
                              >
                                Output
                              </Button>
                              {(job.status === "PENDING" || job.status === "RUNNING") && (
                                <>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-[11px] px-2 font-mono text-muted-foreground border-dashed"
                                    disabled={skippingJobId !== null}
                                    title={
                                      job.chainPipeline
                                        ? "Mark complete and enqueue the next pipeline job."
                                        : "Mark complete without chaining."
                                    }
                                    onClick={() => handleJobSkipAndChain(job.id)}
                                  >
                                    {skippingJobId === job.id ? "…" : "Skip → next"}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-[11px] px-2 text-muted-foreground hover:text-destructive"
                                    onClick={() => handleJobCancel(job.id)}
                                  >
                                    Cancel
                                  </Button>
                                </>
                              )}
                              {(job.status === "FAILED" || job.status === "CANCELLED") && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="h-7 text-[11px] px-2"
                                  disabled={requeueJobId !== null}
                                  onClick={() => handleJobRetry(job.id)}
                                >
                                  {requeueJobId === job.id ? "…" : "Retry"}
                                </Button>
                              )}
                              {job.status === "COMPLETED" && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="h-7 text-[11px] px-2"
                                  disabled={requeueJobId !== null}
                                  title="Enqueue again from the same source."
                                  onClick={() => handleJobRerun(job.id)}
                                >
                                  {requeueJobId === job.id ? "…" : "Re-run"}
                                </Button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {hasActiveIngestJobs ? (
        <p className="text-xs text-muted-foreground text-center">
          Auto-refreshing job status every 3 seconds while work is running…
        </p>
      ) : null}
    </div>
  );
}
