/**
 * Serialize metadata read-merge-write for a single ingestion job so concurrent
 * `appendJobLog` + `updateIngestionProgress` cannot clobber each other's JSON.
 */

function createPerJobChain() {
	let chain: Promise<unknown> = Promise.resolve()
	return (fn: () => Promise<void>): Promise<void> => {
		const run = chain.then(() => fn(), () => fn())
		chain = run
		return run
	}
}

const jobChains = new Map<string, ReturnType<typeof createPerJobChain>>()

function getJobChain(jobId: string): ReturnType<typeof createPerJobChain> {
	let ch = jobChains.get(jobId)
	if (!ch) {
		ch = createPerJobChain()
		jobChains.set(jobId, ch)
	}
	return ch
}

/** Run `fn` after any prior metadata work for this job finishes (FIFO per job id). */
export function runIngestJobMetaSerial(jobId: string, fn: () => Promise<void>): Promise<void> {
	return getJobChain(jobId)(fn)
}
