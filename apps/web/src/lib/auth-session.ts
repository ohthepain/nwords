import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
	const request = getRequest()
	if (!request) return null
	const session = await auth.api.getSession({ headers: request.headers })
	return session
})

/** Session plus role for authenticated layout (header, user menu). */
export const getAuthedLayoutData = createServerFn({ method: "GET" }).handler(async () => {
	const request = getRequest()
	if (!request) return null
	const session = await auth.api.getSession({ headers: request.headers })
	if (!session?.user?.id) return null
	const dbUser = await prisma.user.findUnique({
		where: { id: session.user.id },
		select: {
			role: true,
			isAnonymous: true,
			nativeLanguage: { select: { id: true, code: true, name: true } },
			targetLanguage: { select: { id: true, code: true, name: true } },
			languageProfiles: { select: { languageId: true, assumedRank: true } },
		},
	})
	return {
		user: session.user,
		isAdmin: dbUser?.role === "ADMIN",
		isAnonymous: dbUser?.isAnonymous ?? false,
		nativeLanguage: dbUser?.nativeLanguage ?? null,
		targetLanguage: dbUser?.targetLanguage ?? null,
		languageProfiles: dbUser?.languageProfiles ?? [],
	}
})
