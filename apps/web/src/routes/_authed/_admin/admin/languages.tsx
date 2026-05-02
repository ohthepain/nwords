import { app } from "@nwords/api"
import { prisma } from "@nwords/db"
import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { useEffect, useMemo, useState } from "react"
import { JobOutputViewer } from "~/components/job-output-viewer"
import { Button } from "~/components/ui/button"
import {
	JOB_TYPE_LABELS,
	STATUS_STYLES,
	formatJobRelativeTime,
	jobMetadataError,
} from "~/lib/admin-ingest-jobs"
import { forwardedAdminApiHeaders } from "~/lib/server-admin-api"

const JOBS_PER_LANGUAGE = 20
const MAX_JOB_FETCH = 400

type LanguageAdminRow = {
	id: string
	code: string
	name: string
	enabled: boolean
	wordCount: number
	aiWordCount: number
	sentenceCount: number
}

type LanguageIngestJobRow = {
	id: string
	type: string
	status: string
	totalItems: number
	processedItems: number
	errorCount: number
	progress: number | null
	createdAt: string
	chainPipeline: boolean
	/** Populated from `metadata.error` when the worker records a failure. */
	errorMessage: string | null
}

/** Newest first; break ties by id so list order is stable across refreshes. */
function compareIngestJobsForDisplay(a: LanguageIngestJobRow, b: LanguageIngestJobRow): number {
	if (a.createdAt > b.createdAt) return -1
	if (a.createdAt < b.createdAt) return 1
	if (a.id > b.id) return -1
	if (a.id < b.id) return 1
	return 0
}

const loadAdminLanguagesPage = createServerFn({ method: "GET" }).handler(async () => {
	const languagesRaw = await prisma.language.findMany({
		orderBy: { name: "asc" },
		include: {
			_count: { select: { words: true, sentences: true } },
		},
	})
	const wordSourceCounts = await prisma.word.groupBy({
		by: ["languageId", "curriculumSource"],
		_count: { _all: true },
	})
	const aiWordCountsByLanguageId = new Map(
		wordSourceCounts
			.filter((row) => row.curriculumSource === "AI_CURRICULUM")
			.map((row) => [row.languageId, row._count._all]),
	)

	const languages: LanguageAdminRow[] = languagesRaw.map((l) => ({
		id: l.id,
		code: l.code,
		name: l.name,
		enabled: l.enabled,
		wordCount: l._count.words,
		aiWordCount: aiWordCountsByLanguageId.get(l.id) ?? 0,
		sentenceCount: l._count.sentences,
	}))

	const enabledIds = languages.filter((l) => l.enabled).map((l) => l.id)
	const jobsByLanguageId: Record<string, LanguageIngestJobRow[]> = {}
	for (const id of enabledIds) {
		jobsByLanguageId[id] = []
	}

	if (enabledIds.length > 0) {
		const jobs = await prisma.ingestionJob.findMany({
			where: { languageId: { in: enabledIds } },
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: MAX_JOB_FETCH,
		})

		const counts: Record<string, number> = {}
		for (const id of enabledIds) counts[id] = 0

		for (const j of jobs) {
			if (counts[j.languageId] >= JOBS_PER_LANGUAGE) continue
			counts[j.languageId]++
			const progressPct =
				j.totalItems > 0 ? Math.round((j.processedItems / j.totalItems) * 100) : null
			const jmeta = j.metadata as Record<string, unknown> | null
			jobsByLanguageId[j.languageId].push({
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
			})
		}

		for (const id of enabledIds) {
			jobsByLanguageId[id].sort(compareIngestJobsForDisplay)
		}
	}

	return { languages, jobsByLanguageId }
})

const toggleLanguage = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string; enabled: boolean }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const json = JSON.stringify({ enabled: data.enabled })
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/toggle`, {
				method: "PATCH",
				headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
				body: json,
			}),
		)
		const body = (await res.json().catch(() => ({}))) as {
			error?: string
			pipelineJobId?: string | null
		}
		if (!res.ok) {
			throw new Error(body.error ?? `Toggle failed (${res.status})`)
		}
		return { success: true, pipelineJobId: body.pipelineJobId ?? null }
	})

const runLanguagePipeline = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/run-pipeline`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request),
			}),
		)
		const body = (await res.json().catch(() => ({}))) as {
			error?: string
			pipelineJobId?: string
		}
		if (!res.ok) {
			throw new Error(body.error ?? `Pipeline failed (${res.status})`)
		}
		return { success: true, pipelineJobId: body.pipelineJobId }
	})

