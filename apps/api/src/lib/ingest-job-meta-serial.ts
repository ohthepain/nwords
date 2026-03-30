/**
 * Serialize metadata read-merge-write per ingestion job row.
 *
 * In-process chaining alone is not enough when **multiple Node processes** share the same DB
 * (e.g. `turbo dev`: API workers + Vite serving Hono via `app.fetch`) — concurrent Prisma
 * updates can clobber `metadata` and drop `jobLogLines`. We take a row lock so only one
 * updater merges at a time, across processes.
 */

import { prisma } from "@nwords/db"

export type IngestJobMetaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** Lock the job row, then run `fn` inside the same transaction (short critical section). */
export function runIngestJobMetaSerial(
	jobId: string,
	fn: (tx: IngestJobMetaTx) => Promise<void>,
): Promise<void> {
	return prisma.$transaction(async (tx) => {
		const row = await tx.$queryRaw<{ id: string }[]>`
			SELECT id FROM ingestion_job WHERE id = ${jobId}::uuid FOR UPDATE
		`
		if (row.length === 0) return
		await fn(tx)
	})
}
