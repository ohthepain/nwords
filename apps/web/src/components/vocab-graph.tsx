import { useCallback, useEffect, useMemo, useRef, useState } from "react"

const GAP_PX = 1
/** Solid territory only includes cells at or above this measured confidence (below assumed rank can still be “learning” in practice). */
const TERRITORY_MIN_CONFIDENCE = 0.9

export type VocabGraphCell = {
	wordId: string
	rank: number
	lemma: string
	status: string
	confidence: number | null
	timesTested: number
	timesCorrect: number
}

type HeatmapResponse = {
	from: number
	to: number
	languageId: string
	assumedRank: number
	/** Verified-known words in this language (high confidence + enough tests). */
	knownWords: number
	/** assumedRank + knownWords — same notion as dashboard. */
	vocabSize: number
	cells: VocabGraphCell[]
}

function squareSizePx(wordCount: number): number {
	if (wordCount <= 100) return 16
	if (wordCount <= 200) return 12
	if (wordCount <= 400) return 8
	if (wordCount <= 1000) return 6
	if (wordCount <= 2000) return 4
	return 2
}

function graphWidthBasePx(wordCount: number): number {
	if (wordCount <= 400) return 400
	if (wordCount <= 1000) return 600
	return 800
}

/** Target number of ranks to show: max(assumed, vocab) with a floor, ×1.2, capped by loaded cells. */
function heatmapTargetCellCount(
	assumedRank: number,
	vocabSize: number,
	cellsLength: number,
): number {
	const baseline = Math.max(assumedRank, vocabSize, 50)
	return Math.min(cellsLength, Math.ceil(baseline * 1.2))
}

/** Background color for a cell from continuous confidence; null = untested (neutral). */
function cellBackground(confidence: number | null): string {
	if (confidence === null) {
		return "var(--vocab-graph-untested)"
	}
	const lowWeight = Math.round((1 - confidence) * 100)
	return `color-mix(in oklch, var(--vocab-graph-confidence-low) ${lowWeight}%, var(--vocab-graph-confidence-high))`
}

/** Backdrop behind fully verified columns (“conquered” territory). */
function territorySlabFill(): string {
	return "var(--vocab-graph-territory-conquered)"
}

function cellQualifiesForTerritory(confidence: number | null): boolean {
	return confidence !== null && confidence >= TERRITORY_MIN_CONFIDENCE
}

const GRAPH_MIN_WIDTH_PX = 220

