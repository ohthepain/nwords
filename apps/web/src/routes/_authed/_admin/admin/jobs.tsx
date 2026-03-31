import { prisma } from "@nwords/db"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { useEffect, useRef, useState } from "react"
import { JobOutputViewer } from "~/components/job-output-viewer"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import {
	JOB_TYPE_LABELS,
	STATUS_STYLES,
	formatJobRelativeTime,
	jobMetadataError,
	stripJobLogsFromMetadata,
} from "~/lib/admin-ingest-jobs"

// ─── Server Functions ────────────────────────────────────

const getJobs = createServerFn({ method: "GET" }).handler(async () => {
	const jobs = await prisma.ingestionJob.findMany({
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: 50,
	})

	// Get language names
	const languageIds = [...new Set(jobs.map((j) => j.languageId))]
	const languages = await prisma.language.findMany({
		where: { id: { in: languageIds } },
		select: { id: true, name: true, code: true },
	})
	const langMap = new Map(languages.map((l) => [l.id, l]))

	return jobs.map((j) => {
		const meta = j.metadata as Record<string, unknown> | null
		const ingestSpeed = meta?.ingestSpeed as { itemsPerSecond?: number } | undefined
		const itemsPerSecond = ingestSpeed?.itemsPerSecond ?? null
		const progressPct =
			j.totalItems > 0 ? Math.round((j.processedItems / j.totalItems) * 100) : null

		const metadata = stripJobLogsFromMetadata(j.metadata) as Record<string, object> | null
		const chainPipeline = meta?.chainPipeline === true
		return {
			id: j.id,
			type: j.type,
			languageId: j.languageId,
			languageName: langMap.get(j.languageId)?.name ?? "Unknown",
			languageCode: langMap.get(j.languageId)?.code ?? "??",
			status: j.status,
			totalItems: j.totalItems,
			processedItems: j.processedItems,
			errorCount: j.errorCount,
			progress: progressPct,
			itemsPerSecond,
			startedAt: j.startedAt?.toISOString() ?? null,
			completedAt: j.completedAt?.toISOString() ?? null,
			createdAt: j.createdAt.toISOString(),
			metadata,
			chainPipeline,
			errorMessage: jobMetadataError(j.metadata),
		}
	})
})

const getLanguages = createServerFn({ method: "GET" }).handler(async () => {
	const languages = await prisma.language.findMany({
		where: { enabled: true },
		orderBy: { name: "asc" },
		select: { id: true, name: true, code: true },
	})
	return languages
})

// ─── Route ───────────────────────────────────────────────

export const Route = createFileRoute("/_authed/_admin/admin/jobs")({
	loader: async () => {
		const [jobs, languages] = await Promise.all([getJobs(), getLanguages()])
		return { jobs, languages }
	},
	component: AdminJobsPage,
})

// ─── Speedometer ─────────────────────────────────────────

function IngestSpeedometer({
	itemsPerSecond,
	active,
}: {
	itemsPerSecond: number | null
	active: boolean
}) {
	const ips = itemsPerSecond ?? 0
	if (active && ips <= 0) {
		return (
			<span
				className="text-[10px] font-mono text-brand animate-pulse tabular-nums"
				title="Sampling…"
			>
				···
			</span>
		)
	}
	if (!active && ips <= 0) {
		return <span className="text-muted-foreground text-xs font-mono">—</span>
	}
	const max = 12_000
	const pct = Math.min(1, ips / max)
	const dash = `${(pct * 88).toFixed(1)} 88`

	return (
		<div
			className="relative size-[3.25rem] shrink-0"
			title={ips > 0 ? `~${Math.round(ips)} items / second` : "Sampling speed…"}
		>
			<svg viewBox="0 0 40 40" className="size-full">
				<title>Ingestion speed</title>
				<circle cx="20" cy="20" r="16" fill="none" className="stroke-muted/60" strokeWidth="3" />
				<circle
					cx="20"
					cy="20"
					r="16"
					fill="none"
					className="stroke-brand transition-all duration-700"
					strokeWidth="3"
					strokeLinecap="round"
					strokeDasharray={dash}
					transform="rotate(-90 20 20)"
				/>
			</svg>
			<span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-semibold tabular-nums text-foreground pointer-events-none">
				{ips >= 1000 ? `${(ips / 1000).toFixed(1)}k` : Math.round(ips)}
			</span>
		</div>
	)
}

