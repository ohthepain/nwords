import { isWordKnown } from "./constants/confidence"
import { completedConqueredColsFromLeft, computeHeatmapGridMetrics } from "./vocab-heatmap-layout"

export type BuildModeActiveBandRow = {
	wordId: string
	effectiveRank: number
	/** From `UserWordKnowledge` when present; otherwise null. */
	confidence: number | null
	timesTested: number
}

/**
 * Heatmap-aligned active band: visible slice (through `displayCount`), then column-major window
 * starting at the first column after conquered territory, at most `frontierBandMax` lemmas.
 *
 * `knowledgeByWordId` should include every word in `graphRows.slice(0, displayCount)` for stable
 * territory geometry (same synthetic fill as GET /progress/heatmap when a row is missing).
 */
export function computeBuildModeActiveBandRows(args: {
	graphRows: readonly { id: string; effectiveRank: number }[]
	assumedRank: number
	vocabSize: number
	frontierBandMax: number
	knowledgeByWordId: ReadonlyMap<string, { confidence: number | null; timesTested: number }>
}): BuildModeActiveBandRow[] | null {
	const { graphRows, assumedRank, vocabSize, frontierBandMax, knowledgeByWordId } = args
	const metrics = computeHeatmapGridMetrics(graphRows.length, assumedRank, vocabSize)
	if (!metrics) return null
	const vis = graphRows.slice(0, metrics.displayCount)
	const forTerritory = vis.map((row) => {
		const k = knowledgeByWordId.get(row.id)
		const confidence =
			k !== undefined ? k.confidence : row.effectiveRank <= assumedRank ? 1.0 : null
		return { id: row.id, effectiveRank: row.effectiveRank, confidence }
	})
	const completed = completedConqueredColsFromLeft(
		forTerritory,
		metrics.numCols,
		metrics.numRows,
		assumedRank,
	)
	const start = completed * metrics.numRows
	const cap = Math.max(0, frontierBandMax)
	const out: BuildModeActiveBandRow[] = []
	for (let idx = start; idx < vis.length && out.length < cap; idx++) {
		const row = vis[idx]
		const k = knowledgeByWordId.get(row.id)
		out.push({
			wordId: row.id,
			effectiveRank: row.effectiveRank,
			confidence: k?.confidence ?? null,
			timesTested: k?.timesTested ?? 0,
		})
	}
	return out
}

export function isVerifiedKnownInBand(confidence: number | null, timesTested: number): boolean {
	if (confidence === null) return false
	return isWordKnown(confidence, timesTested)
}

/** Tested at least once, not verified-known, and below confidence bar (null counts as below). */
export function isWorkingSetMember(
	row: Pick<BuildModeActiveBandRow, "confidence" | "timesTested">,
	confidenceCriterion: number,
): boolean {
	if (row.timesTested <= 0) return false
	if (isVerifiedKnownInBand(row.confidence, row.timesTested)) return false
	return row.confidence === null || row.confidence < confidenceCriterion
}

export function isIntroCandidate(row: Pick<BuildModeActiveBandRow, "timesTested">): boolean {
	return row.timesTested === 0
}
