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

/** 0–100 combined score for ordering / weighted random selection of clozes. */
export function computeAiClozePriority(
	usefulness: number,
	naturalness: number,
	tier: ClozeCompositionalityTier,
): number {
	const u = usefulness / 5
	const n = naturalness / 5
	const m = CLOZE_COMPOSITIONALITY_MULTIPLIER[tier]
	return Math.max(0, Math.min(100, Math.round(100 * u * n * m)))
}
