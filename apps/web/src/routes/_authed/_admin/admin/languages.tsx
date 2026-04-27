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

	const languages: LanguageAdminRow[] = languagesRaw.map((l) => ({
		id: l.id,
		code: l.code,
		name: l.name,
		enabled: l.enabled,
		wordCount: l._count.words,
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

const assessClozeQuality = createServerFn({ method: "POST" })
	.inputValidator((data: { id: string; maxSentencesPerWord: number }) => data)
	.handler(async ({ data }) => {
		const request = getRequest()
		if (!request) {
			throw new Error("Missing request context")
		}
		const origin = new URL(request.url).origin
		const json = JSON.stringify({
			languageId: data.id,
			maxSentencesPerWord: data.maxSentencesPerWord,
		})
		const res = await app.fetch(
			new Request(`${origin}/api/admin/jobs/cloze-quality-assessment`, {
				method: "POST",
				headers: forwardedAdminApiHeaders(request, { jsonBody: json }),
				body: json,
			}),
		)
		const body = (await res.json().catch(() => ({}))) as { error?: string; id?: string }
		if (!res.ok) {
			throw new Error(body.error ?? `Cloze quality assessment job failed (${res.status})`)
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

export const Route = createFileRoute("/_authed/_admin/admin/languages")({
	loader: () => loadAdminLanguagesPage(),
	component: AdminLanguagesPage,
})

function AdminLanguagesPage() {
	const router = useRouter()
	const { languages, jobsByLanguageId } = Route.useLoaderData()
	const [toggling, setToggling] = useState<string | null>(null)
	const [runningPipeline, setRunningPipeline] = useState<string | null>(null)
	const [generatingFixedExpr, setGeneratingFixedExpr] = useState<string | null>(null)
	const [assessingClozeQuality, setAssessingClozeQuality] = useState<string | null>(null)
	const [clozeMaxSentences, setClozeMaxSentences] = useState(30)
	const [clearingLinksId, setClearingLinksId] = useState<string | null>(null)
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

	async function handleAssessClozeQuality(id: string) {
		setNotice(null)
		setAssessingClozeQuality(id)
		try {
			const out = await assessClozeQuality({ data: { id, maxSentencesPerWord: clozeMaxSentences } })
			setNotice({
				kind: "ok",
				text: out.jobId
					? `Cloze quality assessment queued — ${out.jobId.slice(0, 8)}… Progress appears below and on Jobs.`
					: "Cloze quality assessment queued.",
			})
		} catch (e) {
			setNotice({
				kind: "err",
				text: e instanceof Error ? e.message : "Cloze quality assessment failed",
			})
		} finally {
			setAssessingClozeQuality(null)
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
					<strong className="text-foreground font-medium">Re-import</strong> to run it again.
				</p>
				<p className="text-xs">
					Pipeline: Kaikki.org (four{" "}
					<a
						href="https://kaikki.org/dictionary/Italian/pos-noun/index.html"
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-2 hover:text-foreground"
					>
						pos-noun
					</a>
					-style JSONL streams when available, else one full dump) → frequency ranks (HermitDave or
					bnpd) → Tatoeba sentences (ISO 639-3 required).
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

			{/* Table */}
			<div className="border border-border rounded-lg overflow-hidden">
				<div className="grid grid-cols-[1fr_90px_90px_100px_108px] gap-4 text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em] px-4 py-2.5 bg-muted/50 border-b border-border">
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
								<div className="grid grid-cols-[1fr_90px_90px_100px_108px] gap-4 items-center px-4 py-2.5 hover:bg-muted/30 transition-colors">
									<div className="flex flex-col gap-1 min-w-0">
										<div className="flex items-center gap-3 min-w-0">
											<span className="text-sm font-medium truncate">{lang.name}</span>
											<span className="text-xs font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5 shrink-0">
												{lang.code}
											</span>
										</div>
										<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
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
													toggling === lang.id ||
													runningPipeline === lang.id ||
													lang.sentenceCount === 0
												}
												className="text-destructive/90 hover:text-destructive hover:underline underline-offset-2 disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
												onClick={() => handleClearSentenceLinks(lang.id, lang.name)}
											>
												{clearingLinksId === lang.id ? "Clearing…" : "Clear sentence links"}
											</button>
										</div>
									</div>
									<span className="text-sm font-mono text-right tabular-nums">
										{lang.wordCount > 0 ? (
											lang.wordCount.toLocaleString()
										) : (
											<span className="text-muted-foreground">—</span>
										)}
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
											disabled={toggling === lang.id || runningPipeline === lang.id}
											onClick={() => handleToggle(lang.id, lang.enabled)}
										>
											{lang.enabled ? "On" : "Off"}
										</Button>
									</div>
									<div className="flex justify-end">
										<Button
											variant="secondary"
											size="sm"
											className="h-7 text-xs px-2 font-mono"
											disabled={runningPipeline === lang.id || toggling === lang.id}
											onClick={() => handleRunPipeline(lang.id)}
										>
											{runningPipeline === lang.id ? "…" : "Re-import"}
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
													disabled={assessingClozeQuality === lang.id}
													onClick={() => handleAssessClozeQuality(lang.id)}
												>
													{assessingClozeQuality === lang.id ? "Queuing…" : "Assess cloze quality"}
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
														Max sentences/word
													</label>
													<input
														id={`cloze-max-${lang.id}`}
														type="number"
														min={1}
														max={500}
														value={clozeMaxSentences}
														onChange={(e) =>
															setClozeMaxSentences(
																Math.max(1, Math.min(500, Number(e.target.value) || 30)),
															)
														}
														className="w-16 h-6 rounded border border-input bg-background px-2 text-xs font-mono text-center tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
													/>
												</div>
												<p className="text-[11px] text-muted-foreground leading-relaxed">
													Limits how many cloze sentences are sent to the AI per word.
													High-frequency words can have hundreds of sentences — capping this keeps
													costs predictable and avoids overloading the prompt. 30 is usually enough
													to find the best examples.
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
