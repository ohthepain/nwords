import { createMiddleware } from "hono/factory"
import type { AuthUser } from "./auth.ts"

type AdminEnv = {
	Variables: {
		user: AuthUser
	}
}

/**
 * Admin middleware — must be used AFTER authMiddleware.
 * Checks that the authenticated user has the ADMIN role.
 * Returns 403 if not admin.
 */
export const adminMiddleware = createMiddleware<AdminEnv>(async (c, next) => {
	const user = c.get("user")

	if (!user) {
		return c.json({ error: "Unauthorized" }, 401)
	}

	if (user.role !== "ADMIN") {
		return c.json({ error: "Forbidden — admin access required" }, 403)
	}

	await next()
})
