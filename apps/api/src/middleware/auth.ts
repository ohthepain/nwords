import type { Context, Next } from "hono"
import { createMiddleware } from "hono/factory"
import { auth } from "@nwords/auth/server"

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
 */
export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers })

	if (!session?.user) {
		return c.json({ error: "Unauthorized" }, 401)
	}

	c.set("user", {
		id: session.user.id,
		name: session.user.name,
		email: session.user.email,
		role: (session.user as unknown as { role?: string }).role ?? "USER",
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
			c.set("user", {
				id: session.user.id,
				name: session.user.name,
				email: session.user.email,
				role: (session.user as unknown as { role?: string }).role ?? "USER",
			})
		}
	} catch {
		// No session, that's fine
	}
	await next()
})