const runAiVocabPipeline = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/run-ai-vocab-pipeline`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request),
			}),
		)
		const body = (await res.json().catch(() => ({}))) as {
			error?: string
			pipelineJobId?: string
		}
		if (!res.ok) {
			throw new Error(body.error ?? `Common words job failed (${res.status})`)
		}
		return { success: true, pipelineJobId: body.pipelineJobId }
	})

const runLlmVocabFromCommonWords = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const json = JSON.stringify({})
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/run-llm-vocab-from-common-words`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
				body: json,
			}),
		)
		const body = (await res.json().catch(() => ({}))) as {
			error?: string
			pipelineJobId?: string
		}
		if (!res.ok) {
			throw new Error(body.error ?? `LLM vocabulary job failed (${res.status})`)
		}
		return { success: true, pipelineJobId: body.pipelineJobId }
	})

const runVocabCleanup = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string; dryRun: boolean }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const json = JSON.stringify({ dryRun: data.dryRun })
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/run-vocab-cleanup`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
				body: json,
			}),
		)
		const body = (await res.json().catch(() => ({}))) as { error?: string; jobId?: string }
		if (!res.ok) {
			throw new Error(body.error ?? `Vocab cleanup failed (${res.status})`)
		}
		return { success: true, jobId: body.jobId ?? null }
	})

const generateFixedExpressions = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const json = JSON.stringify({ languageId: data.id })
		const res = await app.fetch(
			new Request(`${origin}/api/admin/jobs/fixed-expressions`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
				body: json,
			}),
		)
		const body = (await res.json().catch(() => ({}))) as { error?: string; id?: string }
		if (!res.ok) {
			throw new Error(body.error ?? `Fixed expressions job failed (${res.status})`)
		}
		return { success: true, jobId: body.id ?? null }
	})

const generateClozes = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string; unitsLimit?: number }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const json = JSON.stringify({
			languageId: data.id,
			...(data.unitsLimit !== undefined ? { unitsLimit: data.unitsLimit } : {}),
			resetExisting: false,
		})
		const res = await app.fetch(
			new Request(`${origin}/api/admin/jobs/cloze-generation`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
				body: json,
			}),
		)
		const body = (await res.json().catch(() => ({}))) as { error?: string; id?: string }
		if (!res.ok) {
			throw new Error(body.error ?? `Cloze generation job failed (${res.status})`)
		}
		return { success: true, jobId: body.id ?? null }
	})

const clearLanguageSentenceLinks = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/clear-sentence-links`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request),
			}),
		)
		const body = (await res.json().catch(() => ({}))) as {
			error?: string
			sentenceWordsRemoved?: number
			sentencesReset?: number
			wordsCleared?: number
		}
		if (!res.ok) {
			throw new Error(body.error ?? `Clear failed (${res.status})`)
		}
		return {
			sentenceWordsRemoved: body.sentenceWordsRemoved ?? 0,
			sentencesReset: body.sentencesReset ?? 0,
			wordsCleared: body.wordsCleared ?? 0,
		}
	})