export function VocabGraph({
	languageId,
	activeWordId,
	answerFlash,
	showDevGrid,
	pointerProbe = true,
}: {
	languageId: string
	/** Current question word — brief highlight when it changes. */
	activeWordId: string | null
	/** After each recorded answer: triggers 4× color transition animation. */
	answerFlash: { wordId: string; confidence: number; tick: number } | null
	/** When true (admin dev mode), show computed row/column count for the heatmap grid. */
	showDevGrid?: boolean
	/** When false, disable drag/hover word list (e.g. settings live preview). */
	pointerProbe?: boolean
}) {
	const measureRef = useRef<HTMLDivElement>(null)
	const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)
	const [cells, setCells] = useState<VocabGraphCell[]>([])
	const [assumedRank, setAssumedRank] = useState(0)
	const [vocabSize, setVocabSize] = useState(0)
	const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle")
	const [questionFlashId, setQuestionFlashId] = useState<string | null>(null)
	const [answerAnim, setAnswerAnim] = useState<{
		wordId: string
		fromBg: string
		toBg: string
		useTo: boolean
		step: number
	} | null>(null)

	useEffect(() => {
		let cancelled = false
		setLoadState("loading")
		void (async () => {
			try {
				const u = new URL("/api/progress/heatmap", window.location.origin)
				u.searchParams.set("from", "1")
				u.searchParams.set("to", "10000")
				u.searchParams.set("languageId", languageId)
				const res = await fetch(u.toString(), { credentials: "include" })
				if (!res.ok) {
					throw new Error(await res.text())
				}
				const data = (await res.json()) as HeatmapResponse
				if (cancelled) return
				setCells(data.cells)
				setAssumedRank(data.assumedRank)
				setVocabSize(data.vocabSize)
				setLoadState("idle")
			} catch {
				if (!cancelled) setLoadState("error")
			}
		})()
		return () => {
			cancelled = true
		}
	}, [languageId])

	useEffect(() => {
		const el = measureRef.current
		if (!el || typeof ResizeObserver === "undefined") return
		const ro = new ResizeObserver((entries) => {
			const w = entries[0]?.contentRect.width
			if (w != null && w > 0) setMeasuredWidth(w)
		})
		ro.observe(el)
		const w0 = el.getBoundingClientRect().width
		if (w0 > 0) setMeasuredWidth(w0)
		return () => ro.disconnect()
	}, [])

	const targetCells = heatmapTargetCellCount(assumedRank, vocabSize, cells.length)
	const square = squareSizePx(targetCells)
	const baseW = graphWidthBasePx(targetCells)
	const graphW =
		measuredWidth != null
			? Math.max(GRAPH_MIN_WIDTH_PX, Math.min(baseW, Math.floor(measuredWidth)))
			: baseW
	const step = square + GAP_PX
	const numCols = Math.max(1, Math.floor((graphW + GAP_PX) / step))
	const displayCount = Math.min(
		cells.length,
		Math.max(numCols, Math.ceil(targetCells / numCols) * numCols),
	)
	const numRows = Math.max(1, Math.ceil(displayCount / numCols))
	const graphH = numRows * step - GAP_PX

	const visibleCells = useMemo(() => cells.slice(0, displayCount), [cells, displayCount])

	/**
	 * Leftmost columns where every occupied cell has measured confidence ≥ TERRITORY_MIN_CONFIDENCE.
	 * (`status` can be “known” below assumed rank while confidence reflects real tests; we follow confidence.)
	 */
	const completedColsFromLeft = useMemo(() => {
		let col = 0
		for (; col < numCols; col++) {
			let colOk = true
			for (let row = 0; row < numRows; row++) {
				const idx = col * numRows + row
				if (idx >= visibleCells.length) break
				if (!cellQualifiesForTerritory(visibleCells[idx].confidence)) {
					colOk = false
					break
				}
			}
			if (!colOk) break
		}
		return col
	}, [visibleCells, numCols, numRows])

	const territoryWidthPx = completedColsFromLeft > 0 ? completedColsFromLeft * step - GAP_PX : 0

	const conqueredWords = completedColsFromLeft * numRows

	/**
	 * Scan forward from the current conquered edge, column by column. For each
	 * prospective stopping column, record the cumulative unlearned words needed
	 * and the new conquered territory gained — so we can pick a high-ratio goal
	 * and map a user-chosen word count to a concrete territory target.
	 */
	const forwardScan = useMemo(() => {
		const stats: {
			colsAdded: number
			cumToLearn: number
			newConquered: number
			ratio: number
		}[] = []
		let cum = 0
		for (let col = completedColsFromLeft; col < numCols; col++) {
			let unlearnedInCol = 0
			for (let row = 0; row < numRows; row++) {
				const idx = col * numRows + row
				if (idx >= visibleCells.length) break
				if (!cellQualifiesForTerritory(visibleCells[idx].confidence)) unlearnedInCol++
			}
			cum += unlearnedInCol
			const colsAdded = col - completedColsFromLeft + 1
			const newConquered = colsAdded * numRows
			stats.push({
				colsAdded,
				cumToLearn: cum,
				newConquered,
				ratio: cum > 0 ? newConquered / cum : 0,
			})
		}
		return stats
	}, [visibleCells, numCols, numRows, completedColsFromLeft])

	/** Suggested session goal: stopping column with the best new-territory-per-word-learned ratio. */
	const suggestedGoal = useMemo(() => {
		let best: (typeof forwardScan)[number] | null = null
		for (const s of forwardScan) {
			if (s.cumToLearn <= 0) continue
			if (!best || s.ratio > best.ratio) best = s
		}
		return best
	}, [forwardScan])

	const [goalWordsOverride, setGoalWordsOverride] = useState<number | null>(null)
	const goalWords = goalWordsOverride ?? suggestedGoal?.cumToLearn ?? 0

	/** Deepest reachable column whose cumulative unlearned count fits in the user's goal budget. */
	const goalTarget = useMemo(() => {
		let best: (typeof forwardScan)[number] | null = null
		for (const s of forwardScan) {
			if (s.cumToLearn <= goalWords && s.cumToLearn > 0) best = s
		}
		return best
	}, [forwardScan, goalWords])

	const goalConquered = goalTarget
		? (completedColsFromLeft + goalTarget.colsAdded) * numRows
		: conqueredWords

	const gridIndexForPixel = useCallback(
		(px: number, py: number): number | null => {
			if (px < 0 || py < 0) return null
			const col = Math.floor(px / step)
			const rowFromTop = Math.floor(py / step)
			if (col < 0 || col >= numCols || rowFromTop < 0 || rowFromTop >= numRows) return null
			const rowFromBottom = numRows - 1 - rowFromTop
			const idx = col * numRows + rowFromBottom
			return idx >= 0 && idx < visibleCells.length ? idx : null
		},
		[numCols, numRows, step, visibleCells.length],
	)

	const [tooltipCell, setTooltipCell] = useState<VocabGraphCell | null>(null)
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

	const updateTooltip = useCallback(
		(idx: number | null, clientX: number, clientY: number) => {
			if (idx === null) {
				setTooltipCell(null)
				return
			}
			const cell = visibleCells[idx]
			if (!cell) {
				setTooltipCell(null)
				return
			}
			setTooltipCell(cell)
			setTooltipPos({ x: clientX, y: clientY })
		},
		[visibleCells],
	)

	const clearTooltip = useCallback(() => {
		setTooltipCell(null)
	}, [])

	const onPointerMove = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			const el = e.currentTarget
			const r = el.getBoundingClientRect()
			const x = e.clientX - r.left
			const y = e.clientY - r.top
			updateTooltip(gridIndexForPixel(x, y), e.clientX, e.clientY)
		},
		[gridIndexForPixel, updateTooltip],
	)

	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			try {
				e.currentTarget.setPointerCapture(e.pointerId)
			} catch {
				/* ignore */
			}
			const el = e.currentTarget
			const r = el.getBoundingClientRect()
			updateTooltip(gridIndexForPixel(e.clientX - r.left, e.clientY - r.top), e.clientX, e.clientY)
		},
		[gridIndexForPixel, updateTooltip],
	)

	const onPointerUp = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			try {
				e.currentTarget.releasePointerCapture(e.pointerId)
			} catch {
				/* ignore */
			}
			clearTooltip()
		},
		[clearTooltip],
	)

	const onPointerLeave = useCallback(() => {
		clearTooltip()
	}, [clearTooltip])

	const lastQuestionFlashRef = useRef<string | null>(null)
	useEffect(() => {
		if (!activeWordId) {
			lastQuestionFlashRef.current = null
			return
		}
		if (!visibleCells.some((c) => c.wordId === activeWordId)) return
		if (lastQuestionFlashRef.current === activeWordId) return
		lastQuestionFlashRef.current = activeWordId
		setQuestionFlashId(activeWordId)
		const t = window.setTimeout(() => setQuestionFlashId(null), 400)
		return () => clearTimeout(t)
	}, [activeWordId, visibleCells])

	// Answer: 8 half-steps (150ms) toggling between old and new fill + ring
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on tick only
	useEffect(() => {
		if (!answerFlash) return
		const { wordId, confidence: nextConf } = answerFlash

		let fromBg = ""
		let toBg = ""
		setCells((prev) => {
			const cell = prev.find((c) => c.wordId === wordId)
			if (!cell) return prev
			fromBg = cellBackground(cell.confidence)
			toBg = cellBackground(nextConf)
			return prev.map((c) => (c.wordId === wordId ? { ...c, confidence: nextConf } : c))
		})

		if (!fromBg || !toBg) return

		const animWordId = wordId
		setAnswerAnim({ wordId: animWordId, fromBg, toBg, useTo: false, step: 0 })

		let step = 0
		const id = window.setInterval(() => {
			step += 1
			const useTo = step % 2 === 0
			setAnswerAnim((a) => (a && a.wordId === animWordId ? { ...a, useTo, step } : a))
			if (step >= 8) {
				clearInterval(id)
				setAnswerAnim((a) => (a && a.wordId === animWordId ? { ...a, useTo: true, step: 8 } : a))
				window.setTimeout(() => {
					setAnswerAnim((a) => (a?.wordId === animWordId ? null : a))
				}, 150)
			}
		}, 150)

		return () => clearInterval(id)
	}, [answerFlash?.tick])

	if (loadState === "error") {
		return (
			<p className="text-xs text-muted-foreground">
				Could not load vocabulary graph. Try again after signing in with a target language.
			</p>
		)
	}

	if (loadState === "loading" && cells.length === 0) {
		return <p className="text-xs text-muted-foreground">Loading vocabulary graph…</p>
	}

	if (cells.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				No frequency-ranked words found for this language yet.
			</p>
		)
	}

	return (
		<div ref={measureRef} className="relative flex w-full min-w-0 flex-col items-center space-y-2">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider shrink-0">
					Vocabulary graph
				</p>
				<p className="text-xs text-muted-foreground tabular-nums">
					<span className="text-foreground/80 font-medium">
						Assumed rank {assumedRank > 0 ? assumedRank.toLocaleString() : "—"}
					</span>
					<span className="mx-1.5 text-muted-foreground/70">·</span>
					<span title="Estimated words you know: words below your assumed rank plus words you’ve verified by practice">
						~{vocabSize.toLocaleString()} words
					</span>
					{showDevGrid && (
						<>
							<span className="mx-1.5 text-muted-foreground/70">·</span>
							<span
								className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10px] text-muted-foreground/90"
								title={`Heatmap: ${displayCount.toLocaleString()} of ${cells.length.toLocaleString()} ranks loaded from API`}
							>
								<span>
									{numRows}×{numCols} · {square}px
								</span>
								<span className="inline-flex items-center gap-1">
									<span className="text-muted-foreground/70">e.g.</span>
									<span
										className="rounded-[1px] border border-border/60 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_40%,transparent)]"
										style={{
											width: square,
											height: square,
											backgroundColor: cellBackground(null),
										}}
										aria-hidden
									/>
								</span>
							</span>
						</>
					)}
				</p>
			</div>
			<div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs tabular-nums">
				<span className="text-foreground/80">
					Conquered:{" "}
					<span className="font-medium">{conqueredWords.toLocaleString()}</span> words
				</span>
				{forwardScan.length > 0 && suggestedGoal && (
					<>
						<span className="text-muted-foreground/70">·</span>
						<label className="flex items-center gap-1 text-muted-foreground">
							<span>Session goal: learn</span>
							<input
								type="number"
								min={0}
								value={goalWords}
								onChange={(e) => {
									const v = Number.parseInt(e.target.value, 10)
									setGoalWordsOverride(Number.isFinite(v) && v >= 0 ? v : 0)
								}}
								className="w-14 rounded border border-border/60 bg-background px-1 py-0.5 text-center text-foreground"
							/>
							<span>
								words →{" "}
								<span className="font-medium text-foreground/80">
									{goalConquered.toLocaleString()}
								</span>{" "}
								conquered
							</span>
						</label>
					</>
				)}
			</div>
			<div
				className="relative mx-auto rounded-lg border border-border/60 bg-muted/20 p-2 touch-none select-none w-fit"
			>
				<div
					role="img"
					aria-label="Vocabulary confidence graph"
					className="relative overflow-hidden rounded-md transition-colors duration-200"
					style={{
						width: graphW,
						height: Number.isFinite(graphH) ? graphH : 8,
						backgroundColor: "var(--vocab-graph-territory-open)",
					}}
					onPointerDown={pointerProbe ? onPointerDown : undefined}
					onPointerMove={pointerProbe ? onPointerMove : undefined}
					onPointerUp={pointerProbe ? onPointerUp : undefined}
					onPointerCancel={pointerProbe ? onPointerUp : undefined}
					onPointerLeave={pointerProbe ? onPointerLeave : undefined}
				>
					{territoryWidthPx > 0 ? (
						<div
							className="pointer-events-none absolute left-0 top-0 z-0 rounded-l-[3px]"
							style={{
								width: territoryWidthPx,
								height: graphH,
								backgroundColor: territorySlabFill(),
							}}
							aria-hidden
							title={`${completedColsFromLeft} column${completedColsFromLeft === 1 ? "" : "s"} ≥${Math.round(TERRITORY_MIN_CONFIDENCE * 100)}% confidence throughout`}
						/>
					) : null}
					<div
						className="relative z-10 grid"
						style={{
							width: graphW,
							height: graphH,
							gridTemplateColumns: `repeat(${numCols}, ${square}px)`,
							gridAutoRows: `${square}px`,
							gap: GAP_PX,
						}}
					>
						{visibleCells.map((c, i) => {
							const col = Math.floor(i / numRows)
							const rowFromBottom = i % numRows
							const rowFromTop = numRows - 1 - rowFromBottom
							const style: React.CSSProperties = {
								gridColumn: col + 1,
								gridRow: rowFromTop + 1,
							}

							const inAnswer = answerAnim?.wordId === c.wordId && answerAnim.step < 8
							const inQuestionFlash = questionFlashId === c.wordId

							let background = cellBackground(c.confidence)
							if (inAnswer && answerAnim) {
								background = answerAnim.useTo ? answerAnim.toBg : answerAnim.fromBg
							}

							const isActive = activeWordId === c.wordId
							const ring =
								inAnswer || inQuestionFlash
									? "0 0 0 1px color-mix(in srgb, var(--color-ring) 50%, transparent)"
									: isActive
										? "0 0 0 1px white"
										: undefined

							return (
								<div
									key={c.wordId}
									className={`rounded-[1px] ${inQuestionFlash && !inAnswer ? "vocab-graph-cell-qflash" : ""}`}
									style={{
										...style,
										width: square,
										height: square,
										backgroundColor: background,
										boxShadow: ring,
									}}
									title={`${c.lemma} (#${c.rank})`}
								/>
							)
						})}
					</div>
				</div>
			</div>
			{pointerProbe && tooltipCell && (
				<div
					className="fixed z-50 rounded-lg border border-border/80 bg-card/95 backdrop-blur-md px-3 py-2 text-xs shadow-lg pointer-events-none"
					style={{
						left: tooltipPos.x + 12,
						top: tooltipPos.y - 8,
						transform: "translateY(-100%)",
					}}
					aria-live="polite"
				>
					<p className="font-medium text-foreground">{tooltipCell.lemma} <span className="text-muted-foreground font-normal">#{tooltipCell.rank}</span></p>
					<p className="text-muted-foreground mt-0.5">
						Confidence: {tooltipCell.confidence !== null ? `${Math.round(tooltipCell.confidence * 100)}%` : "untested"}
					</p>
					<p className="text-muted-foreground">
						{tooltipCell.timesCorrect}/{tooltipCell.timesTested} correct
					</p>
				</div>
			)}
		</div>
	)
}
