import { prisma } from "@nwords/db"

type Kw = {
	id: string
	userId: string
	wordId: string
	confidence: number
	timesTested: number
	timesCorrect: number
	lastTestedAt: Date | null
	lastCorrect: boolean
	streak: number
}

/** Prefer the row with more test evidence; tie-break by more recent activity. */
function knowledgeRowDominates(a: Kw, b: Kw): boolean {
	if (a.timesTested !== b.timesTested) return a.timesTested > b.timesTested
	const ta = a.lastTestedAt?.getTime() ?? 0
	const tb = b.lastTestedAt?.getTime() ?? 0
	if (ta !== tb) return ta > tb
	return a.timesCorrect >= b.timesCorrect
}

/**
 * Moves learner-owned rows from an anonymous Better Auth user to a newly linked account.
 * Called from `anonymous` plugin `onLinkAccount` before the anonymous user row is removed.
 */
export async function linkAnonymousLearnerData(args: {
	anonymousUserId: string
	newUserId: string
}): Promise<void> {
	const { anonymousUserId, newUserId } = args
	if (anonymousUserId === newUserId) return

	await prisma.$transaction(async (tx) => {
		const [anonUser, newUser] = await Promise.all([
			tx.user.findUnique({
				where: { id: anonymousUserId },
				select: { nativeLanguageId: true, targetLanguageId: true },
			}),
			tx.user.findUnique({
				where: { id: newUserId },
				select: { nativeLanguageId: true, targetLanguageId: true },
			}),
		])

		if (!anonUser) return

		// Copy language pair when the permanent account has not set them yet.
		if (newUser) {
			const data: {
				nativeLanguageId?: string
				targetLanguageId?: string
			} = {}
			if (!newUser.nativeLanguageId && anonUser.nativeLanguageId) {
				data.nativeLanguageId = anonUser.nativeLanguageId
			}
			if (!newUser.targetLanguageId && anonUser.targetLanguageId) {
				data.targetLanguageId = anonUser.targetLanguageId
			}
			if (Object.keys(data).length > 0) {
				await tx.user.update({ where: { id: newUserId }, data })
			}
		}

		const [anonKnowledge, newKnowledge] = await Promise.all([
			tx.userWordKnowledge.findMany({ where: { userId: anonymousUserId } }),
			tx.userWordKnowledge.findMany({ where: { userId: newUserId } }),
		])
		const newByWordId = new Map(newKnowledge.map((r) => [r.wordId, r]))

		for (const a of anonKnowledge) {
			const n = newByWordId.get(a.wordId)
			if (!n) continue
			const anonWins = knowledgeRowDominates(a as Kw, n as Kw)
			if (anonWins) {
				await tx.userWordKnowledge.delete({ where: { id: n.id } })
				await tx.userWordKnowledge.update({
					where: { id: a.id },
					data: { userId: newUserId },
				})
				newByWordId.delete(a.wordId)
			} else {
				await tx.userWordKnowledge.delete({ where: { id: a.id } })
			}
		}

		await tx.userWordKnowledge.updateMany({
			where: { userId: anonymousUserId },
			data: { userId: newUserId },
		})

		const anonProfiles = await tx.userLanguageProfile.findMany({
			where: { userId: anonymousUserId },
		})
		for (const ap of anonProfiles) {
			const existing = await tx.userLanguageProfile.findUnique({
				where: {
					userId_languageId: { userId: newUserId, languageId: ap.languageId },
				},
			})
			if (!existing) {
				await tx.userLanguageProfile.update({
					where: { id: ap.id },
					data: { userId: newUserId },
				})
			} else {
				const assumedRank = Math.max(existing.assumedRank, ap.assumedRank)
				await tx.userLanguageProfile.update({
					where: { id: existing.id },
					data: { assumedRank },
				})
				await tx.userLanguageProfile.delete({ where: { id: ap.id } })
			}
		}

		await tx.scoreHistory.updateMany({
			where: { userId: anonymousUserId },
			data: { userId: newUserId },
		})

		await tx.testSession.updateMany({
			where: { userId: anonymousUserId },
			data: { userId: newUserId },
		})

		await tx.clozeIssueReport.updateMany({
			where: { reporterUserId: anonymousUserId },
			data: { reporterUserId: newUserId },
		})
	})
}