const clearGeneratedClozes = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/clear-generated-clozes`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request),
			}),
		)
		const body = (await res.json().catch(() => ({}))) as {
			error?: string
			generatedClozesDeleted?: number
			wordsCleared?: number
			sentenceWordScoresCleared?: number
			aiSentencesDeleted?: number
		}
		if (!res.ok) {
			throw new Error(body.error ?? `Clear clozes failed (${res.status})`)
		}
		return {
			generatedClozesDeleted: body.generatedClozesDeleted ?? 0,
			wordsCleared: body.wordsCleared ?? 0,
			sentenceWordScoresCleared: body.sentenceWordScoresCleared ?? 0,
			aiSentencesDeleted: body.aiSentencesDeleted ?? 0,
		}
	})

const clearVocabulary = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const res = await app.fetch(
			new Request(`${origin}/api/admin/languages/${data.id}/clear-vocabulary`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request),
			}),
		)
		const body = (await res.json().catch(() => ({}))) as {
			error?: string
			wordsDeleted?: number
			generatedClozesDeleted?: number
			clozeReportsDeleted?: number
			userKnowledgeDeleted?: number
			sentenceWordsDeleted?: number
			wordFormsDeleted?: number
			synonymPairsDeleted?: number
		}
		if (!res.ok) {
			throw new Error(body.error ?? `Clear vocabulary failed (${res.status})`)
		}
		return {
			wordsDeleted: body.wordsDeleted ?? 0,
			generatedClozesDeleted: body.generatedClozesDeleted ?? 0,
			clozeReportsDeleted: body.clozeReportsDeleted ?? 0,
			userKnowledgeDeleted: body.userKnowledgeDeleted ?? 0,
			sentenceWordsDeleted: body.sentenceWordsDeleted ?? 0,
			wordFormsDeleted: body.wordFormsDeleted ?? 0,
			synonymPairsDeleted: body.synonymPairsDeleted ?? 0,
		}
	})

export const Route = createFileRoute("/_authed/_admin/admin/languages")({
	loader: () => loadAdminLanguagesPage(),
	component: AdminLanguagesPage,
})

function AdminLanguagesPage() {
	const router = useRouter()
	const { languages, jobsByLanguageId } = Route.useLoaderData()
	const [toggling, setToggling] = useState<string | null>(null)
	const [runningPipeline, setRunningPipeline] = useState<string | null>(null)
	const [runningAiVocab, setRunningAiVocab] = useState<string | null>(null)
	const [runningLlmVocab, setRunningLlmVocab] = useState<string | null>(null)
	const [generatingFixedExpr, setGeneratingFixedExpr] = useState<string | null>(null)
	const [generatingClozes, setGeneratingClozes] = useState<string | null>(null)
	const [clozeUnitsLimit, setClozeUnitsLimit] = useState("")
	const [runningVocabCleanup, setRunningVocabCleanup] = useState<{
		langId: string
		dryRun: boolean
	} | null>(null)
	const [clearingLinksId, setClearingLinksId] = useState<string | null>(null)
	const [clearingClozesId, setClearingClozesId] = useState<string | null>(null)
	const [clearingVocabId, setClearingVocabId] = useState<string | null>(null)
	const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
	const [jobActionError, setJobActionError] = useState<string | null>(null)
	const [requeueJobId, setRequeueJobId] = useState<string | null>(null)
	const [skippingJobId, setSkippingJobId] = useState<string | null>(null)
	const [skipJobError, setSkipJobError] = useState<string | null>(null)
	const [outputJob, setOutputJob] = useState<{ id: string; title: string } | null>(null)

	const enabledJobsFlat = useMemo(() => {
		const out: LanguageIngestJobRow[] = []
		for (const lang of languages) {
			if (!lang.enabled) continue
			out.push(...(jobsByLanguageId[lang.id] ?? []))
		}
		return out
	}, [languages, jobsByLanguageId])

	const hasActiveIngestJobs = enabledJobsFlat.some(
		(j) => j.status === "RUNNING" || j.status === "PENDING",
	)

	useEffect(() => {
		if (!hasActiveIngestJobs) return
		const interval = setInterval(() => {
			router.invalidate()
		}, 3000)
		return () => clearInterval(interval)
	}, [hasActiveIngestJobs, router])

	const enabledCount = languages.filter((l) => l.enabled).length
	const withWords = languages.filter((l) => l.wordCount > 0).length

	async function handleToggle(id: string, currentlyEnabled: boolean) {
		setNotice(null)
		setToggling(id)
		try {
			const out = await toggleLanguage({ data: { id, enabled: !currentlyEnabled } })
			if (out.pipelineJobId) {
				setNotice({
					kind: "ok",
					text: `Ingestion started — job ${out.pipelineJobId.slice(0, 8)}… See jobs below (when this language is on) or the full list on Jobs.`,
				})
			}
		} catch (e) {
			setNotice({ kind: "err", text: e instanceof Error ? e.message : "Toggle failed" })
		} finally {
			setToggling(null)
		}
		await router.invalidate()
	}

	async function handleRunPipeline(id: string) {
		setNotice(null)
		setRunningPipeline(id)
		try {
			const out = await runLanguagePipeline({ data: { id } })
			setNotice({
				kind: "ok",
				text: out.pipelineJobId
					? `Pipeline queued — job ${out.pipelineJobId.slice(0, 8)}… Progress appears below and on Jobs.`
					: "Pipeline queued. Progress appears below and on Jobs.",
			})
		} catch (e) {
			setNotice({ kind: "err", text: e instanceof Error ? e.message : "Pipeline failed" })
		} finally {
			setRunningPipeline(null)
		}
		await router.invalidate()
	}

	async function handleRunAiVocab(id: string) {
		setNotice(null)
		setRunningAiVocab(id)
		try {
			const out = await runAiVocabPipeline({ data: { id } })
			setNotice({
				kind: "ok",
				text: out.pipelineJobId
					? `Common words job queued — ${out.pipelineJobId.slice(0, 8)}… Review topLemmas in job output/metadata, then run LLM vocabulary.`
					: "Common words job queued.",
			})
		} catch (e) {
			setNotice({
				kind: "err",
				text: e instanceof Error ? e.message : "Common words job failed",
			})
		} finally {
			setRunningAiVocab(null)
		}
		await router.invalidate()
	}

	async function handleRunLlmVocab(id: string) {
		setNotice(null)
		setRunningLlmVocab(id)
		try {
			const out = await runLlmVocabFromCommonWords({ data: { id } })
			setNotice({
				kind: "ok",
				text: out.pipelineJobId
					? `LLM vocabulary queued — ${out.pipelineJobId.slice(0, 8)}… Uses the latest completed Common words job for this language.`
					: "LLM vocabulary queued.",
			})
		} catch (e) {
			setNotice({
				kind: "err",
				text: e instanceof Error ? e.message : "LLM vocabulary job failed",
			})
		} finally {
			setRunningLlmVocab(null)
		}
		await router.invalidate()
	}

	async function handleGenerateFixedExpressions(id: string) {
		setNotice(null)
		setGeneratingFixedExpr(id)
		try {
			const out = await generateFixedExpressions({ data: { id } })
			setNotice({
				kind: "ok",
				text: out.jobId
					? `Fixed expressions job queued — ${out.jobId.slice(0, 8)}… Progress appears below and on Jobs.`
					: "Fixed expressions job queued.",
			})
		} catch (e) {
			setNotice({
				kind: "err",
				text: e instanceof Error ? e.message : "Fixed expressions job failed",
			})
		} finally {
			setGeneratingFixedExpr(null)
		}
		await router.invalidate()
	}

	async function handleGenerateClozes(id: string) {
		setNotice(null)
		setGeneratingClozes(id)
		try {
			const parsedLimit = Number.parseInt(clozeUnitsLimit, 10)
			const out = await generateClozes({
				data: {
					id,
					...(Number.isFinite(parsedLimit) && parsedLimit > 0 ? { unitsLimit: parsedLimit } : {}),
				},
			})
			setNotice({
				kind: "ok",
				text: out.jobId
					? `Cloze generation queued — ${out.jobId.slice(0, 8)}… Progress appears below and on Jobs.`
					: "Cloze generation queued.",
			})
		} catch (e) {
			setNotice({
				kind: "err",
				text: e instanceof Error ? e.message : "Cloze generation failed",
			})
		} finally {
			setGeneratingClozes(null)
		}
		await router.invalidate()
	}

	async function handleVocabCleanup(id: string, dryRun: boolean) {
		setNotice(null)
		setRunningVocabCleanup({ langId: id, dryRun })
		try {
			const out = await runVocabCleanup({ data: { id, dryRun } })
			setNotice({
				kind: "ok",
				text: out.jobId
					? dryRun
						? `Vocab cleanup preview queued — ${out.jobId.slice(0, 8)}… Open Output → Preview when done.`
						: `Vocab cleanup (apply) queued — ${out.jobId.slice(0, 8)}… Updates ranks when done.`
					: "Vocab cleanup queued.",
			})
		} catch (e) {
			setNotice({
				kind: "err",
				text: e instanceof Error ? e.message : "Vocab cleanup failed",
			})
		} finally {
			setRunningVocabCleanup(null)
		}
		await router.invalidate()
	}

	async function handleClearSentenceLinks(id: string, name: string) {
		if (
			!globalThis.confirm(
				`Clear sentence links for ${name}? This removes word↔sentence links, resets sentence test scores, and empties curated test sentences on every word in this language. Tatoeba sentence text and translation pairs are kept. Run Re-import (or enqueue Tatoeba Sentences with linking) afterward to rebuild links.`,
			)
		) {
			return
		}
		setNotice(null)
		setClearingLinksId(id)
		try {
			const out = await clearLanguageSentenceLinks({ data: { id } })
			setNotice({
				kind: "ok",
				text: `Cleared ${out.sentenceWordsRemoved.toLocaleString()} word–sentence links; reset ${out.sentencesReset.toLocaleString()} sentences; updated ${out.wordsCleared.toLocaleString()} words. Queue Tatoeba / Re-import to relink.`,
			})
		} catch (e) {
			setNotice({ kind: "err", text: e instanceof Error ? e.message : "Clear failed" })
		} finally {
			setClearingLinksId(null)
		}
		await router.invalidate()
	}

	async function handleClearGeneratedClozes(id: string, name: string) {
		if (
			!globalThis.confirm(
				`Clear generated clozes for ${name}? This deletes generated cloze rows and clears cloze-generation metadata, so the next cloze generation run starts fresh.`,
			)
		) {
			return
		}
		setNotice(null)
		setClearingClozesId(id)
		try {
			const out = await clearGeneratedClozes({ data: { id } })
			setNotice({
				kind: "ok",
				text: `Cleared ${out.generatedClozesDeleted.toLocaleString()} generated cloze(s); reset ${out.wordsCleared.toLocaleString()} word row(s).`,
			})
		} catch (e) {
			setNotice({ kind: "err", text: e instanceof Error ? e.message : "Clear clozes failed" })
		} finally {
			setClearingClozesId(null)
		}
		await router.invalidate()
	}

	async function handleClearVocabulary(id: string, name: string) {
		if (
			!globalThis.confirm(
				`Clear ALL vocabulary for ${name}? This deletes every word row for this language, plus generated clozes, word forms, sentence links, user knowledge, synonym pairs, and cloze issue reports tied to those words. This cannot be undone.`,
			)
		) {
			return
		}
		setNotice(null)
		setClearingVocabId(id)
		try {
			const out = await clearVocabulary({ data: { id } })
			setNotice({
				kind: "ok",
				text: `Deleted ${out.wordsDeleted.toLocaleString()} vocabulary word(s), ${out.generatedClozesDeleted.toLocaleString()} generated cloze(s), ${out.wordFormsDeleted.toLocaleString()} word form(s), ${out.sentenceWordsDeleted.toLocaleString()} sentence link(s), ${out.userKnowledgeDeleted.toLocaleString()} user knowledge row(s), ${out.synonymPairsDeleted.toLocaleString()} synonym pair(s), and ${out.clozeReportsDeleted.toLocaleString()} cloze report(s).`,
			})
		} catch (e) {
			setNotice({
				kind: "err",
				text: e instanceof Error ? e.message : "Clear vocabulary failed",
			})
		} finally {
			setClearingVocabId(null)
		}
		await router.invalidate()
	}

	async function handleJobCancel(jobId: string) {
		setJobActionError(null)
		await fetch(`/api/admin/jobs/${jobId}/cancel`, {
			method: "POST",
			credentials: "include",
		})
		await router.invalidate()
	}

	async function handleJobSkipAndChain(jobId: string) {
		setJobActionError(null)
		setSkipJobError(null)
		if (
			!globalThis.confirm(
				"Mark this job complete (assume data is already in the database) and continue the pipeline when chaining is enabled? The worker stops on its next check.",
			)
		) {
			return
		}
		setSkippingJobId(jobId)
		try {
			const res = await fetch(`/api/admin/jobs/${jobId}/skip-and-chain`, {
				method: "POST",
				credentials: "include",
			})
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			if (!res.ok) {
				setSkipJobError(body.error ?? `Skip failed (${res.status})`)
				return
			}
			await router.invalidate()
		} finally {
			setSkippingJobId(null)
		}
	}

	async function handleJobRetry(jobId: string) {
		setJobActionError(null)
		setRequeueJobId(jobId)
		try {
			const res = await fetch(`/api/admin/jobs/${jobId}/retry`, {
				method: "POST",
				credentials: "include",
			})
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			if (!res.ok) {
				setJobActionError(body.error ?? `Retry failed (${res.status})`)
				return
			}
			await router.invalidate()
		} finally {
			setRequeueJobId(null)
		}
	}

	async function handleJobRerun(jobId: string) {
		if (
			!globalThis.confirm(
				"Queue a new run using this job’s saved file/URLs? The completed job stays in the list.",
			)
		) {
			return
		}
		setJobActionError(null)
		setRequeueJobId(jobId)
		try {
			const res = await fetch(`/api/admin/jobs/${jobId}/rerun`, {
				method: "POST",
				credentials: "include",
			})
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			if (!res.ok) {
				setJobActionError(body.error ?? `Re-run failed (${res.status})`)
				return
			}
			await router.invalidate()
		} finally {
			setRequeueJobId(null)
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
					When a language is <strong className="text-foreground font-medium">on</strong>, recent{" "}
					<strong className="text-foreground font-medium">ingestion jobs</strong> for that language
					appear below the row (Output / Skip → next / Cancel / Retry / Re-run). For a full list see{" "}
					<Link
						to="/admin/jobs"
						className="underline underline-offset-2 hover:text-foreground font-medium text-foreground/90"
					>
						Jobs
					</Link>
					. Turning a language on with no words starts the pipeline automatically; use{" "}
					<strong className="text-foreground font-medium">Common words</strong> then{" "}
					<strong className="text-foreground font-medium">LLM vocabulary</strong>, or{" "}
					<strong className="text-foreground font-medium">Legacy</strong> (Kaikki → frequency →
					Tatoeba when <code className="text-xs">VOCAB_PIPELINE=legacy</code>). Turning a language
					on with no words starts{" "}
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
					Re-order <strong className="text-foreground font-medium">AI curriculum</strong> units so
					the same spelling with different parts of speech (different senses) are spaced apart in
					the list. Uses your curated{" "}
					<strong className="text-foreground font-medium">common words</strong> order to pick the
					primary sense when needed. In the{" "}
					<strong className="text-foreground font-medium">Import</strong> column, use{" "}
					<strong className="text-foreground font-medium">Cleanup preview</strong> (no DB changes;
					open <strong className="text-foreground">Output → Preview</strong> when done) or{" "}
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
						const langJobs = jobsByLanguageId[lang.id] ?? []
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
													clearingClozesId === lang.id ||
													clearingVocabId === lang.id ||
													toggling === lang.id ||
													runningPipeline === lang.id ||
													runningAiVocab === lang.id ||
													runningLlmVocab === lang.id ||
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
													clearingClozesId === lang.id ||
													clearingVocabId === lang.id ||
													runningAiVocab === lang.id ||
													runningLlmVocab === lang.id ||
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
										<span className="block text-[10px] text-muted-foreground">
											AI {lang.aiWordCount.toLocaleString()}
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
												runningVocabCleanup?.langId === lang.id ||
												toggling === lang.id
											}
											onClick={() => void handleVocabCleanup(lang.id, true)}
										>
											{runningVocabCleanup?.langId === lang.id && runningVocabCleanup.dryRun
												? "…"
												: "Cleanup preview"}
										</Button>
										<Button
											variant="secondary"
											size="sm"
											className="h-7 text-xs px-2 font-mono w-full max-w-[11rem]"
											disabled={
												runningPipeline === lang.id ||
												runningAiVocab === lang.id ||
												runningLlmVocab === lang.id ||
												runningVocabCleanup?.langId === lang.id ||
												toggling === lang.id
											}
											onClick={() => {
												if (
													!window.confirm(
														"Apply vocabulary cleanup? This updates word ranks in the database.",
													)
												)
													return
												void handleVocabCleanup(lang.id, false)
											}}
										>
											{runningVocabCleanup?.langId === lang.id && !runningVocabCleanup.dryRun
												? "…"
												: "Cleanup apply"}
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
													{generatingFixedExpr === lang.id
														? "Generating…"
														: "Generate fixed expressions"}
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
													Generates 10 candidate clozes per AI curriculum unit, stores the best 5,
													and skips units that already have enough generated clozes. Leave blank to
													process all units; set a small limit for a smoke test.
												</p>
											</div>
										</div>
										{langJobs.length === 0 ? (
											<p className="text-xs text-muted-foreground">
												No jobs yet for this language.
											</p>
										) : (
											<ul className="space-y-2">
												{langJobs.map((job) => (
													<li
														key={job.id}
														className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs rounded-md border border-border/80 bg-background/60 px-3 py-2"
													>
														<span className="font-medium text-foreground">
															{JOB_TYPE_LABELS[job.type] ?? job.type}
														</span>
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
															<span className="text-destructive font-mono tabular-nums">
																err {job.errorCount}
															</span>
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
						)
					})}
				</div>
			</div>

			{hasActiveIngestJobs ? (
				<p className="text-xs text-muted-foreground text-center">
					Auto-refreshing job status every 3 seconds while work is running…
				</p>
			) : null}
		</div>
	)
}
