/**
 * Multiple `Word` rows can share the same `effectiveRank` (e.g. same lemma, different POS).
 * Vocab graph, build mode, and admin browse treat each frequency slot once.
 */
export function dedupeByEffectiveRank<T extends { effectiveRank: number }>(rows: T[]): T[] {
	const seen = new Set<number>()
	const out: T[] = []
	for (const r of rows) {
		if (seen.has(r.effectiveRank)) continue
		seen.add(r.effectiveRank)
		out.push(r)
	}
	return out
}

/**
 * Scan rank-ordered rows until `n` distinct `effectiveRank` values are collected
 * (skips duplicate ranks without starving the list).
 */
export async function collectFirstNUniqueEffectiveRanks<
	T extends { id: string; effectiveRank: number },
>(
	n: number,
	fetchBatch: (skip: number, take: number) => Promise<T[]>,
	options?: { batchSize?: number },
): Promise<T[]> {
	if (n <= 0) return []
	const seen = new Set<number>()
	const out: T[] = []
	let skip = 0
	const batchSize = options?.batchSize ?? Math.max(200, n * 2)
	while (out.length < n) {
		const rows = await fetchBatch(skip, batchSize)
		if (rows.length === 0) break
		for (const r of rows) {
			if (seen.has(r.effectiveRank)) continue
			seen.add(r.effectiveRank)
			out.push(r)
			if (out.length >= n) break
		}
		skip += rows.length
		if (rows.length < batchSize) break
	}
	return out
}
