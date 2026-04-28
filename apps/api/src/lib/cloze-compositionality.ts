/** How tightly the lemma is bound to surrounding context in this sentence (cloze-quality job). */
export type ClozeCompositionalityTier = "A" | "B" | "C" | "D"

/**
 * Tier A — no penalty. B — mild. C — medium. D — fixed expression / heavy (0.2–0.4 range).
 * Tunable; keep in sync with the cloze-quality LLM prompt.
 */
export const CLOZE_COMPOSITIONALITY_MULTIPLIER: Record<ClozeCompositionalityTier, number> = {
	A: 1,
	B: 0.88,
	C: 0.55,
	D: 0.3,
}

/** Same tokenization idea as sentence linking / cloze blanks (`parallel-hint`). */
const WORD_RUN = /[\p{L}\p{N}]+/gu

export function countClozeWordRuns(sentenceText: string): number {
	const m = sentenceText.match(WORD_RUN)
	return m ? m.length : 0
}

/** Length reference (runs around this count get full multiplier; longer sentences score lower). */
const CLOZE_LENGTH_IDEAL_WORD_RUNS = 9
/** How strongly extra words penalize priority (tunable). */
const CLOZE_LENGTH_EXCESS_COEFF = 0.045
/** Do not squeeze below this so very long sentences are still selectable. */
const CLOZE_LENGTH_MULTIPLIER_FLOOR = 0.42

/** Shorter sentences get a multiplier closer to 1; long ones trend toward ~floor. */
export function clozeLengthMultiplier(wordRunCount: number): number {
	const excess = Math.max(0, wordRunCount - CLOZE_LENGTH_IDEAL_WORD_RUNS)
	const m = 1 / (1 + excess * CLOZE_LENGTH_EXCESS_COEFF)
	return Math.max(CLOZE_LENGTH_MULTIPLIER_FLOOR, m)
}

/** 0–100 combined score for ordering / weighted random selection of clozes. */
export function computeAiClozePriority(
	usefulness: number,
	naturalness: number,
	tier: ClozeCompositionalityTier,
	sentenceText: string,
): number {
	const u = usefulness / 5
	const n = naturalness / 5
	const m = CLOZE_COMPOSITIONALITY_MULTIPLIER[tier]
	const len = clozeLengthMultiplier(countClozeWordRuns(sentenceText))
	return Math.max(0, Math.min(100, Math.round(100 * u * n * m * len)))
}
