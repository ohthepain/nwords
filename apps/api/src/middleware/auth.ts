import { auth } from "@nwords/auth/server"
import { prisma } from "@nwords/db"
import { createMiddleware } from "hono/factory"

export type AuthUser = {
	id: string
	name: string
	email: string
	role: string
}

type AuthEnv = {
	Variables: {
		user: AuthUser
	}
}

/**
 * Auth middleware — validates the session from the request headers.
 * Sets `c.get("user")` with the authenticated user.
 * Returns 401 if no valid session.
 *
 * Role comes from the database: better-auth session payloads do not include our Prisma `User.role`,
 * so admin routes would otherwise see everyone as USER and return 403.
 */
export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers })

	if (!session?.user) {
		return c.json({ error: "Unauthorized" }, 401)
	}

	const dbUser = await prisma.user.findUnique({
		where: { id: session.user.id },
		select: { role: true },
	})

	c.set("user", {
		id: session.user.id,
		name: session.user.name,
		email: session.user.email,
		role: dbUser?.role ?? "USER",
	})

	await next()
})

/**
 * Optional auth — sets user if present, but doesn't block.
 */
export const optionalAuth = createMiddleware<AuthEnv>(async (c, next) => {
	try {
		const session = await auth.api.getSession({ headers: c.req.raw.headers })
		if (session?.user) {
			const dbUser = await prisma.user.findUnique({
				where: { id: session.user.id },
				select: { role: true },
			})
			c.set("user", {
				id: session.user.id,
				name: session.user.name,
				email: session.user.email,
				role: dbUser?.role ?? "USER",
			})
		}
	} catch {
		// No session, that's fine
	}
	await next()
})
