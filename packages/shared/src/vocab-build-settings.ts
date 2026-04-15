/**
 * Build-mode vocabulary selection tuning (signed-in Build).
 * Defaults match historical `test.ts` constants; deployments can override via AppSettings JSON.
 */

export type VocabBuildSettings = {
	/** Percent roll for the “new” (frontier) bucket when mood is eligible; 0–100. */
	weightNew: number
	/** Percent roll for the shaky bucket when mood is eligible; 0–100. */
	weightShaky: number
	/** Consecutive wrong answers in the session before mood bucket is eligible. */
	moodMinStreakWrong: number
	/** Max candidate ids considered for shaky / mood bucket sampling. */
	candidateCap: number
	/** Max lemmas in the frontier introduction queue (rank > assumed, no row). */
	frontierBandMax: number
	/** Spread for session de-duplication when picking from ordered id lists. */
	sessionExclusionSpread: number
	/** Spread cap for new/shaky bucket picks near the head of the rank queue. */
	newSpread: number
	/** Questions 2..N use territory opening (active-first unverified pool). */
	territoryOpening: number
	/** After opening, every Nth question is a territory revisit. */
	territoryRevisitEvery: number
	/** Spread for territory revisit sampling near the head. */
	territoryHeadSpread: number
	/** Opening de-emphasizes words with at least this many misses (timesTested − timesCorrect). */
	heavyMissThreshold: number
}

export const VOCAB_BUILD_SETTINGS_DEFAULTS: VocabBuildSettings = {
	weightNew: 48,
	weightShaky: 37,
	moodMinStreakWrong: 2,
	candidateCap: 45,
	frontierBandMax: 50,
	sessionExclusionSpread: 28,
	newSpread: 6,
	territoryOpening: 5,
	territoryRevisitEvery: 4,
	territoryHeadSpread: 5,
	heavyMissThreshold: 8,
}

/** Allowed ranges for admin UI and server-side clamping. */
export const VOCAB_BUILD_SETTINGS_LIMITS: {
	[K in keyof VocabBuildSettings]: { min: number; max: number }
} = {
	weightNew: { min: 0, max: 100 },
	weightShaky: { min: 0, max: 100 },
	moodMinStreakWrong: { min: 1, max: 20 },
	candidateCap: { min: 5, max: 200 },
	frontierBandMax: { min: 5, max: 200 },
	sessionExclusionSpread: { min: 3, max: 100 },
	newSpread: { min: 1, max: 50 },
	/** 0 disables territory opening; otherwise questions 2..N use it. */
	territoryOpening: { min: 0, max: 50 },
	/** 0 disables territory revisit cadence. */
	territoryRevisitEvery: { min: 0, max: 30 },
	territoryHeadSpread: { min: 1, max: 50 },
	heavyMissThreshold: { min: 1, max: 50 },
}

function clampKey<K extends keyof VocabBuildSettings>(key: K, v: number): number {
	const { min, max } = VOCAB_BUILD_SETTINGS_LIMITS[key]
	return Math.round(Math.min(max, Math.max(min, v)))
}

/** Merge stored JSON with defaults and clamp every field to safe ranges. */
export function mergeVocabBuildSettings(raw: unknown): VocabBuildSettings {
	const out: VocabBuildSettings = { ...VOCAB_BUILD_SETTINGS_DEFAULTS }
	if (typeof raw !== "object" || raw === null) return out
	const o = raw as Record<string, unknown>
	for (const key of Object.keys(VOCAB_BUILD_SETTINGS_DEFAULTS) as (keyof VocabBuildSettings)[]) {
		const v = o[key as string]
		if (typeof v !== "number" || !Number.isFinite(v)) continue
		out[key] = clampKey(key, v)
	}
	return out
}

/** Apply a partial patch onto an already-merged settings object, then re-clamp. */
export function applyVocabBuildSettingsPatch(
	base: VocabBuildSettings,
	patch: Partial<VocabBuildSettings>,
): VocabBuildSettings {
	const merged = { ...base, ...patch }
	return mergeVocabBuildSettings(merged)
}

export function assertVocabBuildWeightsAllowMood(s: VocabBuildSettings): string | null {
	if (s.weightNew + s.weightShaky > 100) {
		return `weightNew (${s.weightNew}) + weightShaky (${s.weightShaky}) must be at most 100 so the mood bucket has a non-negative share when eligible.`
	}
	return null
}
