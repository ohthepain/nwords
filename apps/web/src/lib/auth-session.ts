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
		select: { role: true },
	})
	return {
		user: session.user,
		isAdmin: dbUser?.role === "ADMIN",
	}
})
