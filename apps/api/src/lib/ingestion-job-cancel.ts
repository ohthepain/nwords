import { prisma } from "@nwords/db"

/** Used when admin starts a new full import or cancels from UI: workers should stop without marking COMPLETED. */
export async function isIngestionJobCancelled(jobId: string): Promise<boolean> {
	const row = await prisma.ingestionJob.findUnique({
		where: { id: jobId },
		select: { status: true },
	})
	return row?.status === "CANCELLED"
}

/** Only moves PENDING → RUNNING so a superseding cancel cannot be overwritten by a late worker start. */
export async function tryMarkIngestionJobRunning(jobId: string): Promise<boolean> {
	const result = await prisma.ingestionJob.updateMany({
		where: { id: jobId, status: "PENDING" },
		data: { status: "RUNNING", startedAt: new Date() },
	})
	return result.count > 0
}
