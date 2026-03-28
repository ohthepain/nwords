export const MAX_VOCABULARY_SIZE = 10000

export const RETEST_INTERVAL = {
	MIN: 2,
	MAX: 20,
} as const

export function getRetestDistance(probability: number): number {
	const normalized = Math.max(0, Math.min(1, probability))
	return Math.round(RETEST_INTERVAL.MIN + normalized * (RETEST_INTERVAL.MAX - RETEST_INTERVAL.MIN))
}

export const TYPO_THRESHOLD = {
	LIKELY_TYPO: 2,
	DEFINITE_WRONG: 3,
} as const

export const PROBABILITY_THRESHOLDS = {
	KNOWN: 0.95,
	LIKELY_KNOWN: 0.7,
	UNCERTAIN: 0.5,
	LIKELY_UNKNOWN: 0.3,
	UNKNOWN: 0.05,
} as const
