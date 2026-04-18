/**
 * Heatmap grid geometry and “conquered columns” logic shared with Build-mode word picking.
 * Matches `apps/web/src/lib/vocab-graph-column-utils.ts` and `vocab-graph.tsx`.
 */

/** Same as apps/web `TERRITORY_MIN_CONFIDENCE` — a column counts as conquered when every cell clears this. */
export const TERRITORY_GRID_MIN_CONFIDENCE = 0.9

export const GAP_PX = 1

export const GRAPH_MIN_WIDTH_PX = 220

/** Target number of ranks to show: max(assumed, vocab) with a floor, ×1.2, capped by loaded cells. */
export function heatmapTargetCellCount(
	assumedRank: number,
	vocabSize: number,
	cellsLength: number,
): number {
	const baseline = Math.max(assumedRank, vocabSize, 50)
	return Math.min(cellsLength, Math.ceil(baseline * 1.2))
}

export function squareSizePx(wordCount: number): number {
	if (wordCount <= 100) return 16
	if (wordCount <= 200) return 12
	if (wordCount <= 400) return 10
	if (wordCount <= 1000) return 8
	if (wordCount <= 2000) return 6
	return 5
}

export function graphWidthBasePx(wordCount: number): number {
	if (wordCount <= 400) return 600
	if (wordCount <= 1000) return 800
	return 800
}

export type HeatmapGridMetrics = { numCols: number; numRows: number; displayCount: number }

/**
 * Same column/row counts as the vocab heatmap for a given slice length (cells already deduped by rank).
 */
export function computeHeatmapGridMetrics(
	cellsLength: number,
	assumedRank: number,
	vocabSize: number,
): HeatmapGridMetrics | null {
	if (cellsLength <= 0) return null
	const targetCells = heatmapTargetCellCount(assumedRank, vocabSize, cellsLength)
	const square = squareSizePx(targetCells)
	const baseW = graphWidthBasePx(targetCells)
	const graphW = Math.max(GRAPH_MIN_WIDTH_PX, baseW)
	const step = square + GAP_PX
	const numCols = Math.max(1, Math.floor((graphW + GAP_PX) / step))
	const displayCount = Math.min(
		cellsLength,
		Math.max(numCols, Math.ceil(targetCells / numCols) * numCols),
	)
	const numRows = Math.max(1, Math.ceil(displayCount / numCols))
	return { numCols, numRows, displayCount }
}

/**
 * Whether a cell counts toward a fully “conquered” column.
 * Matches `apps/web` `cellQualifiesForTerritory`: every occupied cell needs measured confidence
 * ≥ threshold (null does not qualify). This keeps Build’s post-conquest window aligned with the
 * heatmap’s “current column” (first column that is not fully conquered).
 */
export function territoryCellQualifiesForConqueredColumn(
	confidence: number | null,
	_effectiveRank: number,
	_assumedRank: number,
): boolean {
	return confidence !== null && confidence >= TERRITORY_GRID_MIN_CONFIDENCE
}

/**
 * Count of full columns from the left where every occupied cell qualifies for conquered territory.
 * Column-major index: `idx = col * numRows + row`.
 */
export function completedConqueredColsFromLeft(
	visibleCells: readonly { confidence: number | null; effectiveRank: number }[],
	numCols: number,
	numRows: number,
	assumedRank: number,
): number {
	let col = 0
	for (; col < numCols; col++) {
		let colOk = true
		for (let row = 0; row < numRows; row++) {
			const idx = col * numRows + row
			if (idx >= visibleCells.length) break
			const cell = visibleCells[idx]
			if (
				!territoryCellQualifiesForConqueredColumn(cell.confidence, cell.effectiveRank, assumedRank)
			) {
				colOk = false
				break
			}
		}
		if (!colOk) break
	}
	return col
}

/**
 * Word ids in column-major order starting at the first cell after conquered columns,
 * limited to `windowSize` lemmas (the visible-heatmap slice only).
 */
export function wordIdsAfterConqueredFrontier(
	visibleOrderedRows: readonly { id: string; effectiveRank: number; confidence: number | null }[],
	windowSize: number,
	completedColsFromLeft: number,
	numRows: number,
): string[] {
	if (windowSize <= 0) {
		return visibleOrderedRows.map((r) => r.id)
	}
	const start = completedColsFromLeft * numRows
	return visibleOrderedRows.slice(start, start + windowSize).map((r) => r.id)
}
