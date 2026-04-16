import { isWordKnown } from "@nwords/shared"

/** Same gap as `vocab-graph.tsx` between heatmap squares (px). */
export const GAP_PX = 1

/** Same threshold as the heatmap “conquered column” slab in `vocab-graph.tsx`. */
export const TERRITORY_MIN_CONFIDENCE = 0.9

export const GRAPH_MIN_WIDTH_PX = 220

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

/** Target number of ranks to show: max(assumed, vocab) with a floor, ×1.2, capped by loaded cells. */
export function heatmapTargetCellCount(
	assumedRank: number,
	vocabSize: number,
	cellsLength: number,
): number {
	const baseline = Math.max(assumedRank, vocabSize, 50)
	return Math.min(cellsLength, Math.ceil(baseline * 1.2))
}

/** Same shape as `TerritoryColumnAdvancedPayload` in `vocab-graph.tsx`. */
export type BuildColumnFocusPayload = {
	columnIndex: number
	wordIds: string[]
	words: { wordId: string; lemma: string; rank: number }[]
}

export type VocabGraphColumnCell = {
	wordId: string
	rank: number
	lemma: string
	confidence: number | null
}

/** Heatmap cell fields needed to detect in-column “still learning” inventory. */
export type VocabGraphColumnCellWithTests = VocabGraphColumnCell & { timesTested: number }

export function cellQualifiesForTerritory(confidence: number | null): boolean {
	return confidence !== null && confidence >= TERRITORY_MIN_CONFIDENCE
}

/**
 * Count of full columns from the left where every occupied cell is territory-qualified.
 * Column-major index: `idx = col * numRows + row` with row 0 at the bottom row of the grid.
 */
export function completedColsFromLeft(
	visibleCells: VocabGraphColumnCell[],
	numCols: number,
	numRows: number,
): number {
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
}

/**
 * After `completedColsFromLeft` increases to `C`, the next working column is index `C`
 * (first column that is not fully conquered). Collect word ids in that column that still
 * need work for territory (confidence below threshold).
 */
export function nonTerritoryWordIdsInColumn(
	visibleCells: VocabGraphColumnCell[],
	numCols: number,
	numRows: number,
	columnIndex: number,
): string[] {
	if (columnIndex < 0 || columnIndex >= numCols) return []
	const out: string[] = []
	for (let row = 0; row < numRows; row++) {
		const idx = columnIndex * numRows + row
		if (idx >= visibleCells.length) break
		const cell = visibleCells[idx]
		if (!cellQualifiesForTerritory(cell.confidence)) out.push(cell.wordId)
	}
	return out
}

export function columnWordSummaries(
	visibleCells: VocabGraphColumnCell[],
	numCols: number,
	numRows: number,
	columnIndex: number,
): { wordId: string; lemma: string; rank: number }[] {
	if (columnIndex < 0 || columnIndex >= numCols) return []
	const out: { wordId: string; lemma: string; rank: number }[] = []
	for (let row = 0; row < numRows; row++) {
		const idx = columnIndex * numRows + row
		if (idx >= visibleCells.length) break
		const cell = visibleCells[idx]
		if (!cellQualifiesForTerritory(cell.confidence)) {
			out.push({ wordId: cell.wordId, lemma: cell.lemma, rank: cell.rank })
		}
	}
	return out
}

export type HeatmapGridLayout<T extends VocabGraphColumnCell = VocabGraphColumnCell> = {
	visibleCells: T[]
	numCols: number
	numRows: number
	completedCols: number
}