// ─── Component ───────────────────────────────────────────

function AdminJobsPage() {
	const { jobs, languages } = Route.useLoaderData()
	const router = useRouter()

	const [showForm, setShowForm] = useState(false)
	const [uploading, setUploading] = useState(false)
	const [uploadError, setUploadError] = useState<string | null>(null)
	const [retryError, setRetryError] = useState<string | null>(null)
	const [requeueJobId, setRequeueJobId] = useState<string | null>(null)
	const [skippingJobId, setSkippingJobId] = useState<string | null>(null)
	const [skipError, setSkipError] = useState<string | null>(null)
	const [outputJob, setOutputJob] = useState<{ id: string; title: string } | null>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)

	// Auto-refresh when jobs are running
	const hasRunning = jobs.some((j) => j.status === "RUNNING" || j.status === "PENDING")
	useEffect(() => {
		if (!hasRunning) return
		const interval = setInterval(() => {
			router.invalidate()
		}, 3000)
		return () => clearInterval(interval)
	}, [hasRunning, router])

	const stats = {
		total: jobs.length,
		running: jobs.filter((j) => j.status === "RUNNING").length,
		completed: jobs.filter((j) => j.status === "COMPLETED").length,
		failed: jobs.filter((j) => j.status === "FAILED").length,
	}

	async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault()
		setUploadError(null)
		setUploading(true)

		const form = e.currentTarget
		const formData = new FormData(form)

		try {
			const res = await fetch("/api/admin/jobs", {
				method: "POST",
				body: formData,
				credentials: "include",
			})

			if (!res.ok) {
				const body = await res.json()
				throw new Error(body.error ?? `Upload failed (${res.status})`)
			}

			setShowForm(false)
			form.reset()
			router.invalidate()
		} catch (err) {
			setUploadError(err instanceof Error ? err.message : "Upload failed")
		} finally {
			setUploading(false)
		}
	}

	async function handleCancel(jobId: string) {
		await fetch(`/api/admin/jobs/${jobId}/cancel`, {
			method: "POST",
			credentials: "include",
		})
		router.invalidate()
	}

	async function handleSkipAndChain(jobId: string) {
		setSkipError(null)
		if (
			!globalThis.confirm(
				"Mark this job complete (assume data is already in the database) and continue the pipeline when this job was started with chaining? The worker will stop on its next check.",
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
				setSkipError(body.error ?? `Skip failed (${res.status})`)
				return
			}
			await router.invalidate()
		} finally {
			setSkippingJobId(null)
		}
	}

	async function handleRetry(jobId: string) {
		setRetryError(null)
		setRequeueJobId(jobId)
		try {
			const res = await fetch(`/api/admin/jobs/${jobId}/retry`, {
				method: "POST",
				credentials: "include",
			})
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			if (!res.ok) {
				setRetryError(body.error ?? `Retry failed (${res.status})`)
				return
			}
			await router.invalidate()
		} finally {
			setRequeueJobId(null)
		}
	}

	async function handleRerun(jobId: string) {
		if (
			!globalThis.confirm(
				"Queue a new run using this job’s saved file/URLs? The completed job stays in the list.",
			)
		) {
			return
		}
		setRetryError(null)
		setRequeueJobId(jobId)
		try {
			const res = await fetch(`/api/admin/jobs/${jobId}/rerun`, {
				method: "POST",
				credentials: "include",
			})
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			if (!res.ok) {
				setRetryError(body.error ?? `Re-run failed (${res.status})`)
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
			<div className="flex items-center justify-between gap-4">
				<p className="text-sm text-muted-foreground">
					Import vocabulary, frequency lists, and sentences
				</p>
				<Button size="sm" className="h-8 shrink-0" onClick={() => setShowForm(!showForm)}>
					{showForm ? "Cancel" : "New Job"}
				</Button>
			</div>

			{/* Summary stats */}
			<div className="flex items-center gap-6 text-sm">
				<StatDot color="bg-muted-foreground" label="total" value={stats.total} />
				<StatDot color="bg-brand" label="running" value={stats.running} />
				<StatDot color="bg-known" label="completed" value={stats.completed} />
				<StatDot color="bg-destructive" label="failed" value={stats.failed} />
			</div>

			{retryError ? (
				<div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
					{retryError}
				</div>
			) : null}
			{skipError ? (
				<div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
					{skipError}
				</div>
			) : null}

			{/* Upload form */}
			{showForm && (
				<div className="border border-border rounded-lg p-5 bg-muted/20 space-y-4">
					<h2 className="text-sm font-semibold">Create ingestion job</h2>
					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="grid grid-cols-2 gap-4">
							<div className="space-y-2">
								<Label htmlFor="type">Data type</Label>
								<select
									id="type"
									name="type"
									required
									className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									<option value="KAIKKI_WORDS">Kaikki Dictionary (JSON lines)</option>
									<option value="FREQUENCY_LIST">Frequency List (TSV/CSV)</option>
									<option value="TATOEBA_SENTENCES">Tatoeba Sentences (TSV)</option>
								</select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="languageId">Language</Label>
								<select
									id="languageId"
									name="languageId"
									required
									className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									{languages.map((l) => (
										<option key={l.id} value={l.id}>
											{l.name} ({l.code})
										</option>
									))}
								</select>
							</div>
						</div>
						<div className="space-y-2">
							<Label htmlFor="source">Source name (optional)</Label>
							<Input
								id="source"
								name="source"
								placeholder="e.g. kaikki.org, wikipedia, tatoeba"
								className="h-9"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="file">Data file</Label>
							<Input
								ref={fileInputRef}
								id="file"
								name="file"
								type="file"
								required
								accept=".json,.jsonl,.tsv,.csv,.txt"
								className="h-9"
							/>
						</div>
						{uploadError && (
							<div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
								{uploadError}
							</div>
						)}
						<Button type="submit" size="sm" className="h-8" disabled={uploading}>
							{uploading ? "Uploading..." : "Start ingestion"}
						</Button>
					</form>
				</div>
			)}

			{/* Jobs table */}
			{jobs.length === 0 ? (
				<div className="text-center py-12 text-sm text-muted-foreground">
					No ingestion jobs yet. Click "New Job" to import vocabulary data.
				</div>
			) : (
				<div className="border border-border rounded-lg overflow-hidden">
					<div className="grid grid-cols-[1fr_130px_108px_100px_120px_72px_108px] gap-3 text-[10px] font-mono text-muted-foreground uppercase tracking-[0.15em] px-4 py-2.5 bg-muted/50 border-b border-border">
						<span>Type / Language</span>
						<span>Status</span>
						<span className="text-right">Speed</span>
						<span className="text-right">Progress</span>
						<span className="text-right">Items</span>
						<span className="text-right">Errors</span>
						<span className="text-right">Actions</span>
					</div>
					<div className="divide-y divide-border">
						{jobs.map((job) => (
							<div
								key={job.id}
								className="grid grid-cols-[1fr_130px_108px_100px_120px_72px_108px] gap-3 items-center px-4 py-2.5 hover:bg-muted/30 transition-colors"
							>
								<div>
									<div className="text-sm font-medium">{JOB_TYPE_LABELS[job.type] ?? job.type}</div>
									<div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
										<span>{job.languageName}</span>
										<span className="font-mono bg-muted rounded px-1 py-0.5 text-[10px]">
											{job.languageCode}
										</span>
										<span className="text-muted-foreground/50">·</span>
										<span className="text-muted-foreground/70">
											{formatJobRelativeTime(job.createdAt)}
										</span>
									</div>
									{job.errorMessage ? (
										<p
											className="mt-1 text-[11px] text-destructive/90 font-mono leading-snug break-all line-clamp-2 max-w-xl"
											title={job.errorMessage}
										>
											{job.errorMessage}
										</p>
									) : null}
								</div>
								<div>
									<span
										className={`inline-flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 rounded-full ${STATUS_STYLES[job.status] ?? ""}`}
									>
										{job.status === "RUNNING" && (
											<span className="size-1.5 rounded-full bg-current animate-pulse" />
										)}
										{job.status.toLowerCase()}
									</span>
								</div>
								<div className="flex justify-end">
									<IngestSpeedometer
										itemsPerSecond={job.itemsPerSecond}
										active={job.status === "RUNNING"}
									/>
								</div>
								<div className="text-right">
									{job.totalItems > 0 && job.progress !== null ? (
										<div className="space-y-1">
											<span className="text-sm font-mono tabular-nums">{job.progress}%</span>
											<div className="h-1 bg-muted rounded-full overflow-hidden">
												<div
													className="h-full bg-brand rounded-full transition-all duration-500"
													style={{ width: `${job.progress}%` }}
												/>
											</div>
										</div>
									) : job.processedItems > 0 ? (
										<span className="text-xs font-mono text-muted-foreground">
											{job.processedItems.toLocaleString()}
											<span className="opacity-60"> stream</span>
										</span>
									) : (
										<span className="text-sm text-muted-foreground">—</span>
									)}
								</div>
								<div className="text-right text-sm font-mono tabular-nums">
									{job.processedItems > 0 ? (
										<span>
											{job.processedItems.toLocaleString()}
											<span className="text-muted-foreground">
												/{job.totalItems.toLocaleString()}
											</span>
										</span>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</div>
								<div className="text-right text-sm font-mono tabular-nums">
									{job.errorCount > 0 ? (
										<span className="text-destructive">{job.errorCount.toLocaleString()}</span>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</div>
								<div className="flex flex-col items-end gap-1">
									<Button
										variant="outline"
										size="sm"
										className="h-7 text-xs px-2 font-mono"
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
												className="h-7 text-xs px-2 font-mono text-muted-foreground border-dashed"
												disabled={skippingJobId !== null}
												title={
													job.chainPipeline
														? "Mark complete and enqueue the next pipeline job (frequency or Tatoeba)."
														: "Mark complete without chaining (this upload was not part of the full pipeline)."
												}
												onClick={() => handleSkipAndChain(job.id)}
											>
												{skippingJobId === job.id ? "…" : "Skip → next"}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												className="h-7 text-xs text-muted-foreground hover:text-destructive px-2"
												onClick={() => handleCancel(job.id)}
											>
												Cancel
											</Button>
										</>
									)}
									{(job.status === "FAILED" || job.status === "CANCELLED") && (
										<Button
											variant="secondary"
											size="sm"
											className="h-7 text-xs px-2"
											disabled={requeueJobId !== null}
											onClick={() => handleRetry(job.id)}
										>
											{requeueJobId === job.id ? "…" : "Retry"}
										</Button>
									)}
									{job.status === "COMPLETED" && (
										<Button
											variant="secondary"
											size="sm"
											className="h-7 text-xs px-2"
											disabled={requeueJobId !== null}
											title="Enqueue again from the same source (metadata URLs or upload path)."
											onClick={() => handleRerun(job.id)}
										>
											{requeueJobId === job.id ? "…" : "Re-run"}
										</Button>
									)}
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Running job indicator */}
			{hasRunning && (
				<p className="text-xs text-muted-foreground text-center animate-pulse">
					Auto-refreshing every 3 seconds...
				</p>
			)}
		</div>
	)
}

function StatDot({ color, label, value }: { color: string; label: string; value: number }) {
	return (
		<div className="flex items-center gap-2">
			<span className={`size-2 rounded-full ${color}`} />
			<span className="text-muted-foreground">
				<span className="font-mono font-medium text-foreground">{value}</span> {label}
			</span>
		</div>
	)
}
