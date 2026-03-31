import { prisma } from "@nwords/db"

/**
 * Workers should stop early when the job row is no longer active: explicit cancel, or operator
 * “skip” that marked the row COMPLETED while the worker was still running.
 */
export async function isIngestionJobCancelled(jobId: string): Promise<boolean> {
	const row = await prisma.ingestionJob.findUnique({
		where: { id: jobId },
		select: { status: true },
	})
	return row?.status === "CANCELLED" || row?.status === "COMPLETED"
}

/** Only moves PENDING → RUNNING so a superseding cancel cannot be overwritten by a late worker start. */
export async function tryMarkIngestionJobRunning(jobId: string): Promise<boolean> {
	const result = await prisma.ingestionJob.updateMany({
		where: { id: jobId, status: "PENDING" },
		data: { status: "RUNNING", startedAt: new Date() },
	})
	return result.count > 0
}
