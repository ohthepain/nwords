"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Button } from "~/components/ui/button"
import {
	JOB_TYPE_LABELS,
	type PersistedJobLogLine,
	jobMetadataError,
	parseJobLogLines,
} from "~/lib/admin-ingest-jobs"

type AdminJobDetail = {
	id: string
	type: string
	status: string
	processedItems: number
	totalItems: number
	errorCount: number
	metadata: unknown
}

function formatLogTime(iso: string): string {
	try {
		return new Date(iso).toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		})
	} catch {
		return iso
	}
}

function linesForTab(lines: PersistedJobLogLine[], tab: "out" | "err"): PersistedJobLogLine[] {
	return lines.filter((l) => l.s === tab)
}

export function JobOutputViewer({
	jobId,
	title,
	open,
	onClose,
}: {
	jobId: string | null
	title: string
	open: boolean
	onClose: () => void
}) {
	const [tab, setTab] = useState<"out" | "err">("out")
	const [detail, setDetail] = useState<AdminJobDetail | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [autoScroll, setAutoScroll] = useState(true)
	const preRef = useRef<HTMLPreElement>(null)

	useEffect(() => {
		if (!open || !jobId) {
			setDetail(null)
			setLoadError(null)
			return
		}

		const resolvedJobId = jobId
		let cancelled = false

		async function load() {
			try {
				const res = await fetch(`/api/admin/jobs/${resolvedJobId}`, { credentials: "include" })
				const body = (await res.json().catch(() => ({}))) as {
					error?: string
				} & Partial<AdminJobDetail>
				if (!res.ok) {
					throw new Error(body.error ?? `HTTP ${res.status}`)
				}
				if (!cancelled) {
					setDetail({
						id: body.id ?? resolvedJobId,
						type: body.type ?? "UNKNOWN",
						status: body.status ?? "UNKNOWN",
						processedItems: typeof body.processedItems === "number" ? body.processedItems : 0,
						totalItems: typeof body.totalItems === "number" ? body.totalItems : 0,
						errorCount: typeof body.errorCount === "number" ? body.errorCount : 0,
						metadata: body.metadata ?? null,
					})
					setLoadError(null)
				}
			} catch (e) {
				if (!cancelled) {
					setLoadError(e instanceof Error ? e.message : "Failed to load job")
				}
			}
		}

		load()
		const interval = setInterval(load, 2000)
		return () => {
			cancelled = true
			clearInterval(interval)
		}
	}, [open, jobId])

	const allLines = detail ? parseJobLogLines(detail.metadata) : []
	const shownLines = linesForTab(allLines, tab)
	const summaryError = detail ? jobMetadataError(detail.metadata) : null

	// biome-ignore lint/correctness/useExhaustiveDependencies: shownLines/tab/summaryError are intentional triggers to auto-scroll on content change
	useLayoutEffect(() => {
		if (!autoScroll || !preRef.current) return
		const el = preRef.current
		el.scrollTop = el.scrollHeight
	}, [shownLines, tab, autoScroll, summaryError])

	useEffect(() => {
		if (!open) setTab("out")
	}, [open])

	if (!open || !jobId) return null

	const typeLabel = detail ? (JOB_TYPE_LABELS[detail.type] ?? detail.type) : title

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px]"
			role="presentation"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose()
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose()
			}}
		>
			<div
				className="flex flex-col w-full max-w-4xl max-h-[min(88vh,900px)] rounded-lg border border-border bg-background shadow-xl"
				// biome-ignore lint/a11y/useSemanticElements: custom positioned modal, not using native dialog
				role="dialog"
				aria-labelledby="job-output-title"
			>
				<div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border shrink-0">
					<div className="min-w-0">
						<h2 id="job-output-title" className="text-sm font-semibold text-foreground truncate">
							Output — {typeLabel}
						</h2>
						<p
							className="text-[11px] font-mono text-muted-foreground truncate mt-0.5"
							title={jobId}
						>
							{jobId}
							{detail ? (
								<span className="text-muted-foreground/70"> · {detail.status.toLowerCase()}</span>
							) : null}
						</p>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
							<input
								type="checkbox"
								checked={autoScroll}
								onChange={(e) => setAutoScroll(e.target.checked)}
								className="rounded border-border"
							/>
							Autoscroll
						</label>
						<Button type="button" variant="outline" size="sm" className="h-8" onClick={onClose}>
							Close
						</Button>
					</div>
				</div>

				<div className="flex gap-1 px-3 pt-2 border-b border-border/80 shrink-0">
					<button
						type="button"
						onClick={() => setTab("out")}
						className={
							tab === "out"
								? "px-3 py-1.5 text-xs font-medium rounded-t-md bg-muted text-foreground border border-b-0 border-border -mb-px"
								: "px-3 py-1.5 text-xs font-medium rounded-t-md text-muted-foreground hover:text-foreground"
						}
					>
						Output
						<span className="ml-1.5 font-mono text-[10px] opacity-70">
							({linesForTab(allLines, "out").length})
						</span>
					</button>
					<button
						type="button"
						onClick={() => setTab("err")}
						className={
							tab === "err"
								? "px-3 py-1.5 text-xs font-medium rounded-t-md bg-muted text-foreground border border-b-0 border-border -mb-px"
								: "px-3 py-1.5 text-xs font-medium rounded-t-md text-muted-foreground hover:text-foreground"
						}
					>
						Errors
						<span className="ml-1.5 font-mono text-[10px] opacity-70">
							({linesForTab(allLines, "err").length + (summaryError ? 1 : 0)})
						</span>
					</button>
				</div>

				<div className="flex-1 min-h-0 flex flex-col p-3">
					{loadError ? <p className="text-sm text-destructive px-1 py-2">{loadError}</p> : null}
					{tab === "err" && summaryError ? (
						<div className="mb-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 shrink-0">
							<p className="text-[10px] font-mono uppercase tracking-wider text-destructive/80 mb-1">
								metadata.error
							</p>
							<p className="text-xs font-mono text-destructive whitespace-pre-wrap break-all">
								{summaryError}
							</p>
						</div>
					) : null}
					<pre
						ref={preRef}
						className="flex-1 min-h-[200px] overflow-auto rounded-md border border-border/80 bg-muted/30 px-3 py-2 text-[11px] font-mono leading-relaxed text-foreground whitespace-pre-wrap break-all"
					>
						{shownLines.length === 0 ? (
							<span className="text-muted-foreground space-y-2 block">
								{tab === "out" ? (
									<>
										<span className="block">
											No output lines yet. Progress messages appear as the worker runs.
										</span>
										{detail &&
										(detail.status === "RUNNING" || detail.status === "PENDING") &&
										(detail.processedItems > 0 || detail.errorCount > 0) ? (
											<span className="block mt-2 text-foreground/85">
												Latest job row: {detail.processedItems.toLocaleString()} processed
												{detail.totalItems > 0
													? ` · ${detail.totalItems.toLocaleString()} total`
													: ""}
												{detail.errorCount > 0
													? ` · ${detail.errorCount.toLocaleString()} errors`
													: ""}
												. If this stays empty while counts move, metadata merges were racing (update
												deployed — or run only one ingest worker process via{" "}
												<span className="font-mono">DISABLE_INGEST_WORKERS</span> on the app that
												should not host workers).
											</span>
										) : null}
									</>
								) : summaryError ? (
									"No additional stderr-style lines; see metadata.error above if present."
								) : (
									"No error lines yet."
								)}
							</span>
						) : (
							shownLines.map((l, i) => (
								<span key={`${l.t}-${i}`} className="block">
									<span className="text-muted-foreground">{formatLogTime(l.t)}</span> {l.m}
								</span>
							))
						)}
					</pre>
					<p className="text-[10px] text-muted-foreground mt-2 px-1 shrink-0">
						Refreshes every 2s while this dialog is open. Server process logs also appear in the API
						terminal during local dev.
					</p>
				</div>
			</div>
		</div>
	)
}
