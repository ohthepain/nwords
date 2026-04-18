/**
 * Build-mode vocabulary selection tuning (signed-in Build).
 * Defaults are applied when AppSettings JSON is missing keys; deployments override via admin PATCH.
 *
 * Selection uses one **active band** (heatmap-aligned column-major slice after conquered columns),
 * a **working set** (tested, not verified-known, below `confidenceCriterion`), and random **strategy**
 * percentages instead of legacy bucket/cadence weights.
 */

export type VocabBuildSettings = {
	/**
	 * Max lemmas in the active band window (column-major from first cell after conquered columns),
	 * capped within the visible heatmap slice. Main “don’t race ahead” knob.
	 */
	frontierBandMax: number
	/** Target size of the working set (tested + non-confident); intro path is favored when actual count is below this. */
	workingSetSize: number
	/**
	 * Max **intro** band lemmas (`timesTested === 0`) per New words batch when the reinforce working set is
	 * **below** `workingSetSize` (chunk dialog + column-style first pass). Does not trigger while the working
	 * set is already at target.
	 */
	newWordsIntroChunkSize: number
	/** Words with `confidence == null` or `confidence < confidenceCriterion` count as non-confident (0–1). */
	confidenceCriterion: number
	/** Random strategy: reinforce working set (0–100). Three percents must sum to 100. */
	pReinforceWorkingSet: number
	/** Random strategy: introduce unseen-in-practice (`timesTested === 0`) band lemmas (0–100). */
	pIntroduce: number
	/** Random strategy: walk / consolidate anywhere in the band except verified-known (0–100). */
	pBandWalk: number
}

export const VOCAB_BUILD_SETTINGS_DEFAULTS: VocabBuildSettings = {
	frontierBandMax: 50,
	workingSetSize: 10,
	newWordsIntroChunkSize: 5,
	confidenceCriterion: 0.85,
	pReinforceWorkingSet: 40,
	pIntroduce: 35,
	pBandWalk: 25,
}

/** Allowed ranges for admin UI and server-side clamping. */
export const VOCAB_BUILD_SETTINGS_LIMITS: {
	[K in keyof VocabBuildSettings]: { min: number; max: number }
} = {
	frontierBandMax: { min: 5, max: 200 },
	workingSetSize: { min: 1, max: 80 },
	newWordsIntroChunkSize: { min: 1, max: 40 },
	confidenceCriterion: { min: 0.5, max: 0.99 },
	pReinforceWorkingSet: { min: 0, max: 100 },
	pIntroduce: { min: 0, max: 100 },
	pBandWalk: { min: 0, max: 100 },
}

function clampKey<K extends keyof VocabBuildSettings>(key: K, v: number): number {
	const { min, max } = VOCAB_BUILD_SETTINGS_LIMITS[key]
	if (key === "confidenceCriterion") {
		return Math.min(max, Math.max(min, Math.round(v * 1000) / 1000))
	}
	return Math.round(Math.min(max, Math.max(min, v)))
}

function normalizeStrategyPercents(out: VocabBuildSettings): void {
	const r = Math.max(0, Math.min(100, Math.round(out.pReinforceWorkingSet)))
	const i = Math.max(0, Math.min(100, Math.round(out.pIntroduce)))
	const w = Math.max(0, Math.min(100, Math.round(out.pBandWalk)))
	const sum = r + i + w
	if (sum === 100) {
		out.pReinforceWorkingSet = r
		out.pIntroduce = i
		out.pBandWalk = w
		return
	}
	if (sum === 0) {
		out.pReinforceWorkingSet = VOCAB_BUILD_SETTINGS_DEFAULTS.pReinforceWorkingSet
		out.pIntroduce = VOCAB_BUILD_SETTINGS_DEFAULTS.pIntroduce
		out.pBandWalk = VOCAB_BUILD_SETTINGS_DEFAULTS.pBandWalk
		return
	}
	const nr = Math.round((r / sum) * 100)
	const ni = Math.round((i / sum) * 100)
	let nw = 100 - nr - ni
	if (nw < 0) nw = 0
	const drift = 100 - (nr + ni + nw)
	nw += drift
	out.pReinforceWorkingSet = nr
	out.pIntroduce = ni
	out.pBandWalk = nw
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
	normalizeStrategyPercents(out)
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

export function assertVocabBuildStrategyPercents(s: VocabBuildSettings): string | null {
	const sum = s.pReinforceWorkingSet + s.pIntroduce + s.pBandWalk
	if (sum !== 100) {
		return `Strategy percents must sum to 100 (got ${sum}: pReinforceWorkingSet=${s.pReinforceWorkingSet}, pIntroduce=${s.pIntroduce}, pBandWalk=${s.pBandWalk}).`
	}
	return null
}

export type BuildStrategyKind = "reinforce" | "introduce" | "band_walk"

/**
 * Roll which Build strategy runs this question. When the working set is smaller than configured,
 * intro probability is boosted by shifting mass from reinforce + band-walk (floors at 5% each).
 */
export function rollBuildStrategy(
	b: VocabBuildSettings,
	workingSetThin: boolean,
): BuildStrategyKind {
	let r = b.pReinforceWorkingSet
	let i = b.pIntroduce
	let w = b.pBandWalk
	if (workingSetThin) {
		const boost = Math.min(30, Math.floor((r + w) * 0.35))
		i += boost
		const takeR = Math.min(Math.floor(boost / 2), Math.max(0, r - 5))
		const takeW = boost - takeR
		r = Math.max(5, r - takeR)
		w = Math.max(5, w - takeW)
	}
	const s = r + i + w
	if (s <= 0) return "band_walk"
	const t = Math.random() * s
	if (t < r) return "reinforce"
	if (t < r + i) return "introduce"
	return "band_walk"
}
