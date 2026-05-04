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

/** Output tab shows full job transcript: stdout + stderr interleaved by time. */
function sortedMergedJobLines(lines: PersistedJobLogLine[]): PersistedJobLogLine[] {
	return [...lines].sort((a, b) => a.t.localeCompare(b.t))
}

type VocabCleanupPreview = {
	dryRun?: boolean
	/** Legacy jobs only (frequency-removal era). */
	wouldRemoveTotal: number
	wouldRemove: Array<{ wordId: string; lemma: string; pos: string; reason: string }>
	wouldRenumberTotal: number
	wouldRenumber: Array<{
		wordId: string
		lemma: string
		pos: string
		oldIndex: number
		newRank: number
	}>
	senseGroupsAdjusted?: number
	senseOffset?: number
}

function parseVocabCleanupPreview(metadata: unknown): VocabCleanupPreview | null {
	if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null
	const m = metadata as Record<string, unknown>
	if (typeof m.wouldRenumberTotal !== "number") return null

	const wr = Array.isArray(m.wouldRemove) ? m.wouldRemove : []
	const wouldRemove: VocabCleanupPreview["wouldRemove"] = []
	for (const x of wr) {
		if (x === null || typeof x !== "object") continue
		const o = x as Record<string, unknown>
		if (typeof o.wordId !== "string" || typeof o.lemma !== "string" || typeof o.reason !== "string")
			continue
		const pos = typeof o.pos === "string" ? o.pos : String(o.pos ?? "")
		wouldRemove.push({ wordId: o.wordId, lemma: o.lemma, pos, reason: o.reason })
	}

	const wn = Array.isArray(m.wouldRenumber) ? m.wouldRenumber : []
	const wouldRenumber: VocabCleanupPreview["wouldRenumber"] = []
	for (const x of wn) {
		if (x === null || typeof x !== "object") continue
		const o = x as Record<string, unknown>
		if (
			typeof o.wordId !== "string" ||
			typeof o.lemma !== "string" ||
			typeof o.oldIndex !== "number" ||
			typeof o.newRank !== "number"
		)
			continue
		const pos = typeof o.pos === "string" ? o.pos : String(o.pos ?? "")
		wouldRenumber.push({
			wordId: o.wordId,
			lemma: o.lemma,
			pos,
			oldIndex: o.oldIndex,
			newRank: o.newRank,
		})
	}

	const wouldRemoveTotal = typeof m.wouldRemoveTotal === "number" ? m.wouldRemoveTotal : 0

	return {
		dryRun: m.dryRun === true,
		wouldRemoveTotal,
		wouldRemove,
		wouldRenumberTotal: m.wouldRenumberTotal,
		wouldRenumber,
		senseGroupsAdjusted:
			typeof m.senseGroupsAdjusted === "number" ? m.senseGroupsAdjusted : undefined,
		senseOffset: typeof m.senseOffset === "number" ? m.senseOffset : undefined,
	}
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
	const [tab, setTab] = useState<"out" | "err" | "preview">("out")
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
	const shownLines =
		tab === "out"
			? sortedMergedJobLines(allLines)
			: tab === "err"
				? linesForTab(allLines, "err")
				: []
	const summaryError = detail ? jobMetadataError(detail.metadata) : null
	const vocabPreview = detail ? parseVocabCleanupPreview(detail.metadata) : null
	const showPreviewTab = vocabPreview !== null

	// biome-ignore lint/correctness/useExhaustiveDependencies: shownLines/tab/summaryError are intentional triggers to auto-scroll on content change
	useLayoutEffect(() => {
		if (!autoScroll || !preRef.current) return
		if (tab === "preview") return
		const el = preRef.current
		el.scrollTop = el.scrollHeight
	}, [shownLines, tab, autoScroll, summaryError])

	useEffect(() => {
		if (!open) setTab("out")
	}, [open])

	useEffect(() => {
		if (tab === "preview" && !showPreviewTab) setTab("out")
	}, [tab, showPreviewTab])

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
							{detail && detail.totalItems > 0 ? (
								<span className="text-foreground/90">
									{" "}
									· {detail.processedItems.toLocaleString()} / {detail.totalItems.toLocaleString()}{" "}
									({Math.min(100, Math.round((detail.processedItems / detail.totalItems) * 100))}%)
								</span>
							) : detail && (detail.processedItems > 0 || detail.errorCount > 0) ? (
								<span className="text-foreground/90">
									{" "}
									· {detail.processedItems.toLocaleString()} processed
									{detail.errorCount > 0 ? ` · ${detail.errorCount.toLocaleString()} err` : ""}
								</span>
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
						<span className="ml-1.5 font-mono text-[10px] opacity-70">({allLines.length})</span>
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
					{showPreviewTab ? (
						<button
							type="button"
							onClick={() => setTab("preview")}
							className={
								tab === "preview"
									? "px-3 py-1.5 text-xs font-medium rounded-t-md bg-muted text-foreground border border-b-0 border-border -mb-px"
									: "px-3 py-1.5 text-xs font-medium rounded-t-md text-muted-foreground hover:text-foreground"
							}
						>
							Preview
						</button>
					) : null}
				</div>

				<div className="flex-1 min-h-0 flex flex-col p-3">
					{loadError ? <p className="text-sm text-destructive px-1 py-2">{loadError}</p> : null}
					{tab === "out" && summaryError ? (
						<div className="mb-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 shrink-0">
							<p className="text-[10px] font-mono uppercase tracking-wider text-destructive/80 mb-1">
								Job failure (metadata.error)
							</p>
							<p className="text-xs font-mono text-destructive whitespace-pre-wrap break-all">
								{summaryError}
							</p>
						</div>
					) : null}
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
					{tab === "preview" && vocabPreview ? (
						<div className="flex-1 min-h-[200px] overflow-auto rounded-md border border-border/80 bg-muted/20 px-3 py-3 text-xs space-y-4">
							<div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground font-mono">
								{vocabPreview.dryRun ? (
									<span className="text-brand font-medium">Dry run (no DB changes)</span>
								) : null}
								{typeof vocabPreview.senseOffset === "number" ? (
									<span>Sense offset: {vocabPreview.senseOffset}</span>
								) : null}
								{typeof vocabPreview.senseGroupsAdjusted === "number" ? (
									<span>Homograph groups: {vocabPreview.senseGroupsAdjusted.toLocaleString()}</span>
								) : null}
							</div>
							{vocabPreview.wouldRemoveTotal > 0 || vocabPreview.wouldRemove.length > 0 ? (
								<div>
									<p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
										Removals (legacy job; {vocabPreview.wouldRemoveTotal.toLocaleString()} total,
										sample {vocabPreview.wouldRemove.length})
									</p>
									<div className="overflow-x-auto rounded border border-border/80">
										<table className="w-full text-left text-[11px] font-mono">
											<thead className="bg-muted/60 text-muted-foreground">
												<tr>
													<th className="px-2 py-1.5 font-medium">Lemma</th>
													<th className="px-2 py-1.5 font-medium">POS</th>
													<th className="px-2 py-1.5 font-medium">Reason</th>
												</tr>
											</thead>
											<tbody>
												{vocabPreview.wouldRemove.length === 0 ? (
													<tr>
														<td colSpan={3} className="px-2 py-2 text-muted-foreground">
															None
														</td>
													</tr>
												) : (
													vocabPreview.wouldRemove.map((r) => (
														<tr key={r.wordId} className="border-t border-border/60">
															<td className="px-2 py-1.5 break-all">{r.lemma}</td>
															<td className="px-2 py-1.5 whitespace-nowrap">{r.pos}</td>
															<td className="px-2 py-1.5 text-muted-foreground">{r.reason}</td>
														</tr>
													))
												)}
											</tbody>
										</table>
									</div>
								</div>
							) : null}
							<div>
								<p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
									Order changes ({vocabPreview.wouldRenumberTotal.toLocaleString()} rows moved;
									sample {vocabPreview.wouldRenumber.length})
								</p>
								<div className="overflow-x-auto rounded border border-border/80">
									<table className="w-full text-left text-[11px] font-mono">
										<thead className="bg-muted/60 text-muted-foreground">
											<tr>
												<th className="px-2 py-1.5 font-medium">Lemma</th>
												<th className="px-2 py-1.5 font-medium">POS</th>
												<th className="px-2 py-1.5 font-medium">Old index</th>
												<th className="px-2 py-1.5 font-medium">New rank</th>
											</tr>
										</thead>
										<tbody>
											{vocabPreview.wouldRenumber.length === 0 ? (
												<tr>
													<td colSpan={4} className="px-2 py-2 text-muted-foreground">
														None (or no large deltas in sample)
													</td>
												</tr>
											) : (
												vocabPreview.wouldRenumber.map((r) => (
													<tr key={r.wordId} className="border-t border-border/60">
														<td className="px-2 py-1.5 break-all">{r.lemma}</td>
														<td className="px-2 py-1.5 whitespace-nowrap">{r.pos}</td>
														<td className="px-2 py-1.5 tabular-nums">{r.oldIndex}</td>
														<td className="px-2 py-1.5 tabular-nums">{r.newRank}</td>
													</tr>
												))
											)}
										</tbody>
									</table>
								</div>
							</div>
						</div>
					) : (
						<>
							<pre
								ref={preRef}
								className="flex-1 min-h-[200px] overflow-auto rounded-md border border-border/80 bg-muted/30 px-3 py-2 text-[11px] font-mono leading-relaxed text-foreground whitespace-pre-wrap break-all"
							>
								{shownLines.length === 0 ? (
									<span className="text-muted-foreground space-y-2 block">
										{tab === "out" ? (
											<>
												<span className="block">
													No lines yet. Progress and error messages appear here (merged by time) as
													the worker runs.
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
														. If this stays empty while counts move, metadata merges were racing
														(update deployed — or run only one ingest worker process via{" "}
														<span className="font-mono">DISABLE_INGEST_WORKERS</span> on the app
														that should not host workers).
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
										<span
											key={`${l.t}-${l.s}-${i}`}
											className={`block ${l.s === "err" ? "text-destructive" : ""}`}
										>
											<span className="text-muted-foreground">{formatLogTime(l.t)}</span>
											{l.s === "err" ? <span className="font-semibold"> [err]</span> : null} {l.m}
										</span>
									))
								)}
							</pre>
							<p className="text-[10px] text-muted-foreground mt-2 px-1 shrink-0">
								Output tab merges stdout and stderr by timestamp (stderr in red). Refreshes every 2s
								while this dialog is open. Server logs also appear in the API terminal during local
								dev.
							</p>
						</>
					)}
				</div>
			</div>
		</div>
	)
}
