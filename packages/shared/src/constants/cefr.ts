export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const
export type CefrLevel = (typeof CEFR_LEVELS)[number]

export const CEFR_WORD_RANGES: Record<CefrLevel, { min: number; max: number }> = {
	A1: { min: 0, max: 500 },
	A2: { min: 501, max: 1000 },
	B1: { min: 1001, max: 2000 },
	B2: { min: 2001, max: 4000 },
	C1: { min: 4001, max: 8000 },
	C2: { min: 8001, max: 10000 },
}

export function getCefrLevel(vocabularySize: number): CefrLevel {
	if (vocabularySize <= 500) return "A1"
	if (vocabularySize <= 1000) return "A2"
	if (vocabularySize <= 2000) return "B1"
	if (vocabularySize <= 4000) return "B2"
	if (vocabularySize <= 8000) return "C1"
	return "C2"
}

export const CEFR_DESCRIPTIONS: Record<CefrLevel, string> = {
	A1: "Beginner",
	A2: "Elementary",
	B1: "Intermediate",
	B2: "Upper Intermediate",
	C1: "Advanced",
	C2: "Proficient",
}
