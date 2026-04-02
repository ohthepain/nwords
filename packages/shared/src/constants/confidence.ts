/**
 * Confidence calculation formulas for vocabulary knowledge.
 *
 * Three modes with distinct formulas:
 * - Assessment: binary (1.0 correct, 0.0 wrong) — measurement, not learning
 * - Build: standard learning with time bonus/penalty — the main study mode
 * - Frustration: dampened correct (0.5x), harsh wrong — for stubborn words
 *
 * All formulas share the property that early tests cause large confidence
 * swings (low timesTested) while established words are resilient (high
 * timesTested). Wrong answers are punished more if the word is stale
 * (long time since last test).
 *
 * Every correct answer guarantees a minimum confidence bump of MIN_CONFIDENCE_BUMP
 * so no word is ever permanently stuck.
 */

export type VocabMode = "ASSESSMENT" | "BUILD" | "FRUSTRATION"

export interface ConfidenceInput {
	/** Current confidence 0–1 */
	confidence: number
	/** Total times tested before this answer */
	timesTested: number
	/** Timestamp of most recent prior test, or null if first test */
	lastTestedAt: Date | null
	/** Current consecutive-correct streak before this answer */
	streak: number
	/** Override "now" for testability */
	now?: Date
}

export interface ConfidenceResult {
	/** New confidence value, clamped to [0, 1] */
	confidence: number
	/** Updated streak: incremented on correct, reset to 0 on wrong */
	streak: number
	/** Whether this answer was correct */
	lastCorrect: boolean
}

/** Minimum confidence increase on any correct answer (Build & Frustration; Assessment binary). */
export const MIN_CONFIDENCE_BUMP = 0.2

/** Minimum timesTested to qualify as a "frustration word". */
export const FRUSTRATION_WORD_MIN_TESTS = 5

/** Threshold for "known": confidence >= this AND timesTested >= KNOWN_MIN_TESTS */
export const KNOWN_CONFIDENCE_THRESHOLD = 0.95

/** Minimum tests before a word can be considered "known". */
export const KNOWN_MIN_TESTS = 3

// ─── Helpers ───────────────────────────────────────────────

function daysSinceLastTest(lastTestedAt: Date | null, now: Date): number {
	if (!lastTestedAt) return 0
	const ms = now.getTime() - lastTestedAt.getTime()
	return Math.max(0, ms / (1000 * 60 * 60 * 24))
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

// ─── Build Mode ────────────────────────────────────────────

function buildCorrect(input: ConfidenceInput): number {
	const now = input.now ?? new Date()
	const days = daysSinceLastTest(input.lastTestedAt, now)

	const gain = 1 / (input.timesTested + 1)
	const timeBonus = Math.min(days / 30, 1.0) * 0.5
	const adjustedGain = gain + timeBonus

	const raw = input.confidence + (1.0 - input.confidence) * adjustedGain
	// Guarantee minimum bump
	const withMinBump = Math.max(raw, input.confidence + MIN_CONFIDENCE_BUMP)
	return clamp(withMinBump, 0, 1)
}

function buildWrong(input: ConfidenceInput): number {
	const now = input.now ?? new Date()
	const days = daysSinceLastTest(input.lastTestedAt, now)

	const penalty = 1 / (input.timesTested + 1)
	const timeFactor = Math.min(days / 30, 1.0)
	const adjustedPenalty = penalty * (1.0 + timeFactor)

	return clamp(input.confidence * (1.0 - adjustedPenalty), 0, 1)
}

// ─── Assessment Mode ───────────────────────────────────────

function assessmentCorrect(_input: ConfidenceInput): number {
	return 1.0
}

function assessmentWrong(_input: ConfidenceInput): number {
	return 0.0
}

// ─── Frustration Mode ──────────────────────────────────────

function frustrationCorrect(input: ConfidenceInput): number {
	const gain = 1 / (input.timesTested + 1)
	const raw = input.confidence + (1.0 - input.confidence) * gain * 0.5
	// Guarantee minimum bump
	const withMinBump = Math.max(raw, input.confidence + MIN_CONFIDENCE_BUMP)
	return clamp(withMinBump, 0, 1)
}

// Frustration wrong is the same as Build wrong — no mercy.
const frustrationWrong = buildWrong

// ─── Dispatcher ────────────────────────────────────────────

/**
 * Calculate updated confidence and streak after an answer.
 */
export function updateConfidence(
	mode: VocabMode,
	correct: boolean,
	input: ConfidenceInput,
): ConfidenceResult {
	let newConfidence: number

	switch (mode) {
		case "ASSESSMENT":
			newConfidence = correct ? assessmentCorrect(input) : assessmentWrong(input)
			break
		case "BUILD":
			newConfidence = correct ? buildCorrect(input) : buildWrong(input)
			break
		case "FRUSTRATION":
			newConfidence = correct ? frustrationCorrect(input) : frustrationWrong(input)
			break
	}

	return {
		confidence: newConfidence,
		streak: correct ? input.streak + 1 : 0,
		lastCorrect: correct,
	}
}

/**
 * Whether a word counts as "known" for vocabulary size calculation.
 */
export function isWordKnown(confidence: number, timesTested: number): boolean {
	return confidence >= KNOWN_CONFIDENCE_THRESHOLD && timesTested >= KNOWN_MIN_TESTS
}