/** Same geometry as `VocabGraph` / `computeFirstIncompleteColumnPayload` (column-major heatmap slice). */
export function computeHeatmapGridLayout<T extends VocabGraphColumnCell = VocabGraphColumnCell>(
	cells: T[],
	assumedRank: number,
	vocabSize: number,
): HeatmapGridLayout<T> | null {
	if (cells.length === 0) return null
	const targetCells = heatmapTargetCellCount(assumedRank, vocabSize, cells.length)
	const square = squareSizePx(targetCells)
	const baseW = graphWidthBasePx(targetCells)
	const graphW = Math.max(GRAPH_MIN_WIDTH_PX, baseW)
	const step = square + GAP_PX
	const numCols = Math.max(1, Math.floor((graphW + GAP_PX) / step))
	const displayCount = Math.min(
		cells.length,
		Math.max(numCols, Math.ceil(targetCells / numCols) * numCols),
	)
	const numRows = Math.max(1, Math.ceil(displayCount / numCols))
	const visibleCells = cells.slice(0, displayCount)
	const completedCols = completedColsFromLeft(visibleCells, numCols, numRows)
	return { visibleCells, numCols, numRows, completedCols }
}

/**
 * Words in the frontier column that already have at least one test but are not verified known
 * (`KNOWN_CONFIDENCE_THRESHOLD` + `KNOWN_MIN_TESTS` via `isWordKnown`).
 */
export function countTestedNotMasteredInColumn(
	visibleCells: VocabGraphColumnCellWithTests[],
	numCols: number,
	numRows: number,
	columnIndex: number,
): number {
	if (columnIndex < 0 || columnIndex >= numCols) return 0
	let n = 0
	for (let row = 0; row < numRows; row++) {
		const idx = columnIndex * numRows + row
		if (idx >= visibleCells.length) break
		const cell = visibleCells[idx]
		if (cellQualifiesForTerritory(cell.confidence)) continue
		if (cell.timesTested < 1) continue
		const conf = cell.confidence
		if (conf !== null && isWordKnown(conf, cell.timesTested)) continue
		n++
	}
	return n
}

export type BuildPracticeColumnAnalysis = {
	payload: BuildColumnFocusPayload
	/** Count of lemmas in this column with `timesTested >= 1` and not verified known. */
	testedNotMasteredCount: number
}

/**
 * First heatmap column that is not fully “conquered”, plus how many cells are already in-flight.
 */
export function analyzeBuildPracticeColumn(
	cells: VocabGraphColumnCellWithTests[],
	assumedRank: number,
	vocabSize: number,
): BuildPracticeColumnAnalysis | null {
	const layout = computeHeatmapGridLayout(cells, assumedRank, vocabSize)
	if (!layout) return null
	const { visibleCells, numCols, numRows, completedCols } = layout
	if (completedCols >= numCols) return null
	const columnIndex = completedCols
	const wordIds = nonTerritoryWordIdsInColumn(visibleCells, numCols, numRows, columnIndex)
	if (wordIds.length === 0) return null
	const words = columnWordSummaries(visibleCells, numCols, numRows, columnIndex)
	const testedNotMasteredCount = countTestedNotMasteredInColumn(
		visibleCells,
		numCols,
		numRows,
		columnIndex,
	)
	return {
		payload: { columnIndex, wordIds, words },
		testedNotMasteredCount,
	}
}

/**
 * First heatmap column that is not fully “conquered”, with words still below territory confidence.
 * Matches the grid layout in `VocabGraph` so Build can prioritize the same lemmas the user sees.
 */
export function computeFirstIncompleteColumnPayload(
	cells: VocabGraphColumnCell[],
	assumedRank: number,
	vocabSize: number,
): BuildColumnFocusPayload | null {
	const layout = computeHeatmapGridLayout(cells, assumedRank, vocabSize)
	if (!layout) return null
	const { visibleCells, numCols, numRows, completedCols } = layout
	if (completedCols >= numCols) return null
	const columnIndex = completedCols
	const wordIds = nonTerritoryWordIdsInColumn(visibleCells, numCols, numRows, columnIndex)
	if (wordIds.length === 0) return null
	const words = columnWordSummaries(visibleCells, numCols, numRows, columnIndex)
	return { columnIndex, wordIds, words }
}
