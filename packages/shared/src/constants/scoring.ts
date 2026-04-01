export const MAX_VOCABULARY_SIZE = 10000

export const TYPO_THRESHOLD = {
	LIKELY_TYPO: 2,
	DEFINITE_WRONG: 3,
} as const

/**
 * Confidence thresholds for word knowledge status.
 * The authoritative KNOWN threshold is in confidence.ts (KNOWN_CONFIDENCE_THRESHOLD).
 */
export const CONFIDENCE_THRESHOLDS = {
	KNOWN: 0.95,
	LIKELY_KNOWN: 0.7,
	UNCERTAIN: 0.5,
	LIKELY_UNKNOWN: 0.3,
	UNKNOWN: 0.05,
} as const

/** @deprecated Use CONFIDENCE_THRESHOLDS instead */
export const PROBABILITY_THRESHOLDS = CONFIDENCE_THRESHOLDS
